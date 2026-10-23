import { toolInvocationKey, toolResultExecutionStatus } from '@fluxos/contracts/toolResultData'
import type { AgentTurn } from '@fluxos/contracts/agentTypes'
import type { AnyConversationEvent } from '@fluxos/contracts/conversationEvent'
import type { WorkNode, WorkProjectionSnapshot } from './workProjection'
import type { WorkSessionSnapshot } from './workTypes'
import { ToolProjectionIndex, newToolProjectionKey } from './toolProjectionIdentity'

export type TaskFlowNodeKind = 'thinking' | 'answer' | 'input' | 'tool' | 'runtime' | 'approval' | 'phase'
export type TaskFlowNodeStatus = 'waiting' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface TaskFlowNode {
  id: string
  anchorSeq?: number
  lastSeq?: number
  runId?: string
  turnId?: string
  responseId?: string
  callId?: string
  invocationId?: string
  toolName?: string
  /** A complete call is declared; model-stream cancellation must not cancel its execution. */
  proposed?: boolean
  parentId?: string
  ordinal: number
  kind: TaskFlowNodeKind
  phase: 'reasoning' | 'execution' | 'delivery' | 'control'
  status: TaskFlowNodeStatus
  content: string
  detail?: string
  createdAt: number
  updatedAt: number
  settled: boolean
}

export interface TaskFlowProjectionState {
  conversationId: string
  source: 'work'
  revision: number
  activeRunId?: string
  lastSeq: number
  nodes: Readonly<Record<string, TaskFlowNode>>
  order: readonly string[]
  sequenceGaps: readonly number[]
}

// A linear live event chain consumes its index instead of cloning it with every
// immutable node map. Revisiting an older snapshot rebuilds an independent index.
// Weak keys keep abandoned conversations and history branches collectible.
const toolIndexes = new WeakMap<object, ToolProjectionIndex<TaskFlowNode>>()
const writableNodeMaps = new WeakSet<object>()

function toolIndex(nodes: TaskFlowProjectionState['nodes']): ToolProjectionIndex<TaskFlowNode> {
  let index = toolIndexes.get(nodes)
  if (!index) {
    index = new ToolProjectionIndex<TaskFlowNode>()
    for (const [id, node] of Object.entries(nodes)) index.upsert(id, node)
    toolIndexes.set(nodes, index)
  }
  return index
}

function carryToolIndex(previous: TaskFlowProjectionState['nodes'], next: TaskFlowProjectionState['nodes'], changed: readonly TaskFlowNode[]): void {
  const index = toolIndex(previous)
  toolIndexes.delete(previous)
  for (const node of changed) index.upsert(node.id, node)
  toolIndexes.set(next, index)
}

/** Runs a synchronous batch against a private copy, then seals that copy. */
export function withTaskFlowDraft<Result>(state: TaskFlowProjectionState, apply: (draft: TaskFlowProjectionState) => Result): Result {
  const nodes = { ...state.nodes }
  const draft = { ...state, nodes, order: [...state.order] }
  carryToolIndex(state.nodes, nodes, [])
  writableNodeMaps.add(nodes)
  try {
    return apply(draft)
  } finally {
    writableNodeMaps.delete(nodes)
  }
}

function writeNode(state: TaskFlowProjectionState, id: string, node: TaskFlowNode): TaskFlowProjectionState {
  const existing = Boolean(state.nodes[id])
  const writable = writableNodeMaps.has(state.nodes)
  const nodes = writable ? state.nodes as Record<string, TaskFlowNode> : { ...state.nodes }
  nodes[id] = node
  carryToolIndex(state.nodes, nodes, [node])
  let order = state.order
  if (!existing) {
    if (writable) (order as string[]).push(id)
    else order = [...order, id]
  }
  return { ...state, nodes, order }
}

function updateNodes(
  state: TaskFlowProjectionState,
  update: (node: TaskFlowNode) => TaskFlowNode,
): Record<string, TaskFlowNode> {
  const changed: TaskFlowNode[] = []
  const writable = writableNodeMaps.has(state.nodes)
  const nodes = writable ? state.nodes as Record<string, TaskFlowNode> : { ...state.nodes }
  for (const [id, node] of Object.entries(state.nodes)) {
    const next = update(node)
    if (next !== node) changed.push(next)
    nodes[id] = next
  }
  carryToolIndex(state.nodes, nodes, changed)
  return nodes
}

