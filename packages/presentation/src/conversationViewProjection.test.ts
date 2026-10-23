import { describe, expect, it } from 'vitest'
import type { AgentRunState } from '@fluxos/contracts/agentTypes'
import type { CommandProcessOutcome } from '@fluxos/contracts/toolResultData'
import type { WorkRun } from '@fluxos/contracts/workExecutionTypes'
import type { AnyConversationEvent } from '@fluxos/contracts/conversationEvent'
import { createTaskFlowProjection } from './taskFlowProjection'
import { WorkProjectionEngine } from './workProjection'
import { applyConversationViewEvent, applyConversationViewEvents, applyConversationViewSnapshot, type ConversationViewState } from './conversationViewProjection'

const run: WorkRun = {
  id: 'run', conversationId: 'conversation', objective: 'Inspect', presentation: 'work', responseMode: 'task',
  status: 'running', phase: 'thinking', rootStepIds: [], steps: {}, activities: {}, startedAt: 1_000, updatedAt: 201_000,
  executionSegments: [{ startedAt: 1_000, endedAt: 8_000, outcome: 'paused' }, { startedAt: 200_000 }],
}
const initial = (): ConversationViewState => ({
  flow: createTaskFlowProjection('conversation'),
  execution: { schemaVersion: 1, currentRunId: null, runs: [] },
  runState: { phase: 'idle', updatedAt: 0 }, status: 'ready',
})
const event = (seq: number, type: AnyConversationEvent['type'], payload: unknown): AnyConversationEvent => ({
  schemaVersion: 1, eventId: `event-${seq}`, conversationId: 'conversation', threadId: 'conversation',
  runId: 'run', seq, at: 248_000, source: 'agent', provenance: 'live', type, payload,
} as AnyConversationEvent)

