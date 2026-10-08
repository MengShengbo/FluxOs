import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentTurn, ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import type { AnyConversationEvent } from '@fluxos/contracts/conversationEvent'
import { createAgentRuntime, type AgentRuntime } from '@fluxos/agent-runtime/runtime/agentRuntime'
import { ConversationRuntimeRepositoryV2 } from './conversationRuntimeRepositoryV2'
import { WorkProjectionEngine } from '@fluxos/presentation/workProjection'
import { AgentSessionRehydrator } from '@fluxos/agent-runtime/runtime/agentSessionRehydrator'
import { TaskManager } from '@fluxos/agent-runtime/taskManager'
import { TranscriptIndex } from '@fluxos/presentation'
import { applyTaskFlowEvent, createTaskFlowProjection } from '@fluxos/presentation/taskFlowProjection'

const roots: string[] = []
const runtimes: AgentRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) await runtime.destroy()
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})

describe('operation identity across canonical ID normalization', () => {
  it.each(['canonical', 'live_projection', 'incremental_flow', 'transcript_index', 'rehydration'])('retains distinct repeated provider IDs on %s', async surface => {
    const root = mkdtempSync(join(tmpdir(), 'fluxagent-repeated-operation-'))
    roots.push(root)
    const runtime = createAgentRuntime({ workspacePath: root, workspaceName: 'fixture', conversationId: 'conversation',
      runtimeStoragePath: join(root, 'runtime'), memoryRoot: join(root, 'memory'), connectMcp: false, approvalPolicy: 'full',
      config: { provider: 'custom', apiKey: 'fixture', baseUrl: 'http://fixture.invalid', model: 'fixture', contextWindow: 100_000, maxTokens: 4096 } })
    runtimes.push(runtime)
    const execute = (runtime.engine as unknown as { executeSingleTool(tc: ToolCall): Promise<ToolResult> }).executeSingleTool.bind(runtime.engine)
    const context = { id: 'conversation', title: 'Fixture', createdAt: 1, updatedAt: 10, mode: 'vibe' as const, provider: 'custom', model: 'fixture' }
    const repository = new ConversationRuntimeRepositoryV2(join(root, 'canonical'), 'profile', 'workspace', root)
    const events: AnyConversationEvent[] = []
    const turns: AgentTurn[] = []
    const append = (turnId: string, type: AnyConversationEvent['type'], payload: unknown) => {
      const event = { schemaVersion: 1, eventId: `event-${events.length + 1}`, conversationId: context.id, threadId: context.id, runId: 'run', turnId,
        seq: events.length + 1, at: events.length + 1, source: 'agent', provenance: 'live', type, payload } as AnyConversationEvent
      events.push(event)
      repository.appendCanonical(event, context)
    }
    append('first', 'run.started', { objective: 'Fixture' })
    for (const id of ['first', 'second']) {
      const call: ToolCall = { id: 'provider-repeated', name: 'write_file', arguments: { path: id, content: id } }
      const turn: AgentTurn = { id, role: 'assistant', content: '', timestamp: events.length + 1, toolCalls: [call] }
      runtime.engine.getSession().turns.push(turn)
      const result = await execute(call)
      expect(result.isError).toBe(false)
      turns.push(turn, { id: `${id}-result`, role: 'tool_result', timestamp: turn.timestamp + 1, content: '', toolResults: [result] })
      append(id, 'turn.started', { turn })
      append(id, 'tool.proposed', { toolCall: call })
      append(id, 'tool.completed', { toolResult: result })
    }
    if (surface === 'canonical') {
      const loaded = repository.load(context.id)!
      expect(loaded.turns.flatMap(turn => turn.toolCalls ?? [])).toHaveLength(2)
      expect(new Set(loaded.turns.flatMap(turn => turn.toolCalls?.map(call => call.id) ?? [])).size).toBe(2)
      runtime.engine.restoreFromTurns(loaded.turns)
      for (const call of runtime.engine.getSession().turns.flatMap(turn => turn.toolCalls ?? [])) {
        expect(await execute(call)).toMatchObject({ isError: true, operation: { replay: 'blocked' } })
      }
    } else if (surface === 'live_projection') {
      const projection = new WorkProjectionEngine(context.id, context.id).replace(events)
      expect(Object.values(projection.nodes).filter(node => node.kind === 'tool')).toHaveLength(2)
    } else if (surface === 'incremental_flow') {
      const projection = events.reduce(applyTaskFlowEvent, createTaskFlowProjection(context.id))
      const tools = Object.values(projection.nodes).filter(node => node.kind === 'tool')
      expect(tools).toHaveLength(2)
      expect(tools.every(tool => tool.status === 'completed' && tool.invocationId)).toBe(true)
    } else if (surface === 'transcript_index') {
      const index = new TranscriptIndex()
      index.reset(turns)
      const projection = new WorkProjectionEngine(context.id, context.id).replace(events)
      const tools = Object.values(projection.nodes).filter(node => node.kind === 'tool')
      expect(index.calls.size).toBe(2)
      expect(index.results.size).toBe(2)
      expect(tools.map(node => index.results.get(node.invocationId!)?.changeSummary?.path)).toEqual(['first', 'second'])
    } else {
      const rehydrator = new AgentSessionRehydrator()
      const restored = rehydrator.rehydrateMessages(rehydrator.messagesFromTurns(turns), { systemTurns: [], taskManager: new TaskManager() })
      expect(new Set(restored.flatMap(turn => turn.toolResults?.map(result => result.operation?.id) ?? [])).size).toBe(2)
    }
  })
  it.each([true, false])('blocks re-execution after canonical reload with result persisted=%s', async persistResult => {
    const root = mkdtempSync(join(tmpdir(), 'fluxagent-operation-canonical-'))
    roots.push(root)
    const runtime = createAgentRuntime({ workspacePath: root, workspaceName: 'fixture', conversationId: 'conversation',
      runtimeStoragePath: join(root, 'runtime'), memoryRoot: join(root, 'memory'), connectMcp: false, approvalPolicy: 'full',
      config: { provider: 'custom', apiKey: 'fixture', baseUrl: 'http://fixture.invalid', model: 'fixture', contextWindow: 100_000, maxTokens: 4096 } })
    runtimes.push(runtime)
    const execute = (runtime.engine as unknown as { executeSingleTool(tc: ToolCall): Promise<ToolResult> }).executeSingleTool.bind(runtime.engine)
    const call: ToolCall = { id: 'provider-call', name: 'write_file', arguments: { path: 'target', content: 'agent version' } }
    const turn = { id: 'assistant-turn', role: 'assistant' as const, content: '', timestamp: 1, toolCalls: [call] }
    runtime.engine.getSession().turns.push(turn)
    const result = await execute(call)
    expect(result.isError).toBe(false)
    const storage = join(root, 'conversation-journal')
    const context = { id: 'conversation', title: 'Fixture', createdAt: 1, updatedAt: 10, mode: 'vibe' as const, provider: 'custom', model: 'fixture' }
    const repository = new ConversationRuntimeRepositoryV2(storage, 'profile', 'workspace', root)
    let seq = 0
    const append = (type: AnyConversationEvent['type'], payload: unknown) => repository.appendCanonical({ schemaVersion: 1,
      eventId: `event-${++seq}`, conversationId: context.id, threadId: context.id, runId: 'run', turnId: turn.id, seq, at: seq,
      source: 'agent', provenance: 'live', type, payload } as AnyConversationEvent, context)
    append('run.started', { objective: 'Fixture' })
    append('turn.started', { turn })
    append('tool.proposed', { toolCall: call })
    if (persistResult) append('tool.completed', { toolResult: result })
    const loaded = new ConversationRuntimeRepositoryV2(storage, 'profile', 'workspace', root).load(context.id)!
    runtime.engine.restoreFromTurns(loaded.turns)
    const restoredCall = runtime.engine.getSession().turns.flatMap(turn => turn.toolCalls ?? [])[0]!
    expect(restoredCall.id).not.toBe(call.id)
    writeFileSync(join(root, 'target'), 'user revision')
    const writes = vi.spyOn(runtime.toolExecutor, 'writeFile')
    expect(await execute(restoredCall)).toMatchObject({ isError: true, operation: { replay: 'blocked', effects: 'committed' } })
    expect(writes).not.toHaveBeenCalled()
    expect(readFileSync(join(root, 'target'), 'utf8')).toBe('user revision')
  })
})