function phaseForKind(kind: TaskFlowNodeKind): TaskFlowNode['phase'] {
  if (kind === 'thinking') return 'reasoning'
  if (kind === 'answer') return 'delivery'
  if (kind === 'approval' || kind === 'input') return 'control'
  return 'execution'
}

function taskKindForWorkNode(node: WorkNode): TaskFlowNodeKind {
  return node.kind === 'reasoning' ? 'thinking' : node.kind
}

function taskNodeForWorkNode(node: WorkNode, activeRunId?: string): TaskFlowNode {
  const kind = taskKindForWorkNode(node)
  const staleOpenNode = !node.settled && (!activeRunId || !node.runId || node.runId !== activeRunId)
  return {
    id: node.key,
    anchorSeq: node.anchorSeq,
    lastSeq: node.lastSeq,
    runId: node.runId,
    turnId: node.turnId,
    responseId: node.responseId,
    callId: node.callId,
    invocationId: node.invocationId,
    toolName: node.toolName,
    proposed: kind === 'tool' ? Boolean(node.toolCall) : undefined,
    parentId: node.responseId || node.runId,
    ordinal: node.ordinal,
    kind,
    phase: phaseForKind(kind),
    status: staleOpenNode ? 'interrupted' : node.status,
    content: node.content,
    detail: node.detail,
    createdAt: node.startedAt,
    updatedAt: node.updatedAt,
    settled: node.settled || staleOpenNode,
  }
}

export function projectWorkProjection(projection: WorkProjectionSnapshot): TaskFlowProjectionState {
  return {
    conversationId: projection.sessionId,
    source: 'work',
    revision: projection.revision,
    activeRunId: projection.activeRunId,
    lastSeq: projection.lastSeq,
    nodes: Object.fromEntries(Object.entries(projection.nodes).map(([key, node]) => [key, taskNodeForWorkNode(node, projection.activeRunId)])),
    order: projection.order.filter(key => Boolean(projection.nodes[key])),
    sequenceGaps: [],
  }
}

export function applyTaskFlowWorkSnapshot(
  state: TaskFlowProjectionState | null,
  snapshot: WorkSessionSnapshot,
): TaskFlowProjectionState {
  const projection = snapshot.projection
  if (
    state?.source === 'work'
    && state.conversationId === projection.sessionId
    && state.revision === projection.revision
    && state.lastSeq === projection.lastSeq
  ) return state
  return projectWorkProjection(projection)
}

function createNode(input: {
  id: string
  lastSeq?: number
  runId?: string
  turnId?: string
  ordinal: number
  kind: TaskFlowNodeKind
  status: TaskFlowNodeStatus
  content?: string
  at: number
  settled?: boolean
}): TaskFlowNode {
  return {
    id: input.id,
    anchorSeq: input.lastSeq,
    lastSeq: input.lastSeq,
    runId: input.runId,
    turnId: input.turnId,
    parentId: input.runId,
    ordinal: input.ordinal,
    kind: input.kind,
    phase: phaseForKind(input.kind),
    status: input.status,
    content: input.content || '',
    createdAt: input.at,
    updatedAt: input.at,
    settled: input.settled ?? false,
  }
}

function upsertNode(
  state: TaskFlowProjectionState,
  id: string,
  create: () => TaskFlowNode,
  update: (node: TaskFlowNode) => TaskFlowNode,
): TaskFlowProjectionState {
  const existing = state.nodes[id]
  const node = existing ? update(existing) : create()
  return writeNode(state, id, node)
}

function eventNodeKind(event: AnyConversationEvent): TaskFlowNodeKind | null {
  switch (event.type) {
    case 'turn.started':
      return event.payload.turn.role === 'user' ? 'input' : null
    case 'run.state_changed':
      return 'phase'
    case 'stream.started':
    case 'stream.delta':
    case 'stream.committed':
    case 'stream.ended':
      return event.payload.channel === 'thinking' ? 'thinking' : 'answer'
    case 'tool.delta':
    case 'tool.proposed':
    case 'tool.completed':
      return 'tool'
    case 'runtime.event':
      return 'runtime'
    case 'approval.requested':
    case 'approval.resolved':
    case 'approval.cancelled':
      return 'approval'
    case 'input.state_changed':
      return 'input'
    default:
      return null
  }
}

