import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codePluginHostUnavailableReason, PluginHostProcess } from './pluginHost'
import type { PluginPermission } from '@fluxos/contracts/pluginTypes'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function codeFixture(code: string, permissions: PluginPermission[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'fluxagent-plugin-boundary-'))
  directories.push(root)
  const pluginDirectory = join(root, 'plugin')
  const workspacePath = join(root, 'workspace')
  const storagePath = join(root, 'storage')
  mkdirSync(pluginDirectory)
  mkdirSync(workspacePath)
  writeFileSync(join(pluginDirectory, 'main.mjs'), code)
  const options = {
    manifest: { id: 'host.boundary', name: 'Boundary', description: '', version: '1.0.0', author: { name: 'Test' }, main: 'main.mjs', permissions },
    conversationId: 'boundary-conversation', pluginDirectory, workspacePath, storagePath, approvedPermissions: permissions,
  }
  return { options, host: new PluginHostProcess(options), workspacePath, storagePath }
}

describe('plugin code host availability', () => {
  it('reports unsupported platforms and missing enforcement primitives', () => {
    const allFlags = { has: () => true }
    expect(codePluginHostUnavailableReason({ platform: 'linux', sandboxExecAvailable: true, allowedNodeEnvironmentFlags: allFlags })).toContain('unavailable on linux')
    expect(codePluginHostUnavailableReason({ platform: 'darwin', sandboxExecAvailable: false, allowedNodeEnvironmentFlags: allFlags })).toContain('sandbox-exec is unavailable')
    expect(codePluginHostUnavailableReason({
      platform: 'darwin',
      sandboxExecAvailable: true,
      allowedNodeEnvironmentFlags: { has: () => false },
    })).toContain('cannot enforce plugin filesystem permissions')
    expect(codePluginHostUnavailableReason({ platform: 'darwin', sandboxExecAvailable: true, allowedNodeEnvironmentFlags: allFlags })).toBeUndefined()
  })
})

