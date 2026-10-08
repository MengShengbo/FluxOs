import { describe, expect, it } from 'vitest'
import type { AgentTurn, ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import { DefaultAgentStateProvider } from './runtime/stateProvider'
import { AgentContextCoordinator } from './runtime/agentContextCoordinator'
import { WorkExecutionTracker } from './workExecutionTracker'
import { TaskManager } from './taskManager'
import { collectContinuationHandoffFacts } from './contextCompaction'
import { projectChildTranscript } from '@fluxos/presentation/childTranscriptProjection'
import type { ChildTranscriptItem } from '@fluxos/contracts/childAgentTypes'

function fixture() {
  const calls: ToolCall[] = ['one', 'two'].map(turnId => ({ id: 'reused', name: 'read_file', arguments: { path: `${turnId}.ts` },
    operationIdentity: { sessionId: 'session', turnId, callId: 'reused' } }))
  const results: ToolResult[] = calls.map((call, index) => ({ toolCallId: call.id, name: call.name, output: `evidence-${index}`,
    isError: index === 1, operationIdentity: call.operationIdentity }))
  const turns: AgentTurn[] = calls.flatMap((call, index) => [
    { id: `assistant-${index}`, role: 'assistant' as const, content: '', timestamp: index * 2, toolCalls: [call] },
    { id: `result-${index}`, role: 'tool_result' as const, content: '', timestamp: index * 2 + 1, toolResults: [results[index]!] },
  ])
  return { calls, results, turns }
}
describe('operation identities at context and activity boundaries', () => {
  it('preserves the correct evidence for each file when provider IDs repeat', () => {
    const { turns } = fixture()
    const provider = new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'fixture', baseUrl: 'http://fixture.invalid', model: 'fixture', contextWindow: 100_000, maxTokens: 4096 }, '/fixture')
    expect(new AgentContextCoordinator(provider).collectPreservedFiles(turns)).toEqual([
      { path: 'one.ts', content: 'evidence-0' }, { path: 'two.ts', content: 'evidence-1' },
    ])
  })
  it('keeps the separate success and failure facts during compaction', () => {
    const { turns } = fixture()
    const facts = collectContinuationHandoffFacts(turns, [], {})
    expect(facts.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'one.ts', lastStatus: 'success' }), expect.objectContaining({ path: 'two.ts', lastStatus: 'error' }),
    ]))
  })
  it('does not overwrite earlier work activities with a later repeated provider ID', () => {
    const { calls, results } = fixture()
    const tracker = new WorkExecutionTracker('session')
    tracker.startRun('run', 'fixture')
    calls.forEach((call, index) => { tracker.startTool(call); tracker.finishTool(results[index]!) })
    const activities = Object.values(tracker.getSnapshot(new TaskManager()).runs[0]!.activities)
    expect(activities).toHaveLength(2)
    expect(activities.map(activity => activity.status)).toEqual(['completed', 'failed'])
  })
  it('joins child transcript results with the original operation in the same execution', () => {
    const { calls, results } = fixture()
    const records = calls.flatMap((call, index) => [
      { id: `call-${index}`, sequence: index * 2, executionId: 'run', timestamp: index, kind: 'tool_call', toolCall: call },
      { id: `result-${index}`, sequence: index * 2 + 1, executionId: 'run', timestamp: index, kind: 'tool_result', toolResult: results[index]! },
    ] as ChildTranscriptItem[])
    const tools = projectChildTranscript(records).flatMap(item => item.kind === 'tools' ? item.tools : [])
    expect(tools).toHaveLength(2)
    expect(tools.map(tool => tool.result?.output)).toEqual(['evidence-0', 'evidence-1'])
  })
})