describe('canonical conversation view', () => {
  it('batches arbitrary events with the same lifecycle, tool identity and immutable results as serial admission', () => {
    const call = { id: 'read', name: 'read_file', arguments: { path: 'a.ts' },
      operationIdentity: { sessionId: 'conversation', turnId: 'assistant', callId: 'read' } }
    const events = [
      event(1, 'run.started', {}),
      event(2, 'stream.delta', { channel: 'answer', text: 'Inspecting ' }),
      event(3, 'stream.delta', { channel: 'answer', text: 'files' }),
      event(4, 'tool.delta', { toolCallId: call.id, toolName: call.name, partialJson: '{' }),
      event(5, 'tool.proposed', { toolCall: call }),
      event(6, 'run.state_changed', { state: { phase: 'paused', updatedAt: 6 } }),
      event(7, 'run.state_changed', { state: { phase: 'tool_running', updatedAt: 7 } }),
      event(8, 'tool.completed', { toolResult: { toolCallId: call.id, name: call.name,
        operationIdentity: call.operationIdentity, output: 'done', isError: false } }),
      event(9, 'execution.updated', { update: { currentRunId: run.id, retainedRunIds: [run.id], runs: [run], removedActivityIds: {} } }),
      event(10, 'run.completed', { outcome: 'completed' }),
    ].map(value => ({ ...value, stepId: 'step', itemId: value.type.startsWith('tool.') ? call.id : value.itemId }))
    const current = initial()
    Object.freeze(current.flow.nodes); Object.freeze(current.flow.order)
    const input = structuredClone(current)
    const expected = events.reduce(applyConversationViewEvent, current)
    const batched = applyConversationViewEvents(current, events)
    expect(batched).toEqual(expected)
    expect(current).toEqual(input)
    const committed = structuredClone(batched)
    applyConversationViewEvents(batched, [event(11, 'run.started', {}), event(12, 'tool.delta', {
      toolCallId: 'next', toolName: call.name, partialJson: '{',
    })])
    expect(batched).toEqual(committed)
  })

  it('retains sequence gaps, generation checks and duplicate filtering in a batch', () => {
    const events = [
      event(1, 'run.started', {}),
      event(3, 'run.completed', { outcome: 'failed' }),
      { ...event(2, 'run.completed', { outcome: 'failed' }), conversationId: 'other' },
      { ...event(2, 'run.completed', { outcome: 'failed' }), generation: 1 },
      event(2, 'tool.delta', { toolCallId: 'one', toolName: 'read_file', partialJson: '{' }),
      event(3, 'tool.delta', { toolCallId: 'one', toolName: 'read_file', partialJson: '{}' }),
      event(3, 'run.completed', { outcome: 'failed' }),
      event(4, 'run.completed', { outcome: 'completed' }),
    ]
    const expected = events.reduce(applyConversationViewEvent, initial())
    const batched = applyConversationViewEvents(initial(), events)
    expect(batched).toEqual(expected)
    expect(batched.status).toBe('ready')
    expect(batched.flow.lastSeq).toBe(4)
    expect(applyConversationViewEvents(batched, events)).toBe(batched)
  })

  it('copies the historical flow map a bounded number of times for a burst of deltas', () => {
    let current = applyConversationViewEvent(initial(), event(1, 'run.started', {}))
    for (let index = 0; index < 100; index += 1) {
      current = applyConversationViewEvent(current, event(index + 2, 'tool.proposed', {
        toolCall: { id: `old-${index}`, name: 'read_file', arguments: {} },
      }))
    }
    let enumerations = 0
    const original = current.flow.nodes
    const nodes = new Proxy(original, { ownKeys(target) { enumerations += 1; return Reflect.ownKeys(target) } })
    current = { ...current, flow: { ...current.flow, nodes } }
    const events = Array.from({ length: 256 }, (_, index) => ({ ...event(index + 102, 'stream.delta', {
      channel: 'answer', text: 'x',
    }), stepId: 'step' }))
    const result = applyConversationViewEvents(current, events)
    expect(result.flow.nodes['step:step:answer'].content).toHaveLength(256)
    expect(result.flow.lastSeq).toBe(357)
    // One private shallow copy and, for this uncached input, one index build.
    expect(enumerations).toBeLessThanOrEqual(2)
    expect(current.flow.nodes['step:step:answer']).toBeUndefined()
  })

  it.each([
    [{ state: 'exited', exitCode: 7 }, [0], 'failed'],
    [{ state: 'exited', exitCode: 1 }, [0, 1], 'completed'],
    [{ state: 'signaled', signal: 'SIGTERM' }, [0], 'failed'],
    [{ state: 'timed_out', exitCode: null }, [0], 'failed'],
    [{ state: 'aborted', exitCode: null }, [0], 'cancelled'],
    [{ state: 'running' }, [0], 'completed'],
  ] satisfies Array<[CommandProcessOutcome, number[], string]>)('projects and replays typed command %j in both views', (process, expectedExitCodes, status) => {
    const events = [
      event(1, 'run.started', {}),
      { ...event(2, 'tool.proposed', { toolCall: { id: 'command', name: 'run_command', arguments: {} } }), itemId: 'command' },
      { ...event(3, 'tool.completed', { toolResult: { toolCallId: 'command', name: 'run_command', output: 'captured', isError: false,
        data: { kind: 'command', stdout: '', process, expectedExitCodes } } }), itemId: 'command' },
    ]
    const live = events.reduce(applyConversationViewEvent, initial())
    const replayed = (JSON.parse(JSON.stringify(events)) as typeof events).reduce(applyConversationViewEvent, initial())
    expect(replayed).toEqual(live)
    expect(Object.values(live.flow.nodes).filter(node => node.kind === 'tool')).toEqual([
      expect.objectContaining({ status, settled: true }),
    ])
    const work = new WorkProjectionEngine('conversation')
    events.forEach(value => work.apply(value))
    expect(Object.values(work.getSnapshot().nodes).filter(node => node.kind === 'tool')).toEqual([
      expect.objectContaining({ status, settled: true }),
    ])
  })
  it('merges changed activities without dropping earlier results and applies removals', () => {
    let view = applyConversationViewEvent(initial(), event(1, 'run.started', {}))
    const activity = {id: 'old', runId: run.id, kind: 'tool' as const, title: 'read_file', status: 'completed' as const, attempt: 1, startedAt: 1, updatedAt: 2, result: 'retained result'}
    const first = {...run, activities: {old: activity}}
    view = applyConversationViewEvent(view, event(2, 'execution.updated', {update: {currentRunId: run.id, retainedRunIds: [run.id], runs: [first], removedActivityIds: {}}}))
    const next = {...run, activities: {fresh: {...activity, id: 'fresh', result: 'new result'}}}
    view = applyConversationViewEvent(view, event(3, 'execution.updated', {update: {currentRunId: run.id, retainedRunIds: [run.id], runs: [next], removedActivityIds: {}}}))
    expect(view.execution.runs[0].activities.old).toBe(activity)
    expect(view.execution.runs[0].activities.fresh.result).toBe('new result')
    view = applyConversationViewEvent(view, event(4, 'execution.updated', {update: {currentRunId: run.id, retainedRunIds: [run.id], runs: [{...run, activities: {}}], removedActivityIds: {[run.id]: ['old']}}}))
    expect(Object.keys(view.execution.runs[0].activities)).toEqual(['fresh'])
  })

  it.each(['completed', 'partial', 'failed', 'cancelled'] as const)('settles %s timing, transcript, and composer in one event', status => {
    let view = applyConversationViewEvent(initial(), event(1, 'run.started', {}))
    view = applyConversationViewEvent(view, event(2, 'execution.updated', { update: { currentRunId: run.id, retainedRunIds: [run.id], runs: [run], removedActivityIds: {} } }))
    const completed: WorkRun = { ...run, status, phase: status, updatedAt: 248_000, completedAt: 248_000, executionSegments: [run.executionSegments![0], { startedAt: 200_000, endedAt: 248_000, outcome: status === 'cancelled' ? 'stopped' : status === 'partial' ? 'interrupted' : status }] }
    const state: AgentRunState = { phase: status === 'failed' ? 'recoverable_error' : 'completed', startedAt: 1_000, updatedAt: 248_000 }
    const next = applyConversationViewEvent(view, event(3, 'run.completed', { outcome: status, run: completed, state }))
    expect(next.execution.runs[0]).toEqual(completed)
    expect(next.execution.currentRunId).toBeNull()
    expect(next.flow.activeRunId).toBeUndefined()
    expect(next.runState).toEqual(state)
    expect(next.status).toBe(status === 'failed' ? 'error' : 'ready')
    expect(view.execution.runs[0].status).toBe('running')
  })

  it('ignores duplicate events and stale snapshots without repeating terminal side effects', () => {
    const started = applyConversationViewEvent(initial(), event(1, 'run.started', {}))
    const finished = applyConversationViewEvent(started, event(2, 'run.completed', { outcome: 'completed' }))
    expect(applyConversationViewEvent(finished, event(1, 'run.started', {}))).toBe(finished)
    expect(applyConversationViewEvent(finished, event(2, 'run.completed', { outcome: 'failed' }))).toBe(finished)
    expect(applyConversationViewSnapshot(finished, started)).toBe(finished)
    expect(applyConversationViewSnapshot(finished, { ...finished, status: 'running' }).status).toBe('ready')
  })

  it('holds out-of-order completion until a snapshot fills the missing events', () => {
    const started = applyConversationViewEvent(initial(), event(1, 'run.started', {}))
    const completion = event(3, 'run.completed', { outcome: 'completed' })
    expect(applyConversationViewEvent(started, completion)).toBe(started)
    const snapshot = { ...started, flow: { ...started.flow, lastSeq: 2 } }
    const restored = applyConversationViewSnapshot(started, snapshot)
    expect(applyConversationViewEvent(restored, completion).status).toBe('ready')
    expect(applyConversationViewEvent(restored, { ...completion, conversationId: 'other' })).toBe(restored)
  })

  it('requires an explicit new run before later active state can reopen a completed run', () => {
    let view = applyConversationViewEvent(initial(), event(1, 'run.started', {}))
    const completed = { ...run, status: 'completed', completedAt: 248_000 }
    view = applyConversationViewEvent(view, event(2, 'run.completed', { outcome: 'completed', run: completed }))
    view = applyConversationViewEvent(view, event(3, 'run.state_changed', { state: { phase: 'thinking', updatedAt: 300_000 } }))
    view = applyConversationViewEvent(view, event(4, 'execution.updated', { update: { currentRunId: run.id, retainedRunIds: [run.id], runs: [run], removedActivityIds: {} } }))
    expect(view.status).toBe('ready')
    expect(view.execution.runs[0]).toEqual(completed)
    expect(view.flow.activeRunId).toBeUndefined()
    expect(view.flow.lastSeq).toBe(4)
    expect(applyConversationViewEvent(view, event(5, 'run.started', {})).status).toBe('running')
  })

  it('settles older journals from event timing and keeps stopped segments immutable', () => {
    const started = { ...initial(), flow: { ...initial().flow, activeRunId: run.id }, execution: { schemaVersion: 1 as const, currentRunId: run.id, runs: [run] } }
    const finished = applyConversationViewEvent(started, event(1, 'run.completed', { outcome: 'interrupted' }))
    expect(finished.execution.runs[0]).toMatchObject({ status: 'partial', completedAt: 248_000 })
    expect(finished.execution.runs[0].executionSegments).toEqual([run.executionSegments![0], { startedAt: 200_000, endedAt: 248_000, outcome: 'interrupted' }])
  })

  it('accepts the new sequence after history rewrite and rejects delayed facts from the old generation', () => {
    const old = { ...initial(), generation: 1, flow: { ...initial().flow, lastSeq: 90 } }
    const rewritten = { ...initial(), generation: 2, flow: { ...initial().flow, lastSeq: 2 } }
    const accepted = applyConversationViewSnapshot(old, rewritten)
    expect(accepted).toBe(rewritten)
    expect(applyConversationViewSnapshot(accepted, old)).toBe(accepted)
    expect(applyConversationViewEvent(accepted, { ...event(91, 'run.completed', { outcome: 'failed' }), generation: 1 })).toBe(accepted)
    expect(applyConversationViewEvent(accepted, { ...event(3, 'run.started', {}), generation: 2 }).status).toBe('running')
  })

})