describe.skipIf(process.platform !== 'darwin')('PluginHostProcess', () => {
  it('terminates all in-flight handlers on timeout before they can write later', async () => {
    const { host, workspacePath } = codeFixture(`export function activate(context) {
      return {
        pid: () => process.pid,
        late: async () => {
          await new Promise(resolve => setTimeout(resolve, 650));
          await context.api.filesystem.writeFile('late.txt', 'unexpected');
        },
        waiting: () => new Promise(resolve => setTimeout(() => resolve('late success'), 700)),
      };
    }`, ['filesystem.write'])
    try {
      const pid = await host.invoke('pid', {}) as number
      const late = host.invoke('late', {}, 250).then(() => 'success', error => String(error))
      const waiting = host.invoke('waiting', {}, 2_000).then(() => 'success', error => String(error))
      expect(await late).toContain('timed out')
      const concurrentResult = await waiting
      await new Promise(resolve => setTimeout(resolve, 750))
      expect(existsSync(join(workspacePath, 'late.txt'))).toBe(false)
      expect(() => process.kill(pid, 0)).toThrow()
      expect(concurrentResult).toContain('timed out')
      await expect(host.invoke('pid', {})).rejects.toThrow('stopped')
    } finally { await host.stop() }
  })

  it('requires explicit start after stop, including an invocation racing with stop', async () => {
    const { host } = codeFixture('export function echo() { return "ok" }')
    try {
      await host.start()
      const stopping = host.stop()
      await expect(host.invoke('echo', {})).rejects.toThrow('stopped')
      const restarting = host.start()
      await stopping
      await restarting
      await expect(host.invoke('echo', {})).resolves.toBe('ok')
      await host.stop()
      await expect(host.invoke('echo', {})).rejects.toThrow('stopped')
      await host.start()
      await expect(host.invoke('echo', {})).resolves.toBe('ok')
    } finally { await host.stop() }
  })

  it('waits for forced termination when deactivate hangs and settles pending calls', async () => {
    const { host } = codeFixture(`export function pid() { return process.pid }
      export function waiting() { return new Promise(() => {}) }
      export function deactivate() { return new Promise(() => {}) }`)
    try {
      const pid = await host.invoke('pid', {}) as number
      const pending = host.invoke('waiting', {}).then(() => 'success', error => String(error))
      await host.stop()
      expect(await pending).toContain('Plugin host')
      expect(() => process.kill(pid, 0)).toThrow()
    } finally { await host.stop() }
  })

  it('keeps the previous storage snapshot when killed during a real write and reopens it', async () => {
    const { host, options, storagePath } = codeFixture(`export function activate(context) {
      return {
        pid: () => process.pid,
        write: () => context.api.storage.set('large', 'x'.repeat(16 * 1024 * 1024)),
        read: () => context.api.storage.get('sentinel'),
        save: () => context.api.storage.set('recovered', true),
      };
    }`, ['storage'])
    mkdirSync(storagePath)
    writeFileSync(join(storagePath, 'storage.json'), '{"sentinel":"previous"}')
    let watcher: ReturnType<typeof watch> | undefined
    const restarted = new PluginHostProcess(options)
    try {
      const pid = await host.invoke('pid', {}) as number
      const suspended = new Promise<void>((resolveSuspended, rejectSuspended) => {
        const timer = setTimeout(() => rejectSuspended(new Error('No in-progress temporary write observed')), 2_000)
        watcher = watch(storagePath, (_, filename) => {
          if (!filename?.startsWith('.storage-')) return
          watcher?.close()
          clearTimeout(timer)
          process.kill(pid, 'SIGSTOP')
          resolveSuspended()
        })
      })
      const result = host.invoke('write', {}).then(() => 'success', error => String(error))
      await suspended
      await host.stop()
      expect(await result).not.toBe('success')
      expect(JSON.parse(readFileSync(join(storagePath, 'storage.json'), 'utf8'))).toEqual({ sentinel: 'previous' })
      await expect(restarted.invoke('read', {})).resolves.toBe('previous')
      await restarted.invoke('save', {})
      expect(JSON.parse(readFileSync(join(storagePath, 'storage.json'), 'utf8'))).toEqual({ sentinel: 'previous', recovered: true })
    } finally { watcher?.close(); await host.stop(); await restarted.stop() }
  })

  it.each([
    { requested: [], approved: ['network'] },
    { requested: ['network'], approved: [] },
  ])('rejects a different approved permission set before executing code: %j', async ({ requested, approved }) => {
    const { options } = codeFixture('export function echo() { return "ok" }', requested as PluginPermission[])
    const host = new PluginHostProcess({ ...options, approvedPermissions: approved as PluginPermission[] })
    try { await expect(host.start()).rejects.toThrow('permissions') } finally { await host.stop() }
  })

  it('preserves every concurrent storage update and serves reads after preceding writes', async () => {
    const { host, storagePath } = codeFixture(`export function activate(context) {
      return {
        async batch() {
          const writes = Array.from({ length: 32 }, (_, i) => context.api.storage.set('key-' + i, i));
          const last = context.api.storage.get('key-31');
          await Promise.all(writes);
          await context.api.storage.set('__proto__', 'stored');
          return { last: await last, prototypeKey: await context.api.storage.get('__proto__') };
        },
        remove: () => context.api.storage.remove('key-0'),
        read: () => context.api.storage.get('key-1'),
      };
    }`, ['storage'])
    try {
      const result = await host.invoke('batch', {})
      const state = JSON.parse(readFileSync(join(storagePath, 'storage.json'), 'utf8'))
      expect(Object.keys(state)).toHaveLength(33)
      expect(result).toEqual({ last: 31, prototypeKey: 'stored' })
      await host.invoke('remove', {})
      expect(JSON.parse(readFileSync(join(storagePath, 'storage.json'), 'utf8'))).not.toHaveProperty('key-0')
      expect(readdirSync(storagePath)).toEqual(['storage.json'])
      writeFileSync(join(storagePath, 'storage.json'), '{bad json')
      await expect(host.invoke('read', {})).rejects.toThrow()
      expect(readFileSync(join(storagePath, 'storage.json'), 'utf8')).toBe('{bad json')
      writeFileSync(join(storagePath, 'storage.json'), '{"key-1":1}')
      await expect(host.invoke('read', {})).resolves.toBe(1)
    } finally { await host.stop() }
  })

  it('invokes a code plugin through the sandbox host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fluxagent-plugin-host-'))
    directories.push(root)
    const pluginDirectory = join(root, 'plugin')
    const workspacePath = join(root, 'workspace')
    const storagePath = join(root, 'storage')
    mkdirSync(pluginDirectory)
    mkdirSync(workspacePath)
    writeFileSync(join(pluginDirectory, 'main.mjs'), `export function activate(context) {
      return {
        echo: async args => ({
          echoed: args.value,
          conversationId: context.conversationId,
          manifestId: context.manifest.id,
          api: Object.keys(context.api).sort(),
          filesystem: Object.keys(context.api.filesystem).sort(),
        }),
      }
    }\n`)
    const host = new PluginHostProcess({
      manifest: { id: 'host.test', name: 'Host test', description: '', version: '1.0.0', author: { name: 'Test' }, main: 'main.mjs', permissions: [] },
      conversationId: 'conversation-host-test',
      pluginDirectory,
      workspacePath,
      storagePath,
      approvedPermissions: [],
    })
    await host.start()
    await expect(host.invoke('echo', { value: 'ok' })).resolves.toEqual({
      echoed: 'ok',
      conversationId: 'conversation-host-test',
      manifestId: 'host.test',
      api: ['commands', 'filesystem', 'storage', 'tools'],
      filesystem: ['delete', 'mkdir', 'readDirectory', 'readFile', 'writeFile'],
    })
    await host.stop()
  })

  it('contains a crashing plugin without terminating the parent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fluxagent-plugin-host-'))
    directories.push(root)
    const pluginDirectory = join(root, 'plugin')
    const workspacePath = join(root, 'workspace')
    mkdirSync(pluginDirectory)
    mkdirSync(workspacePath)
    writeFileSync(join(pluginDirectory, 'main.mjs'), 'export function crash() { process.exit(17) }\n')
    const host = new PluginHostProcess({
      manifest: { id: 'host.crash', name: 'Crash test', description: '', version: '1.0.0', author: { name: 'Test' }, main: 'main.mjs', permissions: [] },
      conversationId: 'conversation-host-crash',
      pluginDirectory,
      workspacePath,
      storagePath: join(root, 'storage'),
      approvedPermissions: [],
    })
    await host.start()
    await expect(host.invoke('crash', {})).rejects.toThrow('Plugin host exited')
    await host.start()
    await expect(host.invoke('crash', {})).rejects.toThrow('Plugin host exited')
    expect(process.pid).toBeGreaterThan(0)
  })

  it('blocks filesystem access through workspace symlinks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fluxagent-plugin-host-'))
    directories.push(root)
    const pluginDirectory = join(root, 'plugin')
    const workspacePath = join(root, 'workspace')
    const outsidePath = join(root, 'outside')
    mkdirSync(pluginDirectory)
    mkdirSync(workspacePath)
    mkdirSync(outsidePath)
    writeFileSync(join(outsidePath, 'secret.txt'), 'secret')
    symlinkSync(join(outsidePath, 'secret.txt'), join(workspacePath, 'secret-link'))
    symlinkSync(outsidePath, join(workspacePath, 'outside-link'))
    writeFileSync(join(pluginDirectory, 'main.mjs'), `export function activate(context) {
      return {
        readLink: () => context.api.filesystem.readFile('secret-link'),
        writeLink: () => context.api.filesystem.writeFile('outside-link/secret.txt', 'changed'),
        writeSafe: () => context.api.filesystem.writeFile('nested/result.txt', 'safe'),
      }
    }\n`)
    const host = new PluginHostProcess({
      manifest: {
        id: 'host.symlink',
        name: 'Symlink test',
        description: '',
        version: '1.0.0',
        author: { name: 'Test' },
        main: 'main.mjs',
        permissions: ['filesystem.read', 'filesystem.write'],
      },
      conversationId: 'conversation-host-symlink',
      pluginDirectory,
      workspacePath,
      storagePath: join(root, 'storage'),
      approvedPermissions: ['filesystem.read', 'filesystem.write'],
    })
    await host.start()
    await expect(host.invoke('readLink', {})).rejects.toThrow()
    await expect(host.invoke('writeLink', {})).rejects.toThrow()
    await expect(host.invoke('writeSafe', {})).resolves.toBeUndefined()
    expect(readFileSync(join(outsidePath, 'secret.txt'), 'utf8')).toBe('secret')
    expect(readFileSync(join(workspacePath, 'nested', 'result.txt'), 'utf8')).toBe('safe')
    await host.stop()
  })
})