function eventStatus(event: AnyConversationEvent, fallback: TaskFlowNodeStatus): TaskFlowNodeStatus {
  if (event.type === 'turn.started') return 'completed'
  if (event.type === 'run.state_changed') {
    if (event.payload.state.phase === 'paused') return 'paused'
    return event.payload.state.phase === 'completed'
      ? 'completed'
      : event.payload.state.phase === 'recoverable_error'
        ? 'failed'
        : event.payload.state.phase === 'aborting'
          ? 'interrupted'
          : 'running'
  }
  if (event.type === 'stream.committed') return 'completed'
  if (event.type === 'stream.ended') return event.payload.interrupted ? 'interrupted' : 'completed'
  if (event.type === 'approval.requested') return 'waiting'
  if (event.type === 'tool.completed') {
    const result = event.payload.toolResult
    if (result.interruption?.kind === 'pause') return 'interrupted'
    const status = toolResultExecutionStatus(result)
    // The launch/poll call settled; a separately reported process may still run.
    return status === 'running' ? 'completed' : status
  }
  if (event.type === 'approval.resolved') return 'completed'
  if (event.type === 'approval.cancelled') return 'cancelled'
  if (event.type === 'input.state_changed') {
    if (['rejected', 'restored', 'removed', 'cancelled'].includes(event.payload.state)) return 'cancelled'
    return event.payload.state === 'committed' ? 'completed' : 'waiting'
  }
  return fallback
}

function eventContent(event: AnyConversationEvent, previous = ''): string {
  if (event.type === 'turn.started') return event.payload.turn.content
  if (event.type === 'run.state_changed') return event.payload.state.detail || event.payload.state.phase
  if (event.type === 'stream.delta') return `${previous}${event.payload.text}`
  if (event.type === 'stream.committed') return event.payload.text
  if (event.type === 'tool.delta') return event.payload.toolName
  if (event.type === 'tool.proposed') return event.payload.toolCall.name
  if (event.type === 'tool.completed') return event.payload.toolResult.name
  if (event.type === 'runtime.event') return previous || event.payload.kind
  if (event.type === 'approval.requested') return event.payload.toolName || event.payload.kind
  if (event.type === 'input.state_changed') return event.payload.text || previous
  return previous
}

function eventNodeId(event: AnyConversationEvent, kind: TaskFlowNodeKind): string | undefined {
  if (event.type === 'tool.proposed') return `tool:${toolInvocationKey(event.payload.toolCall.id, event.payload.toolCall.operationIdentity)}`
  if (event.type === 'tool.completed') return `tool:${toolInvocationKey(event.payload.toolResult.toolCallId, event.payload.toolResult.operationIdentity)}`
  if (kind === 'phase') return `phase:${event.runId || event.conversationId}`
  if (kind === 'input' && event.type === 'turn.started') return `input:${event.payload.turn.id}`
  if (kind === 'thinking' || kind === 'answer') {
    if (event.stepId) return `step:${event.stepId}:${kind === 'thinking' ? 'reasoning' : 'answer'}`
    if (event.turnId) return `turn:${event.turnId}:response:${kind === 'thinking' ? 'reasoning' : 'answer'}`
  }
  if (!event.itemId) return undefined
  if (kind === 'tool') return `tool:${event.itemId}`
  if (kind === 'approval') return `approval:${event.itemId}`
  if (kind === 'input') return `input:${event.itemId}`
  return event.itemId
}

export function createTaskFlowProjection(conversationId: string): TaskFlowProjectionState {
  return { conversationId, source: 'work', revision: 0, lastSeq: 0, nodes: {}, order: [], sequenceGaps: [] }
}

function applyToolProjectionEvent(
  state: TaskFlowProjectionState,
  event: Extract<AnyConversationEvent, { type: 'tool.delta' | 'tool.proposed' | 'tool.completed' }>,
): TaskFlowProjectionState {
  const callId = event.type === 'tool.delta' ? event.payload.toolCallId
    : event.type === 'tool.proposed' ? event.payload.toolCall.id : event.payload.toolResult.toolCallId
  const identity = event.type === 'tool.proposed' ? event.payload.toolCall.operationIdentity
    : event.type === 'tool.completed' ? event.payload.toolResult.operationIdentity : undefined
  const runId = event.runId || state.activeRunId
  const responseId = event.stepId ? `step:${event.stepId}` : undefined
  const index = toolIndex(state.nodes)
  const matched = index.matching(callId, identity, runId, responseId)
  if (event.type === 'tool.delta' && (matched?.[1].settled || !matched && index.hasBound(callId, runId, responseId))) return state
  const nodeId = matched?.[0] || newToolProjectionKey(state.nodes, callId, identity, runId, responseId, event.seq)
  const previous = matched?.[1]
  const name = event.type === 'tool.delta' ? event.payload.toolName
    : event.type === 'tool.proposed' ? event.payload.toolCall.name : event.payload.toolResult.name
  const status = event.type === 'tool.proposed' && previous?.settled ? previous.status
    : eventStatus(event, state.nodes[`phase:${runId || state.conversationId}`]?.status === 'paused' ? 'paused' : 'running')
  const settled = ['completed', 'failed', 'cancelled', 'interrupted'].includes(status)
  const node: TaskFlowNode = {
    ...(previous || createNode({ id: nodeId, lastSeq: event.seq, runId, turnId: identity?.turnId || event.turnId,
      ordinal: event.seq, kind: 'tool', status, content: name, at: event.at, settled })),
    callId, invocationId: toolInvocationKey(callId, identity), toolName: name,
    proposed: previous?.proposed || event.type === 'tool.proposed',
    runId: previous?.runId || runId,
    responseId: previous?.responseId || responseId,
    turnId: identity?.turnId || previous?.turnId || event.turnId,
    lastSeq: event.seq, updatedAt: event.at, content: name, status, settled,
    detail: event.type === 'tool.delta' ? event.payload.partialJson
      : event.type === 'tool.completed' ? event.payload.toolResult.output
        : previous?.settled ? previous.detail : JSON.stringify(event.payload.toolCall.arguments),
  }
  return writeNode(state, nodeId, node)
}

