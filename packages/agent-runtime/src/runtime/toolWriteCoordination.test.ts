import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentTool, ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import { AgentRunControl } from './runControl'
import { ToolCallLifecycle } from './toolCallLifecycle'
import { acquireToolWrite } from './toolWriteCoordinator'
import { createAgentRunInterruption } from './runControl'
import { getToolByName } from '@fluxos/tools/toolRegistry'
import { ToolOperationStore } from '@fluxos/tools/toolOperationStore'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function workspace() { const root = mkdtempSync(join(tmpdir(), 'fluxagent-write-scope-')); roots.push(root); return root }

const writeTool: AgentTool = {
  name: 'write_file', description: 'write', category: 'write', parameters: [],
  isReadOnly: false, isDestructive: false, isConcurrencySafe: false,
  access: { source: 'builtin', exposure: 'resident', output: 'ToolResult',
    resources: [{ kind: 'filesystem', access: 'write', scope: 'workspace', argument: 'path' }] },
}
const call = (id: string): ToolCall => ({ id, name: 'write_file', arguments: { path: 'shared.txt', content: id } })
const result = (tc: ToolCall): ToolResult => ({ toolCallId: tc.id, name: tc.name, output: 'written', isError: false })
function lifecycle(execute: (tc: ToolCall) => Promise<ToolResult>) {
  const runControl = new AgentRunControl()
  runControl.start()
  return new ToolCallLifecycle({ runControl, resolveTool: () => writeTool,
    validate: () => undefined, authorize: async () => null, execute })
}

describe('cross-lifecycle write ownership', () => {
  it('admits authorized cancellation without depending on mutation journal health', async () => {
    const store = new ToolOperationStore(join(workspace(), 'unavailable'))
    const begin = vi.spyOn(store, 'begin').mockImplementation(() => { throw new Error('fixture disk full') })
    const runControl = new AgentRunControl()
    runControl.start()
    const execute = vi.fn(async (tc: ToolCall) => result(tc))
    const cancellation = new ToolCallLifecycle({ runControl, resolveTool: () => getToolByName('kill_terminal'),
      validate: () => undefined, authorize: async () => null, execute,
      operations: { store, identity: () => ({ sessionId: 'owner', turnId: 'turn', callId: 'stop' }) } })
    expect(await cancellation.execute({ id: 'stop', name: 'kill_terminal', arguments: { session_id: 'terminal' } })).toMatchObject({ isError: false })
    expect(execute).toHaveBeenCalledOnce()
    expect(begin).not.toHaveBeenCalled()
  })
  it('keeps trusted cancellation available while the target data-plane invocation owns host resources', () => {
    const command = getToolByName('run_command')!
    const release = acquireToolWrite({ id: 'running', name: 'run_command', arguments: { command: 'fixture' } }, command, { sessionId: 'owner' })!
    const controls: Array<() => void> = []
    try {
      for (const name of ['kill_terminal', 'cancel_agent', 'close_agent']) {
        const tool = getToolByName(name)!
        const call: ToolCall = { id: name, name, arguments: { session_id: 'terminal', agent_id: name } }
        const control = acquireToolWrite(call, tool, { sessionId: 'owner' })
        if (control) controls.push(control)
        expect(control, name).toBeTypeOf('function')
        expect(acquireToolWrite(call, { ...tool, access: { ...tool.access, source: 'external' } }, { sessionId: 'owner' })).toBeUndefined()
      }
    } finally { controls.forEach(control => control()); release() }
  })
  it('allows independent files but rejects normalized and symbolic aliases to the same file', () => {
    const root = workspace()
    mkdirSync(join(root, 'folder'))
    symlinkSync(join(root, 'folder'), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    const firstCall = { ...call('first'), arguments: { path: 'folder/new.txt' } }
    const release = acquireToolWrite(firstCall, writeTool, { workspacePath: root })!
    try {
      expect(acquireToolWrite({ ...call('alias'), arguments: { path: 'alias/./new.txt' } }, writeTool, { workspacePath: root })).toBeUndefined()
      const independent = acquireToolWrite({ ...call('independent'), arguments: { path: 'folder/other.txt' } }, writeTool, { workspacePath: root })
      expect(independent).toBeTypeOf('function')
      independent?.()
    } finally { release() }
  })

  it('rejects repository/file overlap including dot-prefixed children without partial ownership', () => {
    const root = workspace()
    const repository: AgentTool = { ...writeTool, name: 'git_restore', access: { ...writeTool.access,
      resources: [{ kind: 'repository', access: 'write', scope: 'workspace' }] } }
    const release = acquireToolWrite(call('repository'), repository, { workspacePath: root })!
    try {
      expect(acquireToolWrite({ ...call('file'), arguments: { path: '..ordinary-file' } }, writeTool, { workspacePath: root })).toBeUndefined()
    } finally { release() }
    const next = acquireToolWrite(call('after'), writeTool, { workspacePath: root })
    expect(next).toBeTypeOf('function')
    next?.()
  })

  it('uses a coarse domain for unknown external effects and releases it on failure', async () => {
    const failing = lifecycle(async () => { throw new Error('unknown external outcome') })
    expect(await failing.execute(call('failed'))).toMatchObject({ isError: true, recovery: { effects: 'unknown' } })
    expect(await lifecycle(async tc => result(tc)).execute(call('after'))).toMatchObject({ isError: false })
  })

  it('never dispatches pre-cancelled writers and releases ownership after cancellation', async () => {
    const controller = new AbortController()
    controller.abort(createAgentRunInterruption('stop'))
    const execute = vi.fn(async (tc: ToolCall) => result(tc))
    const rejected = lifecycle(execute)
    expect(await rejected.execute(call('before'), controller.signal)).toMatchObject({ errorKind: 'abort' })
    expect(execute).not.toHaveBeenCalled()
    const during = new AbortController()
    expect(await lifecycle(async tc => { during.abort(createAgentRunInterruption('stop')); return result(tc) }).execute(call('during'), during.signal))
      .toMatchObject({ errorKind: 'abort' })
    expect(await rejected.execute(call('after'))).toMatchObject({ isError: false })
  })

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('conservatively rejects case aliases before the file exists', () => {
    const root = workspace()
    const release = acquireToolWrite({ ...call('one'), arguments: { path: 'NEW.txt' } }, writeTool, { workspacePath: root })!
    try { expect(acquireToolWrite({ ...call('two'), arguments: { path: 'new.txt' } }, writeTool, { workspacePath: root })).toBeUndefined() }
    finally { release() }
  })
  it('rejects a competing writer before dispatch and releases ownership after settlement', async () => {
    let started!: () => void
    let release!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const first = lifecycle(async tc => { started(); await held; return result(tc) })
    const execute = vi.fn(async (tc: ToolCall) => result(tc))
    const second = lifecycle(execute)
    const pending = first.execute(call('first'))
    await ready
    try {
      expect(await second.execute(call('competing'))).toMatchObject({
        isError: true, recovery: { effects: 'none' },
      })
      expect(execute).not.toHaveBeenCalled()
    } finally {
      release()
      await pending
    }
    expect(await second.execute(call('after'))).toMatchObject({ isError: false })
    expect(execute).toHaveBeenCalledOnce()
  })
})
