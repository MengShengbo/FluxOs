import { describe, expect, it } from 'vitest'
import type { AnyConversationEvent } from '@fluxos/contracts/conversationEvent'
import type { ToolCall } from '@fluxos/contracts/agentTypes'
import { toolInvocationKey } from '@fluxos/contracts/toolResultData'
import { WorkProjectionEngine } from './workProjection'
import { applyTaskFlowEvent, createTaskFlowProjection, projectWorkProjection, type TaskFlowProjectionState } from './taskFlowProjection'

const call = (id: string, turnId = 'assistant-a'): ToolCall => ({
  id, name: 'read_file', arguments: { path: `${id}.ts` },
  operationIdentity: { sessionId: 'session', turnId, callId: id },
})

function harness() {
  const engine = new WorkProjectionEngine('session')
  let live = createTaskFlowProjection('session')
  let seq = 0
  const events: AnyConversationEvent[] = []
  const tools = (flow: TaskFlowProjectionState) => flow.order.map(id => flow.nodes[id]!).filter(node => node.kind === 'tool')
  const facts = (flow: TaskFlowProjectionState) => tools(flow).map(({ id, anchorSeq, createdAt, lastSeq, runId, turnId, responseId, callId, invocationId, proposed, status, settled, detail }) => (
    { id, anchorSeq, createdAt, lastSeq, runId, turnId, responseId, callId, invocationId, proposed, status, settled, detail }
  ))
  const push = (type: AnyConversationEvent['type'], payload: unknown, extra: Record<string, unknown> = {}) => {
    const event = { schemaVersion: 1, eventId: `e-${++seq}`, conversationId: 'session', threadId: 'session',
      seq, at: 1_000 + seq, source: 'agent', provenance: 'live', runId: 'run', stepId: 'step-a', type, payload, ...extra } as AnyConversationEvent
    engine.apply(event)
    events.push(event)
    live = applyTaskFlowEvent(live, event)
    expect(facts(live)).toEqual(facts(projectWorkProjection(engine.getSnapshot())))
    return event
  }
  const delta = (id: string, partialJson = '{"path":', extra: Record<string, unknown> = {}) => push('tool.delta', { toolCallId: id, toolName: 'read_file', partialJson }, { itemId: id, ...extra })
  const turn = (calls: ToolCall[], extra: Record<string, unknown> = {}) => push('turn.completed', { turn: {
    id: calls[0]?.operationIdentity?.turnId || 'assistant-a', role: 'assistant', content: '', timestamp: 1_000 + seq, toolCalls: calls,
  } }, extra)
  const proposed = (toolCall: ToolCall, extra: Record<string, unknown> = {}) => push('tool.proposed', { toolCall }, { itemId: toolCall.id, turnId: toolCall.operationIdentity?.turnId, ...extra })
  const completed = (toolCall: ToolCall, output = 'done', extra: Record<string, unknown> = {}) => push('tool.completed', { toolResult: {
    toolCallId: toolCall.id, name: toolCall.name, operationIdentity: toolCall.operationIdentity, output, isError: false,
  } }, { itemId: toolCall.id, turnId: toolCall.operationIdentity?.turnId, ...extra })
  push('run.started', {})
  push('turn.started', { turn: { id: 'user', role: 'user', content: 'Inspect files', timestamp: 1_000 } })
  push('step.started', { index: 1 })
  return { engine, events, live: () => live, tools: () => tools(live), push, delta, turn, proposed, completed }
}

function anchor(h: ReturnType<typeof harness>, key: string) {
  const canonical = h.engine.getSnapshot().nodes[key]!
  const live = h.live().nodes[key]!
  return { canonical: [canonical.anchorSeq, canonical.ordinal, canonical.startedAt], live: [live.anchorSeq, live.ordinal, live.createdAt] }
}