export function applyTaskFlowEvents(state: TaskFlowProjectionState, events: readonly AnyConversationEvent[]): TaskFlowProjectionState {
  if (events.length < 2) return events.reduce(applyTaskFlowEvent, state)
  return withTaskFlowDraft(state, draft => events.reduce(applyTaskFlowEvent, draft))
}

export function applyTaskFlowEvent(
  state: TaskFlowProjectionState,
  event: AnyConversationEvent,
): TaskFlowProjectionState {
  if (event.threadId !== state.conversationId || event.conversationId !== state.conversationId) return state
  if (event.type === 'conversation.activated' && event.seq <= state.lastSeq) {
    state = createTaskFlowProjection(state.conversationId)
  } else if (event.seq <= state.lastSeq) {
    return state
  }
  const sequenceGaps = event.seq > state.lastSeq + 1
    ? [...state.sequenceGaps, event.seq]
    : state.sequenceGaps
  let next: TaskFlowProjectionState = {
    ...state,
    revision: state.revision + 1,
    activeRunId: event.type === 'run.started'
      ? event.runId
      : event.type === 'run.completed'
        ? undefined
        : state.activeRunId,
    lastSeq: event.seq,
    sequenceGaps,
  }
  if (event.type === 'run.state_changed') {
    const paused = event.payload.state.phase === 'paused'
    next.nodes = updateNodes(next, node =>
      node.runId === event.runId && !node.settled && (node.status === 'running' || node.status === 'paused')
        ? { ...node, status: paused ? 'paused' : 'running', lastSeq: event.seq, updatedAt: event.at }
        : node,
    )
  }
  if (event.type === 'step.completed' && event.stepId && event.payload.outcome !== 'completed') {
    next.nodes = updateNodes(next, node =>
      node.kind === 'tool' && node.runId === event.runId && node.responseId === `step:${event.stepId}` && !node.settled && !node.proposed
        ? { ...node, status: event.payload.outcome, settled: true, lastSeq: event.seq, updatedAt: event.at }
        : node,
    )
  }
  if (event.type === 'turn.completed') {
    const turn = event.payload.turn
    if (turn.role !== 'assistant') return next
    const terminalStatus: TaskFlowNodeStatus = turn.metadata?.interrupted ? 'interrupted' : 'completed'
    const nodes = updateNodes(next, node => (
        node.runId === event.runId && node.turnId === turn.id && !node.settled
          ? { ...node, status: terminalStatus, settled: true, lastSeq: event.seq, updatedAt: event.at }
          : node
    ))
    for (const call of turn.toolCalls || []) {
      if (!call.operationIdentity) continue
      const responseId = event.stepId ? `step:${event.stepId}` : undefined
      const index = toolIndex(nodes)
      const match = index.matching(call.id, call.operationIdentity, event.runId || next.activeRunId, responseId)
      if (match) {
        nodes[match[0]] = { ...match[1], turnId: turn.id, invocationId: toolInvocationKey(call.id, call.operationIdentity), lastSeq: event.seq, updatedAt: event.at }
        index.upsert(match[0], nodes[match[0]]!)
      }
    }
    let completed = { ...next, nodes }
    for (const toolCall of turn.toolCalls || []) {
      completed = applyToolProjectionEvent(completed, { ...event, turnId: turn.id, type: 'tool.proposed', payload: { toolCall } })
    }
    return completed
  }
  if (event.type === 'tool.delta' || event.type === 'tool.proposed' || event.type === 'tool.completed') return applyToolProjectionEvent(next, event)
  const kind = eventNodeKind(event)
  const nodeId = kind ? eventNodeId(event, kind) : undefined
  if (!kind || !nodeId) {
    if (event.type === 'run.completed') {
      const terminalStatus: TaskFlowNodeStatus = event.payload.outcome === 'failed'
        ? 'failed'
        : event.payload.outcome === 'cancelled'
          ? 'cancelled'
          : event.payload.outcome === 'interrupted'
            ? 'interrupted'
            : 'completed'
      const nodes = updateNodes(next, node => (
          node.runId === event.runId && !node.settled
            ? { ...node, status: terminalStatus, settled: true, lastSeq: event.seq, updatedAt: event.at }
            : node
      ))
      return { ...next, nodes }
    }
    return next
  }
  if (event.type === 'stream.ended' && !next.nodes[nodeId]) return next
  const paused = next.nodes[`phase:${event.runId || event.conversationId}`]?.status === 'paused'
  const status = eventStatus(event, kind === 'approval' || kind === 'input' ? 'waiting' : paused ? 'paused' : 'running')
  const settled = ['completed', 'failed', 'cancelled', 'interrupted'].includes(status)
  next = upsertNode(
    next,
    nodeId,
    () => createNode({
      id: nodeId,
      lastSeq: event.seq,
      runId: event.runId,
      turnId: event.turnId,
      ordinal: event.seq,
      kind,
      status,
      content: eventContent(event),
      at: event.at,
      settled,
    }),
    node => ({
      ...node,
      lastSeq: event.seq,
      runId: node.runId || event.runId,
      turnId: node.turnId || event.turnId,
      status,
      content: eventContent(event, node.content),
      detail: event.type === 'run.state_changed' ? event.payload.state.detail : node.detail,
      updatedAt: event.at,
      settled: node.settled || settled,
    }),
  )
  return next
}

