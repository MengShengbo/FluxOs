import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import { createAgentRuntime, type AgentRuntime } from './agentRuntime'
import { ToolOperationStore } from '@fluxos/tools/toolOperationStore'
import { toolCallSignature } from '../toolExecutionLedger'

const roots: string[] = []
const runtimes: AgentRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) await runtime.destroy()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(root?: string) {
  if (!root) { root = mkdtempSync(join(tmpdir(), 'fluxagent-operation-')); roots.push(root) }
  const runtime = createAgentRuntime({ workspacePath: root, workspaceName: 'isolated', conversationId: 'receipt-session',
    runtimeStoragePath: join(root, 'runtime'), memoryRoot: join(root, 'memory'), connectMcp: false, approvalPolicy: 'full',
    config: { provider: 'custom', apiKey: 'fixture', baseUrl: 'http://example.test', model: 'fixture', contextWindow: 100_000, maxTokens: 4096 } })
  runtimes.push(runtime)
  const execute = (call: ToolCall, turnId = 'assistant-1') => {
    runtime.engine.getSession().turns.push({ id: turnId, role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [call] })
    return (runtime.engine as unknown as { executeSingleTool(tc: ToolCall): Promise<ToolResult> }).executeSingleTool(call)
  }
  return { runtime, root, execute }
}
const writeCall = (id = 'write-1', content = 'agent version'): ToolCall => ({ id, name: 'write_file', arguments: { path: 'target.txt', content } })

