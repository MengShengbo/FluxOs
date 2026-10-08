import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { NodeToolExecutor } from './nodeToolExecutor'
import { RuntimeTaskManager } from './runtimeTaskManager'

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
async function until(check: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!check() && Date.now() < deadline) await delay(20)
  expect(check()).toBe(true)
}
async function workspace(run: (root: string) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flux-process-lifecycle-')))
  try { await run(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

describe('owned command lifecycle', () => {
  it.each(['process', 'shell', 'background', 'pipe'] as const)('rechecks task-created observer cancellation for %s before spawning', async kind => workspace(async root => {
    const manager = new RuntimeTaskManager(); const controller = new AbortController()
    manager.subscribe(event => { if ('task' in event && event.task.status === 'starting') controller.abort() })
    const executor = new NodeToolExecutor(root, { runtimeTaskManager: manager, capabilityProfile: 'danger-full-access' })
    const result = kind === 'process' ? await executor.runProcess(process.execPath, ['-e', 'process.stdout.write("must-not-run")'], root, undefined, 5000, controller.signal)
      : kind === 'shell' ? await executor.runCommand('echo must-not-run', root, undefined, 5000, true, controller.signal)
      : kind === 'background' ? await executor.startBackgroundCommand('echo must-not-run', root, undefined, true, undefined, [0], controller.signal)
      : await executor.ptyCreate({ cwd: root, signal: controller.signal })
    expect(result).toMatchObject({ success: false, errorKind: 'abort', recovery: { effects: 'none' } })
    expect(manager.listTasks()[0].pid).toBeUndefined()
  }))
  it('records a stop requested synchronously by the running-task observer as cancellation', async () => workspace(async root => {
    const manager = new RuntimeTaskManager()
    let stopped: Promise<unknown> | undefined
    manager.subscribe(event => {
      if ('task' in event && event.task.status === 'running') stopped = manager.stopTask(event.task.id)
    })
    const executor = new NodeToolExecutor(root, { runtimeTaskManager: manager })
    const result = await executor.runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], root)
    await stopped
    expect(result.data).toMatchObject({ aborted: true, termination: { status: 'confirmed' } })
    expect(manager.listTasks()[0].status).toBe('stopped')
  }))
  it('rejects pre-cancelled background and pipe terminal creation without spawning', async () => workspace(async root => {
    const executor = new NodeToolExecutor(root, { capabilityProfile: 'danger-full-access' })
    expect(await executor.startBackgroundCommand('echo must-not-run', root, undefined, true, undefined, [0], AbortSignal.abort()))
      .toMatchObject({ success: false, errorKind: 'abort', recovery: { effects: 'none' } })
    expect(await executor.ptyCreate({ cwd: root, signal: AbortSignal.abort() })).toMatchObject({ success: false, errorKind: 'abort' })
    expect(executor.getRuntimeTaskManager().listTasks()).toEqual([])
  }))
  it.each(['process', 'shell'] as const)('never spawns a pre-aborted %s invocation', async kind => workspace(async root => {
    const executor = new NodeToolExecutor(root, { capabilityProfile: 'danger-full-access' })
    const signal = AbortSignal.abort()
    const result = kind === 'process'
      ? await executor.runProcess(process.execPath, ['-e', 'process.stdout.write("must-not-run")'], root, undefined, 5000, signal)
      : await executor.runCommand('echo must-not-run', root, undefined, 5000, true, signal)
    expect(result).toMatchObject({ success: false, errorKind: 'abort', recovery: { effects: 'none' }, data: { aborted: true, stdout: '' } })
    expect(executor.getRuntimeTaskManager().listTasks()).toEqual([])
  }))

  it.each(['abort', 'timeout', 'background'] as const)('settles %s once and reaps children and grandchildren', async mode => workspace(async root => {
    const script = join(root, 'tree.cjs')
    writeFileSync(script, `const fs=require('node:fs'); const {spawn}=require('node:child_process');
const level=Number(process.argv[2]||0); const root=process.argv[3];
if(level>0)process.on('SIGTERM',()=>{});
fs.appendFileSync(root+'/pids',process.pid+'\\n');
if(level===0)fs.appendFileSync(root+'/executions','1\\n');
if(level<2)spawn(process.execPath,[__filename,String(level+1),root],{stdio:'inherit'});
process.stdout.write('level-'+level+'\\n');fs.writeFileSync(root+'/ready-'+level,'ready');setInterval(()=>{},1000);`)
    const executor = new NodeToolExecutor(root, { capabilityProfile: 'danger-full-access' })
    const controller = new AbortController()
    const pending = mode === 'background' ? undefined : executor.runProcess(process.execPath, [script, '0', root], root, undefined,
      mode === 'timeout' ? (process.platform === 'win32' ? 8000 : 1000) : 20_000, controller.signal)
    const background = mode === 'background' ? await executor.startBackgroundCommand(`node "${script}" 0 "${root}"`, root, undefined, true) : undefined
    const sessionId = background?.data?.sessionId
    let pids: number[] = []
    try {
      await until(() => existsSync(join(root, 'ready-2')), process.platform === 'win32' ? 7000 : 5000)
      pids = readFileSync(join(root, 'pids'), 'utf8').trim().split('\n').map(Number)
      if (mode === 'abort') controller.abort()
      if (mode === 'background') {
        expect(sessionId).toBeTruthy()
        const stops = await Promise.all([executor.ptyKill(sessionId!), executor.ptyKill(sessionId!)])
        expect(stops).toEqual([{ success: true }, { success: true }])
        expect((await executor.ptyGetBuffer(sessionId!)).data).toContain('level-0')
        expect(await executor.ptyKill(sessionId!)).toMatchObject({ success: true })
      } else {
        const result = await pending!
        expect(result.data?.stdout).toContain('level-0')
        expect(mode === 'abort' ? result.data?.aborted : result.data?.timedOut).toBe(true)
        expect(result.data?.termination?.status).toBe('confirmed')
        expect(result.recovery?.effects).toBe('unknown')
      }
      expect(pids.map(alive)).toEqual([false, false, false])
      expect(readFileSync(join(root, 'executions'), 'utf8')).toBe('1\n')
      expect(executor.getRuntimeTaskManager().listTasks()[0]?.status).toBe(mode === 'timeout' ? 'failed' : 'stopped')
    } finally {
      controller.abort()
      if (existsSync(join(root, 'pids'))) pids = readFileSync(join(root, 'pids'), 'utf8').trim().split('\n').map(Number)
      for (const pid of pids.reverse()) { try { process.kill(pid, 'SIGKILL') } catch {} }
      await pending
      if (sessionId) await executor.ptyKill(sessionId)
    }
  }), 15_000)
})