export function historicalTaskFlowNodeId(turn: AgentTurn, kind: 'thinking' | 'answer'): string {
  return `turn:${turn.id}:${kind}`
}

export function taskFlowNodeIdForTurn(
  state: TaskFlowProjectionState | null,
  turn: AgentTurn,
  kind: 'thinking' | 'answer' | 'input',
): string {
  const match = state?.order.find(id => {
    const node = state.nodes[id]
    return node?.turnId === turn.id && node.kind === kind
  })
  if (match) return match
  if (kind === 'input') return `input:${turn.id}`
  return historicalTaskFlowNodeId(turn, kind)
}

export function taskFlowNodeIdForTool(state: TaskFlowProjectionState | null, callId: string): string {
  const canonicalId = `tool:${callId}`
  if (state?.nodes[canonicalId]) return canonicalId
  const match = state?.order.find(id => state.nodes[id]?.callId === callId)
  return match || callId
}

export function latestTaskFlowNodeId(
  state: TaskFlowProjectionState,
  kind: TaskFlowNodeKind,
  options: { unsettled?: boolean } = {},
): string | undefined {
  return [...state.order].reverse().find(id => {
    const node = state.nodes[id]
    return node?.kind === kind && (options.unsettled !== true || !node.settled)
  })
}

export function syncTaskFlowLiveText(
  state: TaskFlowProjectionState,
  kind: Extract<TaskFlowNodeKind, 'thinking' | 'answer'>,
  content: string,
  updatedAt = Date.now(),
): TaskFlowProjectionState {
  if (!content) return state
  const id = latestTaskFlowNodeId(state, kind, { unsettled: true })
  if (!id) return state
  const node = state.nodes[id]
  if (!node || node.content === content) return state
  const nodes = { ...state.nodes, [id]: { ...node, content, updatedAt } }
  carryToolIndex(state.nodes, nodes, [])
  return { ...state, revision: state.revision + 1, nodes }
}

export function orderTaskFlowNodeIds(state: TaskFlowProjectionState, ids: readonly string[]): string[] {
  const position = new Map(state.order.map((id, index) => [id, index]))
  return ids
    .map((id, index) => ({ id, index, position: position.get(id) }))
    .sort((left, right) => {
      if (left.position === undefined && right.position === undefined) return left.index - right.index
      if (left.position === undefined) return 1
      if (right.position === undefined) return -1
      return left.position - right.position || left.index - right.index
    })
    .map(item => item.id)
}