describe('durable operation recovery through the real runtime factory', () => {
  it('does not repeat a settled file write after rebuilding the runtime', async () => {
    const first = fixture()
    expect(await first.execute(writeCall())).toMatchObject({ isError: false })
    await first.runtime.destroy()
    writeFileSync(join(first.root, 'target.txt'), 'new user edit')
    const reopened = fixture(first.root)
    const write = vi.spyOn(reopened.runtime.toolExecutor, 'writeFile')
    const replay = await reopened.execute(writeCall())
    expect(write).not.toHaveBeenCalled()
    expect(replay).toMatchObject({ isError: true, recovery: { effects: 'committed', retry: 'after_inspection' } })
    expect(readFileSync(join(first.root, 'target.txt'), 'utf8')).toBe('new user edit')
  })

  it('rejects a changed payload under the same operation identity', async () => {
    const { runtime, execute, root } = fixture()
    await execute(writeCall())
    const write = vi.spyOn(runtime.toolExecutor, 'writeFile')
    expect(await execute(writeCall('write-1', 'different payload'))).toMatchObject({ isError: true })
    expect(write).not.toHaveBeenCalled()
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('agent version')
  })

  it('allows an intentional new call and a provider ID reused in a different assistant turn', async () => {
    const { execute, root } = fixture()
    await execute(writeCall())
    expect(await execute(writeCall('write-2', 'new call'))).toMatchObject({ isError: false })
    expect(await execute(writeCall('write-1', 'new turn'), 'assistant-2')).toMatchObject({ isError: false })
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('new turn')
  })

  it('does not dispatch when its intent cannot be stored', async () => {
    const { runtime, execute, root } = fixture()
    writeFileSync(join(root, 'runtime', 'tool-operations'), 'unwritable journal fixture')
    const write = vi.spyOn(runtime.toolExecutor, 'writeFile')
    expect(await execute(writeCall())).toMatchObject({ isError: true, errorKind: 'environment' })
    expect(write).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'target.txt'))).toBe(false)
  })

  it('keeps committed facts and an uncertain journal when settlement fails, then blocks reopening', async () => {
    const { runtime, execute, root } = fixture()
    const settlement = vi.spyOn(ToolOperationStore.prototype, 'settle').mockImplementationOnce(() => { throw new Error('fixture full disk') })
    const result = await execute(writeCall())
    expect(result).toMatchObject({ isError: true, changeSummary: { operation: 'write' },
      recovery: { effects: 'committed', retry: 'after_inspection' }, operation: { state: 'unsettled', persistence: 'unconfirmed' } })
    expect(result.recovery?.guidance).toContain('could not be persisted')
    settlement.mockRestore()
    await runtime.destroy()
    const reopened = fixture(root)
    const write = vi.spyOn(reopened.runtime.toolExecutor, 'writeFile')
    expect(await reopened.execute(writeCall())).toMatchObject({
      isError: true, recovery: { effects: 'unknown', retry: 'after_inspection' }, operation: { state: 'unsettled', replay: 'blocked' },
    })
    expect(write).not.toHaveBeenCalled()
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('agent version')
  })

  it('blocks an unresolved intent before dispatch and does not turn it into a successful replay', async () => {
    const { runtime, execute, root } = fixture()
    const store = new ToolOperationStore(join(root, 'runtime', 'tool-operations'))
    store.begin({ sessionId: 'receipt-session', turnId: 'assistant-1', callId: 'write-1' }, toolCallSignature(writeCall()))
    const write = vi.spyOn(runtime.toolExecutor, 'writeFile')
    expect(await execute(writeCall())).toMatchObject({ isError: true, recovery: { effects: 'unknown', retry: 'after_inspection' },
      operation: { state: 'unsettled', replay: 'blocked', persistence: 'persisted' } })
    expect(write).not.toHaveBeenCalled()
  })

  it('checks current authorization before reading an old receipt', async () => {
    const { runtime, execute } = fixture()
    await execute(writeCall())
    runtime.engine.setDisabledTools(['write_file'])
    const begin = vi.spyOn(ToolOperationStore.prototype, 'begin')
    const replay = await execute(writeCall())
    expect(replay).toMatchObject({ isError: true, errorKind: 'permission', recovery: { effects: 'none' } })
    expect(replay.operation).toBeUndefined()
    expect(begin).not.toHaveBeenCalled()
  })

  it('never claims restart protection for a call without a durable assistant identity', async () => {
    const { runtime } = fixture()
    const write = vi.spyOn(runtime.toolExecutor, 'writeFile')
    const result = await (runtime.engine as unknown as { executeSingleTool(tc: ToolCall): Promise<ToolResult> }).executeSingleTool(writeCall())
    expect(result).toMatchObject({ isError: true, errorKind: 'environment' })
    expect(write).not.toHaveBeenCalled()
  })

  it('binds operation identity before the live assistant turn is published', async () => {
    const { runtime, root } = fixture()
    let requests = 0
    vi.spyOn(runtime.toolExecutor, 'streamMessage').mockImplementation(async (url, _headers, _body, line) => {
      const first = ++requests === 1
      const event = (value: unknown) => line(`data: ${JSON.stringify(value)}`)
      if (url.endsWith('/responses')) {
        event({ type: 'response.completed', response: { output: first
          ? [{ type: 'function_call', call_id: 'provider-call', name: 'write_file', arguments: JSON.stringify(writeCall().arguments) }]
          : [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }] } })
      } else {
        event({ choices: [{ delta: first ? { tool_calls: [{ index: 0, id: 'provider-call', type: 'function', function: {
          name: 'write_file', arguments: JSON.stringify(writeCall().arguments),
        } }] } : { content: 'Done.' }, finish_reason: first ? 'tool_calls' : 'stop' }] })
        line('data: [DONE]')
      }
      return { success: true, data: '' }
    })
    const published: unknown[] = []
    const unsubscribe = runtime.engine.subscribe(event => {
      if (event.type === 'turn:complete' && event.turn.toolCalls?.length) {
        published.push(structuredClone(event.turn.toolCalls[0]!.operationIdentity))
      }
    })
    try { await runtime.engine.run('Write the exact provided fixture file once, then finish.') } finally { unsubscribe() }
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ sessionId: 'receipt-session', callId: 'provider-call' })
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('agent version')
    const result = runtime.engine.getSession().turns.flatMap(turn => turn.toolResults ?? [])[0]!
    expect(result.operation).toMatchObject({ state: 'settled', persistence: 'persisted', effects: 'committed' })
  })

  it('does not repeat a committed operation after a result observer fails', async () => {
    const { runtime, root } = fixture()
    const call = writeCall()
    runtime.engine.getSession().turns.push({ id: 'assistant-1', role: 'assistant', content: '', timestamp: 1, toolCalls: [call] })
    const execute = (runtime.engine as unknown as { executeToolCalls(calls: ToolCall[]): Promise<ToolResult[]> }).executeToolCalls.bind(runtime.engine)
    const writes = vi.spyOn(runtime.toolExecutor, 'writeFile')
    const unsubscribe = runtime.engine.subscribe(event => { if (event.type === 'tool:result') throw new Error('observer failed after settlement') })
    try { await execute([call]).catch(() => undefined) } finally { unsubscribe() }
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('agent version')
    expect(await execute([call])).toEqual([expect.objectContaining({ isError: true, operation: expect.objectContaining({ replay: 'blocked' }) })])
    expect(writes).toHaveBeenCalledOnce()
  })
})