describe('streamed tool display identity', () => {
  it('upgrades two streamed tools in place through turn binding and sequential proposals', () => {
    const h = harness()
    h.delta('a'); h.delta('b')
    const a = anchor(h, 'tool:a'), b = anchor(h, 'tool:b')
    const initialOrder = h.live().order
    h.turn([call('a'), call('b')])
    expect(h.live().order).toEqual(initialOrder)
    h.proposed(call('a'))
    expect(h.tools().map(node => node.id)).toEqual(['tool:a', 'tool:b'])
    h.proposed(call('b'))
    expect(h.tools().map(node => node.id)).toEqual(['tool:a', 'tool:b'])
    expect(anchor(h, 'tool:a')).toEqual(a)
    expect(anchor(h, 'tool:b')).toEqual(b)
    expect(h.tools().map(node => node.invocationId)).toEqual([toolInvocationKey('a', call('a').operationIdentity), toolInvocationKey('b', call('b').operationIdentity)])
    expect(new WorkProjectionEngine('session').replace(h.events)).toEqual(h.engine.getSnapshot())
    expect(h.events.reduce(applyTaskFlowEvent, createTaskFlowProjection('session'))).toEqual(h.live())
  })

  it('keeps the first streamed slots when turn tool order and proposal order differ', () => {
    const h = harness()
    h.delta('a'); h.delta('b')
    const before = h.tools().map(node => node.id)
    h.turn([call('b'), call('a')])
    h.proposed(call('b')); h.proposed(call('a'))
    h.completed(call('b')); h.completed(call('a'))
    expect(h.tools().map(node => node.id)).toEqual(before)
    expect(h.tools().every(node => node.settled && node.status === 'completed')).toBe(true)
  })

  it('accepts an out-of-order result before a proposal without moving or reopening its slot', () => {
    const h = harness()
    h.delta('a'); h.delta('b')
    const b = anchor(h, 'tool:b')
    h.completed(call('b'), 'b finished first')
    const completedAt = h.engine.getSnapshot().nodes['tool:b'].completedAt
    h.turn([call('a'), call('b')])
    h.proposed(call('a')); h.proposed(call('b'))
    expect(h.tools().map(node => node.id)).toEqual(['tool:a', 'tool:b'])
    expect(h.live().nodes['tool:b']).toMatchObject({ status: 'completed', settled: true, detail: 'b finished first' })
    expect(anchor(h, 'tool:b')).toEqual(b)
    expect(h.engine.getSnapshot().nodes['tool:b'].completedAt).toBe(completedAt)
    h.completed(call('a'), 'a finished later')
    expect(h.live().nodes['tool:a'].detail).toBe('a finished later')
  })

  it('reuses neither a bound call nor its result for another invocation with the same raw provider ID', () => {
    const h = harness()
    const first = call('reused', 'assistant-a'), second = call('reused', 'assistant-b')
    h.delta('reused'); h.turn([first]); h.proposed(first); h.completed(first, 'first result')
    const firstAnchor = anchor(h, 'tool:reused')
    h.push('step.started', { index: 2 }, { stepId: 'step-b' })
    h.delta('reused', '{"path":"second.ts"}', { stepId: 'step-b' })
    const secondKey = h.tools()[1].id
    expect(secondKey).not.toBe('tool:reused')
    const secondAnchor = anchor(h, secondKey)
    h.completed(first, 'late first result', { stepId: 'step-a' })
    expect(h.live().nodes[secondKey]).toMatchObject({ status: 'running', settled: false, detail: '{"path":"second.ts"}' })
    h.turn([second], { stepId: 'step-b' }); h.proposed(second, { stepId: 'step-b' }); h.completed(second, 'second result', { stepId: 'step-b' })
    expect(h.tools()).toHaveLength(2)
    expect(h.live().nodes['tool:reused'].detail).toBe('late first result')
    expect(h.live().nodes[secondKey].detail).toBe('second result')
    expect(anchor(h, 'tool:reused')).toEqual(firstAnchor)
    expect(anchor(h, secondKey)).toEqual(secondAnchor)
  })

  it('keeps interrupted partial JSON separate from a later step using the same raw ID', () => {
    const h = harness()
    h.delta('partial', '{"path":')
    const original = anchor(h, 'tool:partial')
    h.push('step.completed', { index: 1, outcome: 'interrupted' })
    expect(h.live().nodes['tool:partial']).toMatchObject({ status: 'interrupted', settled: true, detail: '{"path":' })
    h.push('step.started', { index: 2 }, { stepId: 'step-b' })
    h.delta('partial', '{"path":"new.ts"}', { stepId: 'step-b' })
    const fresh = h.tools()[1].id
    const second = call('partial', 'assistant-b')
    h.turn([second], { stepId: 'step-b' }); h.proposed(second, { stepId: 'step-b' })
    expect(h.live().nodes[fresh]).toMatchObject({ status: 'running', settled: false, turnId: 'assistant-b' })
    expect(h.live().nodes['tool:partial']).toMatchObject({ status: 'interrupted', settled: true, turnId: undefined })
    expect(anchor(h, 'tool:partial')).toEqual(original)
  })

  it('ignores late raw deltas after binding rather than creating another partial tool', () => {
    const h = harness()
    h.delta('a'); h.turn([call('a')]); h.proposed(call('a'))
    h.delta('a', '{"late":true}')
    expect(h.tools()).toHaveLength(1)
    expect(h.live().nodes['tool:a']).toMatchObject({ invocationId: toolInvocationKey('a', call('a').operationIdentity), detail: '{"path":"a.ts"}' })
  })

  it('keeps paused streamed slots paused through binding and resumes the same nodes', () => {
    const h = harness()
    h.delta('a'); h.delta('b')
    const first = anchor(h, 'tool:a')
    h.push('run.state_changed', { state: { phase: 'paused', updatedAt: 1_006 } })
    h.turn([call('a'), call('b')]); h.proposed(call('a')); h.proposed(call('b'))
    expect(h.tools().every(node => node.status === 'paused' && !node.settled)).toBe(true)
    h.push('run.state_changed', { state: { phase: 'tool_running', updatedAt: 1_010 } })
    expect(h.tools().map(node => node.id)).toEqual(['tool:a', 'tool:b'])
    expect(h.tools().every(node => node.status === 'running' && !node.settled)).toBe(true)
    expect(anchor(h, 'tool:a')).toEqual(first)
  })

  it('settles cancelled partial argument streams without cancelling already proposed tools', () => {
    const h = harness()
    h.proposed(call('executing'))
    h.delta('partial')
    h.push('run.state_changed', { state: { phase: 'paused', updatedAt: 1_006 } })
    h.push('step.completed', { index: 1, outcome: 'interrupted' })
    h.push('run.state_changed', { state: { phase: 'tool_running', updatedAt: 1_008 } })
    expect(h.tools().find(node => node.callId === 'partial')).toMatchObject({ status: 'interrupted', settled: true, proposed: false })
    expect(h.tools().find(node => node.callId === 'executing')).toMatchObject({ status: 'running', settled: false, proposed: true })
    h.completed(call('executing'))
    expect(h.tools().find(node => node.callId === 'executing')).toMatchObject({ status: 'completed', settled: true })
  })

  it('keeps formal calls without streamed previews stable when their results arrive in reverse order', () => {
    const h = harness()
    h.turn([call('a'), call('b')]); h.proposed(call('a')); h.proposed(call('b'))
    const original = h.tools().map(node => node.id)
    h.completed(call('b')); h.completed(call('a'))
    expect(h.tools().map(node => node.id)).toEqual(original)
    expect(h.tools().every(node => node.settled && node.status === 'completed')).toBe(true)
  })

  it('allocates complete-turn calls in declared order before proposals can arrive in another order', () => {
    const h = harness()
    h.turn([call('a'), call('b')]); h.proposed(call('b')); h.proposed(call('a'))
    expect(h.tools().map(node => node.callId)).toEqual(['a', 'b'])
  })

  it('does not steal a provisional slot from another run when a scoped result arrives', () => {
    const h = harness()
    h.delta('reused')
    h.completed(call('reused', 'other-turn'), 'unrelated', { runId: 'other-run', stepId: 'other-step' })
    expect(h.tools()).toHaveLength(2)
    expect(h.live().nodes['tool:reused']).toMatchObject({ status: 'running', settled: false, runId: 'run', turnId: undefined })
    expect(h.tools()[1]).toMatchObject({ runId: 'other-run', turnId: 'other-turn', status: 'completed' })
  })

  it('does not assign an unscoped raw result to either of two ambiguous unbound calls', () => {
    const h = harness()
    const raw: ToolCall = { id: 'reused', name: 'read_file', arguments: { path: 'one.ts' } }
    h.proposed(raw)
    h.push('step.started', { index: 2 }, { stepId: 'step-b' })
    h.proposed({ ...raw, arguments: { path: 'two.ts' } }, { stepId: 'step-b' })
    const firstTwo = h.tools().map(node => ({ id: node.id, detail: node.detail }))
    h.push('run.completed', { outcome: 'completed' })
    h.completed(raw, 'unattributed result', { runId: undefined, stepId: undefined })
    expect(h.tools().slice(0, 2).map(node => ({ id: node.id, detail: node.detail }))).toEqual(firstTwo)
    expect(h.tools()).toHaveLength(3)
    expect(h.tools()[2].detail).toBe('unattributed result')
  })
})

