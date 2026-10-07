import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_PERMISSIONS, type PluginManifest, type PluginPermission } from '@fluxos/contracts/pluginTypes'
import { assertApprovedPluginPermissions } from './pluginManifestValidation'

interface PendingInvocation {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export interface PluginHostOptions {
  manifest: PluginManifest
  conversationId: string
  pluginDirectory: string
  workspacePath: string
  storagePath: string
  approvedPermissions: PluginPermission[]
  onCrash?(message: string): void
}

const SUPPORTED_CODE_PERMISSIONS = new Set<PluginPermission>(PLUGIN_PERMISSIONS)

export function codePluginHostUnavailableReason(options: {
  platform?: NodeJS.Platform
  sandboxExecAvailable?: boolean
  allowedNodeEnvironmentFlags?: { has(value: string): boolean }
} = {}): string | undefined {
  const platform = options.platform || process.platform
  if (platform !== 'darwin') return `Code plugins are unavailable on ${platform}; only declarative plugins are supported`
  const sandboxExecAvailable = options.sandboxExecAvailable ?? existsSync('/usr/bin/sandbox-exec')
  if (!sandboxExecAvailable) return 'Code plugins require the macOS sandbox host, but sandbox-exec is unavailable'
  const flags = options.allowedNodeEnvironmentFlags || process.allowedNodeEnvironmentFlags
  if (!flags.has('--permission') || !flags.has('--allow-fs-read')) return 'This Node runtime cannot enforce plugin filesystem permissions'
  return undefined
}

export function unsupportedCodePermissions(permissions: PluginPermission[] = []): PluginPermission[] {
  return permissions.filter(permission => !SUPPORTED_CODE_PERMISSIONS.has(permission))
}

export class PluginHostProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<string, PendingInvocation>()
  private readyPromise: Promise<void> | null = null
  private exitPromise: Promise<void> | null = null
  private failure: Error | null = null
  private stopped = false

  constructor(private readonly options: PluginHostOptions) {}

