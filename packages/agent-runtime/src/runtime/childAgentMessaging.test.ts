import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeToolExecutor } from '@fluxos/tools/nodeToolExecutor'
import * as fileIO from '@fluxos/platform/fileIO'
import { createAgentRuntime, type AgentRuntime } from './agentRuntime'
import type { AgentTurn } from '@fluxos/contracts/agentTypes'
import type { AgentEngine } from '../agentEngine'
import type { WorkExecutionTracker } from '../workExecutionTracker'
import type { StoredChildMessage } from './childAgentMailbox'

type TestEngine = Pick<AgentEngine, 'followupChildAgent' | 'getChildAgentController'> & {
  workExecution: WorkExecutionTracker
  dispatchTool(name: string, args: Record<string, unknown>): Promise<string>
}
interface ModelInput { tool_choice?: { function?: { name?: string } } }
interface StoredRecordFixture {
  schemaVersion: number
  turns: AgentTurn[]
  messages?: StoredChildMessage[]
  inbox?: Array<{ id: string; message: string }>
}

const runtimes: AgentRuntime[] = []
const paths = new Set<string>()
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(runtimes.splice(0).map(runtime => runtime.destroy()))
  for (const path of paths) rmSync(path, { force: true, recursive: true })
  paths.clear()
})
function fixture(path = mkdtempSync(join(tmpdir(), 'tf-mailbox-'))) {
  paths.add(path)
  const runtime = createAgentRuntime({ workspacePath: path, workspaceName: 'fixture', conversationId: 'root-session',
    runtimeStoragePath: join(path, '.runtime'), connectMcp: false, approvalPolicy: 'full',
    config: { provider: 'custom', apiKey: 'fixture', baseUrl: 'http://example.test', model: 'test-model', contextWindow: 100000, maxTokens: 4096, gitEnabled: false } })
  runtimes.push(runtime)
  const engine = runtime.engine as unknown as TestEngine
  engine.workExecution.startRun('parent-run', 'Verify mailbox behavior', Date.now())
  return { runtime, engine, controller: engine.getChildAgentController()!, path }
}
function stream(reply: (input: ModelInput, signal?: AbortSignal) => string | Promise<string> = () => 'Work completed.') {
  return vi.spyOn(NodeToolExecutor.prototype, 'streamMessage').mockImplementation(async (_url, _headers, body, onLine, options) => {
    const input = JSON.parse(body)
    if (input.tool_choice?.function?.name === 'set_response_mode') {
      onLine('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'mode-' + Math.random(), type: 'function', function: { name: 'set_response_mode', arguments: '{"mode":"task"}' } }] }, finish_reason: 'tool_calls' }] }))
    } else {
      const text = await reply(input, options?.signal)
      if (options?.signal?.aborted) return { success: false, error: 'Aborted' }
      onLine('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 10 } }))
    }
    onLine('data: [DONE]')
    return { success: true, data: '' }
  })
}
async function spawn(f: ReturnType<typeof fixture>) {
  const receipt = await f.engine.dispatchTool('spawn_agent', { name: '通信验证', agent_type: 'worker', objective: 'Do the initial task' })
  return String(receipt).match(/Agent ID: ([\w-]+)/)![1]
}
async function wait(f: ReturnType<typeof fixture>, id: string) {
  await f.runtime.subAgentTaskManager.waitForTasks({ agentIds: [f.controller.get(id, 'root-session').executionId], mode: 'all', timeoutMs: 3000 })
}
async function followup(f: ReturnType<typeof fixture>, id: string, text: string) {
  const receipt = f.engine.followupChildAgent(id, text)
  const executionId = String(receipt).match(/Execution ID: ([\w-]+)/)![1]
  await f.runtime.subAgentTaskManager.waitForTasks({ agentIds: [executionId], mode: 'all', timeoutMs: 3000 })
}
function recordFile(f: ReturnType<typeof fixture>, id: string) {
  return join(f.path, '.runtime', 'child-sessions', createHash('sha256').update(id).digest('hex') + '.json')
}
function readRecord(f: ReturnType<typeof fixture>, id: string): StoredRecordFixture { return JSON.parse(readFileSync(recordFile(f, id), 'utf8')) as StoredRecordFixture }

describe('durable child message delivery', () => {
  it('keeps idle sends dormant, routes the tool idempotency key and persists receipts with the exact user turn', async () => {
    const f = fixture(); const model = stream()
    const id = await spawn(f); await wait(f, id)
    const requestsBefore = model.mock.calls.length
    const args = { agent_id: id, message: 'VERIFY_THE_OLD_ACCOUNT', message_id: 'parent-request-1' }
    const accepted = JSON.parse(await f.engine.dispatchTool('send_agent_message', args))
    expect(accepted).toMatchObject({ agentId: id, messageId: args.message_id, state: 'queued', sourceWorkRunId: 'parent-run' })
    expect(JSON.parse(await f.engine.dispatchTool('send_agent_message', args))).toEqual(accepted)
    expect(model.mock.calls).toHaveLength(requestsBefore)
    expect(() => f.controller.message(id, 'root-session', 'collision', { messageId: f.controller.get(id, 'root-session').executionId })).toThrow('existing transcript')
    expect(() => f.controller.message(id, 'another-session', 'intrusion', { messageId: args.message_id })).toThrow('not found')
    await followup(f, id, 'Continue the checks')
    const executionId = f.controller.get(id, 'root-session').executionId
    const persisted = readRecord(f, id)
    expect(persisted.schemaVersion).toBe(2)
    expect(persisted.turns.filter((turn: AgentTurn) => turn.id === args.message_id)).toHaveLength(1)
    expect(persisted.messages![0]).toMatchObject({ state: 'committed', executionId })
    expect(persisted.messages![0]).not.toHaveProperty('message')
    expect(JSON.parse(await f.engine.dispatchTool('send_agent_message', args))).toMatchObject({ state: 'committed', executionId })
    const detail = JSON.parse(await f.engine.dispatchTool('read_agent', { agent_id: id }))
    expect(detail.messages).toHaveLength(1)
    expect(detail.messages[0]).not.toHaveProperty('contentHash')
  })

  it('delivers a message once at the existing live steering boundary without claiming it was processed on acceptance', async () => {
    const f = fixture()
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const pending = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    stream(async () => { if (++calls === 1) { started(); await pending }; return 'Work completed.' })
    const id = await spawn(f); await ready
    const accepted = f.controller.message(id, 'root-session', 'NEW_SCOPE', { messageId: 'live-message' })
    expect(accepted.state).toBe('queued')
    expect(f.controller.message(id, 'root-session', 'NEW_SCOPE', { messageId: 'live-message' })).toEqual(accepted)
    release(); await wait(f, id)
    expect(calls).toBe(2)
    expect(f.controller.read(id, 'root-session').messages![0]).toMatchObject({ state: 'committed', messageId: 'live-message' })
    expect(readRecord(f, id).turns.filter((turn: AgentTurn) => turn.id === 'live-message')).toHaveLength(1)
  })

  it('keeps unconsumed guidance across cancellation and restart, then commits it on an explicit follow-up', async () => {
    const f = fixture()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const model = stream((_input, signal) => new Promise(resolve => {
      started()
      if (signal?.aborted) resolve('stopped')
      else signal?.addEventListener('abort', () => resolve('stopped'), { once: true })
    }))
    const id = await spawn(f); await ready
    f.controller.message(id, 'root-session', 'RETAIN_AFTER_CANCEL', { messageId: 'cancel-message' })
    await f.engine.dispatchTool('cancel_agent', { agent_id: id })
    expect(f.controller.read(id, 'root-session').messages![0].state).toBe('queued')
    await f.runtime.destroy()
    model.mockRestore(); const resumedModel = stream()
    const restored = fixture(f.path)
    expect(resumedModel).not.toHaveBeenCalled()
    expect(restored.controller.read(id, 'root-session').messages![0].state).toBe('queued')
    await followup(restored, id, 'Continue explicitly')
    expect(readRecord(restored, id).turns.filter((turn: AgentTurn) => turn.id === 'cancel-message')).toHaveLength(1)
    expect(restored.controller.read(id, 'root-session').messages![0].state).toBe('committed')
  })

  it('repairs a stale queued receipt from durable context after a crash and does not redeliver it', async () => {
    const f = fixture(); stream()
    const id = await spawn(f); await wait(f, id)
    f.controller.message(id, 'root-session', 'ONCE_ONLY', { messageId: 'crash-message' })
    await followup(f, id, 'Consume the guidance')
    await f.runtime.destroy()
    const record = readRecord(f, id)
    record.messages![0] = { ...record.messages![0]!, state: 'queued', message: 'ONCE_ONLY' }
    delete record.messages![0].committedAt; delete record.messages![0].executionId
    writeFileSync(recordFile(f, id), JSON.stringify(record))
    const restored = fixture(f.path)
    expect(restored.controller.read(id, 'root-session').messages![0].state).toBe('committed')
    await followup(restored, id, 'Another task')
    expect(readRecord(restored, id).turns.filter((turn: AgentTurn) => turn.id === 'crash-message')).toHaveLength(1)
  })

  it('cancels a newly admitted follow-up by stable identity before the runtime updates its snapshot', async () => {
    const f = fixture(); const model = stream()
    const id = await spawn(f); await wait(f, id)
    const previous = f.controller.get(id, 'root-session').executionId
    const before = model.mock.calls.length
    const receipt = f.engine.followupChildAgent(id, 'Cancel before starting')
    const next = String(receipt).match(/Execution ID: ([\w-]+)/)![1]
    expect(f.controller.get(id, 'root-session').executionId).toBe(previous)
    await f.engine.dispatchTool('cancel_agent', { agent_id: id })
    expect(f.runtime.subAgentTaskManager.getTask(previous)?.runtimeTask.status).toBe('completed')
    expect(f.runtime.subAgentTaskManager.getTask(next)?.runtimeTask.status).toBe('stopped')
    expect(model.mock.calls).toHaveLength(before)
  })

  it('does not return acceptance or retain an in-memory dedup key when the durable enqueue fails', async () => {
    const f = fixture(); stream()
    const id = await spawn(f); await wait(f, id)
    const write = vi.spyOn(fileIO, 'writeFileAtomicSync').mockImplementationOnce(() => { throw new Error('Disk unavailable') })
    expect(() => f.controller.message(id, 'root-session', 'persist me', { messageId: 'disk-message' })).toThrow('Disk unavailable')
    expect(f.controller.read(id, 'root-session').messages).toEqual([])
    write.mockRestore()
    expect(f.controller.message(id, 'root-session', 'persist me', { messageId: 'disk-message' }).state).toBe('queued')
    expect(readRecord(f, id).messages).toHaveLength(1)
  })
})