describe('tool projection lookup cost and snapshot ownership', () => {
  it('updates long histories without enumerating the complete work node map', () => {
    const engine = new WorkProjectionEngine('session')
    let seq = 0
    const push = (type: AnyConversationEvent['type'], payload: unknown, extra: Record<string, unknown> = {}) => {
      const event = Object.freeze({ schemaVersion: 1, eventId: `cost-${++seq}`, conversationId: 'session', threadId: 'session',
        seq, at: seq, source: 'agent', provenance: 'live', runId: 'run', stepId: 'step-a', type, payload, ...extra }) as AnyConversationEvent
      engine.apply(event)
    }
    for (let index = 0; index < 1_000; index += 1) {
      const toolCall = call(`history-${index}`)
      push('tool.proposed', { toolCall })
      push('tool.completed', { toolResult: { toolCallId: toolCall.id, name: toolCall.name,
        operationIdentity: toolCall.operationIdentity, output: 'done', isError: false } })
    }
    const internal = engine as unknown as { nodes: Record<string, unknown> }
    const nodes = internal.nodes
    internal.nodes = new Proxy(nodes, { ownKeys() { throw new Error('Tool lookup enumerated the complete history') } })
    const toolCall = call('fresh')
    push('tool.delta', { toolCallId: 'fresh', toolName: 'read_file', partialJson: '{' })
    push('turn.completed', { turn: { id: 'assistant-a', role: 'assistant', timestamp: seq, content: '', toolCalls: [toolCall] } })
    push('tool.proposed', { toolCall })
    push('tool.completed', { toolResult: { toolCallId: toolCall.id, name: toolCall.name,
      operationIdentity: toolCall.operationIdentity, output: 'new', isError: false } })
    push('tool.delta', { toolCallId: 'fresh', toolName: 'read_file', partialJson: 'late' })
    internal.nodes = nodes
    expect(engine.getSnapshot().nodes['tool:fresh']).toMatchObject({ detail: 'new', settled: true })
  })

  it('keeps old immutable flow snapshots safe when advancing and branching their indexes', () => {
    const h = harness()
    h.delta('reused')
    const original = h.live()
    const originalValue = structuredClone(original)
    h.turn([call('reused')]); h.proposed(call('reused')); h.completed(call('reused'))
    expect(original).toEqual(originalValue)
    const branchEvent = { ...h.events.at(-1)!, eventId: 'branch', seq: original.lastSeq + 1,
      type: 'tool.delta', payload: { toolCallId: 'reused', toolName: 'read_file', partialJson: 'branch' } } as AnyConversationEvent
    const branch = applyTaskFlowEvent(original, branchEvent)
    expect(branch.nodes['tool:reused']).toMatchObject({ detail: 'branch', settled: false, invocationId: 'reused' })
    expect(original).toEqual(originalValue)
    expect(h.live().nodes['tool:reused']).toMatchObject({ detail: 'done', settled: true })
    const advanced = applyTaskFlowEvent(h.live(), { ...branchEvent, seq: h.live().lastSeq + 1 })
    expect(advanced.nodes['tool:reused']).toMatchObject({ detail: 'done', settled: true })
  })

  it('clears tool lookup state when the work engine activates another conversation', () => {
    const h = harness()
    h.delta('a'); h.turn([call('a')]); h.proposed(call('a')); h.completed(call('a'))
    h.engine.activate('other')
    const delta = h.events.find(event => event.type === 'tool.delta')!
    h.engine.apply({ ...delta, conversationId: 'other', threadId: 'other', seq: 1 })
    expect(h.engine.getSnapshot().order).toEqual(['tool:a'])
    expect(h.engine.getSnapshot().nodes['tool:a']).toMatchObject({ settled: false, invocationId: 'a' })
  })
})