  async start(): Promise<void> {
    // Only an explicit start may revive a revoked or failed host, after exit.
    if (this.stopped && this.child) await this.exitPromise
    if (this.readyPromise) return this.readyPromise
    assertApprovedPluginPermissions(this.options.manifest, this.options.approvedPermissions)
    this.stopped = false
    this.failure = null
    const manifestMain = this.options.manifest.main
    if (!manifestMain) return
    const unsupported = unsupportedCodePermissions(this.options.manifest.permissions)
    if (unsupported.length > 0) throw new Error(`Code activation is blocked because these permissions are not implemented: ${unsupported.join(', ')}`)
    const unavailableReason = codePluginHostUnavailableReason()
    if (unavailableReason) throw new Error(unavailableReason)
    const pluginDirectory = realpathSync(resolve(this.options.pluginDirectory))
    const mainPath = resolve(pluginDirectory, manifestMain)
    const runnerPath = realpathSync(fileURLToPath(new URL('./pluginHostChild.mjs', import.meta.url)))
    const approved = new Set(this.options.approvedPermissions)
    const readPaths = [runnerPath, pluginDirectory]
    const workspacePath = realpathSync(resolve(this.options.workspacePath))
    let storagePath = resolve(this.options.storagePath)
    let storageFilePath: string | undefined
    if (approved.has('filesystem.read') || approved.has('filesystem.write')) readPaths.push(workspacePath)
    if (approved.has('storage')) {
      mkdirSync(storagePath, { recursive: true, mode: 0o700 })
      storagePath = realpathSync(storagePath)
      storageFilePath = join(storagePath, 'storage.json')
      readPaths.push(storagePath, storageFilePath)
    }
    const nodeArgs = ['--permission', ...readPaths.map(path => `--allow-fs-read=${path}`)]
    const writePaths: string[] = []
    if (approved.has('filesystem.write')) writePaths.push(workspacePath)
    if (approved.has('storage')) writePaths.push(storagePath, storageFilePath!)
    nodeArgs.push(...writePaths.map(path => `--allow-fs-write=${path}`))
    if (approved.has('network')) {
      if (!process.allowedNodeEnvironmentFlags.has('--allow-net')) throw new Error('This Node runtime cannot enforce plugin network permissions')
      nodeArgs.push('--allow-net')
    }
    nodeArgs.push(runnerPath, this.options.manifest.id, this.options.conversationId, pluginDirectory, mainPath, workspacePath, storagePath, JSON.stringify([...approved]), JSON.stringify(this.options.manifest))
    const sandboxProfile = approved.has('network') ? '(version 1)\n(allow default)' : '(version 1)\n(allow default)\n(deny network*)'
    const environment: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) if (process.env[key]) environment[key] = process.env[key]
    if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn('/usr/bin/sandbox-exec', ['-p', sandboxProfile, process.execPath, ...nodeArgs], {
      cwd: pluginDirectory,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.exitPromise = new Promise(resolveExit => child.once('close', resolveExit))
    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      let settled = false
      const succeed = () => { if (settled) return; settled = true; clearTimeout(timer); resolveReady() }
      const fail = (error: Error) => { if (settled) return; settled = true; this.stopped = true; clearTimeout(timer); child.kill('SIGKILL'); rejectReady(error) }
      const timer = setTimeout(() => fail(new Error('Plugin activation timed out')), 8_000)
      let buffer = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        buffer += chunk
        if (buffer.length > 2 * 1024 * 1024) return child.kill('SIGKILL')
        let boundary = buffer.indexOf('\n')
        while (boundary >= 0) {
          const line = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 1)
          this.handleMessage(line, message => {
            if (message.type === 'ready') succeed()
            if (message.type === 'fatal') fail(new Error(String(message.error || 'Plugin activation failed')))
          })
          boundary = buffer.indexOf('\n')
        }
      })
      child.once('error', fail)
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        const message = `Plugin host exited (${signal || code || 0})`
        if (!settled) fail(new Error(message))
        const failure = this.failure
        const notifyCrash = failure !== null || !this.stopped
        this.stopped = true
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(failure || new Error(message)) }
        this.pending.clear()
        this.child = null
        this.readyPromise = null
        if (notifyCrash) this.options.onCrash?.(failure?.message || message)
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', () => {})
      child.stdin.on('error', error => this.abort(error))
    })
    return this.readyPromise
  }

  async invoke(handler: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (this.stopped) throw new Error('Plugin host is stopped; explicitly start it before invoking')
    await this.start()
    if (this.stopped) throw new Error('Plugin host is stopped; explicitly start it before invoking')
    if (!this.child) throw new Error('Plugin host is not running')
    const requestId = randomUUID()
    const payload = JSON.stringify({ type: 'invoke', requestId, handler, args })
    if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error('Plugin request exceeds 1 MB')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Reject on actual exit: a timed-out handler must not keep writing.
        this.abort(new Error(`Plugin handler timed out: ${handler}; outcome unknown`))
      }, Math.max(250, Math.min(120_000, timeoutMs)))
      this.pending.set(requestId, { resolve, reject, timer })
      this.child!.stdin.write(`${payload}\n`)
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    const child = this.child
    if (!child) {
      this.readyPromise = null
      return
    }
    await new Promise<void>((resolveStop, rejectStop) => {
      let confirmation: ReturnType<typeof setTimeout> | undefined
      const onExit = () => { clearTimeout(timer); clearTimeout(confirmation); resolveStop() }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        confirmation = setTimeout(() => {
          child.removeListener('close', onExit)
          rejectStop(new Error('Plugin host termination was not confirmed; outcome unknown'))
        }, 2_000)
      }, 2_000)
      child.once('close', onExit)
      if (child.exitCode !== null || child.signalCode !== null) void this.exitPromise?.then(onExit)
      else child.stdin.write(`${JSON.stringify({ type: 'deactivate' })}\n`, error => { if (error) child.kill('SIGKILL') })
    })
  }

  private abort(error: Error): void {
    if (!this.child || this.failure) return
    this.failure = error
    this.stopped = true
    this.child.kill('SIGKILL')
  }

  private handleMessage(line: string, lifecycle: (message: Record<string, unknown>) => void): void {
    let message: Record<string, unknown>
    try { message = JSON.parse(line) as Record<string, unknown> } catch { return }
    lifecycle(message)
    if (message.type !== 'result' || typeof message.requestId !== 'string') return
    if (this.failure) return
    const request = this.pending.get(message.requestId)
    if (!request) return
    clearTimeout(request.timer)
    this.pending.delete(message.requestId)
    if (message.ok === true) request.resolve(message.result)
    else request.reject(new Error(String(message.error || 'Plugin handler failed')))
  }
}
