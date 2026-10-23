import { toolInvocationKey, toolResultCallStatus } from '@fluxos/contracts/toolResultData'
import type { ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import type { AnyConversationEvent, ConversationRunOutcome, ConversationStepOutcome } from '@fluxos/contracts/conversationEvent'
import { ToolProjectionIndex, newToolProjectionKey } from './toolProjectionIdentity'

export type WorkNodeKind = 'input' | 'reasoning' | 'answer' | 'tool' | 'runtime' | 'approval' | 'phase'
export type WorkNodeStatus = 'waiting' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface WorkNode {
  key: string
  anchorSeq: number
  lastSeq: number
  ordinal: number
  kind: WorkNodeKind
  status: WorkNodeStatus
  runId?: string
  turnId?: string
  responseId?: string
  callId?: string
  invocationId?: string
  parentCallId?: string
  toolName?: string
  toolCall?: ToolCall
  toolResult?: ToolResult
  content: string
  detail?: string
  startedAt: number
  updatedAt: number
  completedAt?: number
  settled: boolean
}

export interface WorkProjectionSnapshot {
  schemaVersion: 1
  sessionId: string
  threadId: string
  revision: number
  lastSeq: number
  generation?: number
  activeRunId?: string
  nodes: Readonly<Record<string, WorkNode>>
  order: readonly string[]
}

interface ToolPlacement {
  responseId?: string
  runId?: string
  turnId?: string
}

function terminal(status: WorkNodeStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
}

function outcomeStatus(outcome: ConversationRunOutcome | ConversationStepOutcome): WorkNodeStatus {
  if (outcome === 'completed' || outcome === 'partial') return 'completed'
  return outcome
}

export class WorkProjectionEngine {
  private nodes: Record<string, WorkNode> = {}
  private readonly toolIndex = new ToolProjectionIndex<WorkNode>()
  private order: string[] = []
  private revision = 0
  private lastSeq = 0
  private generation = 0
  private activeRunId: string | undefined
  private responseSequenceByRun = new Map<string, number>()
  private currentResponseId: string | undefined
  private currentResponseRunId: string | undefined
  private toolPlacements = new Map<string, ToolPlacement>()
  private pendingResponseChunks = new Map<string, string[]>()
  private openNodeKeys = new Set<string>()
  private pausedRuns = new Set<string>()
  private streamingToolSteps = new Map<string, string | undefined>()
  private nextOrdinal = 0

  constructor(
    private sessionId: string,
    private threadId = sessionId,
  ) {}

  getSnapshot(): WorkProjectionSnapshot {
    this.flushPendingResponses()
    return {
      schemaVersion: 1,
      sessionId: this.sessionId,
      threadId: this.threadId,
      revision: this.revision,
      lastSeq: this.lastSeq,
      generation: this.generation,
      activeRunId: this.activeRunId,
      nodes: { ...this.nodes },
      order: [...this.order],
    }
  }

  getRevision(): number {
    return this.revision
  }

  replace(events: readonly AnyConversationEvent[]): WorkProjectionSnapshot {
    this.reset(events[0]?.conversationId ?? this.sessionId, events[0]?.threadId ?? this.threadId)
    if (events[0] && events[0].seq > 1) this.lastSeq = events[0].seq - 1
    for (const event of events) this.apply(event)
    return this.getSnapshot()
  }

  activate(sessionId: string, threadId = sessionId): WorkProjectionSnapshot {
    this.reset(sessionId, threadId)
    return this.getSnapshot()
  }

  apply(event: AnyConversationEvent): boolean {
    if (event.conversationId !== this.sessionId || event.threadId !== this.threadId || event.seq <= this.lastSeq) {
      return false
    }
    if (event.seq !== this.lastSeq + 1) {
      throw new Error(`Work projection expected seq ${this.lastSeq + 1}, received ${event.seq}`)
    }
    this.lastSeq = event.seq
    this.generation = event.generation ?? this.generation
    const changed = this.applyCanonical(event)
    if (changed) this.revision += 1
    return changed
  }

  private applyCanonical(event: AnyConversationEvent): boolean {
    switch (event.type) {
      case 'conversation.activated':
        return false
      case 'run.started': {
        const changed = this.activeRunId !== event.runId
        if (this.activeRunId && this.activeRunId !== event.runId) this.releaseRun(this.activeRunId)
        this.activeRunId = event.runId || this.activeRunId
        return changed
      }
      case 'run.state_changed': {
        const paused = event.payload.state.phase === 'paused'
        if (event.runId) {
          if (paused) this.pausedRuns.add(event.runId)
          else this.pausedRuns.delete(event.runId)
          for (const key of this.openNodeKeys) {
            const node = this.nodes[key]!
            if (node.runId !== event.runId) continue
            if (paused && node.status === 'running') this.updateNode(key, event, { status: 'paused' })
            else if (!paused && node.status === 'paused') this.updateNode(key, event, { status: 'running' })
          }
        }
        return this.upsert(event, {
          key: `phase:${event.runId || this.sessionId}`,
          kind: 'phase',
          status: event.payload.state.phase === 'completed'
            ? 'completed'
            : event.payload.state.phase === 'recoverable_error'
              ? 'failed'
              : event.payload.state.phase === 'aborting'
                ? 'interrupted'
                : 'running',
          runId: event.runId,
          content: event.payload.state.detail || event.payload.state.phase,
          settled: event.payload.state.phase === 'completed' || event.payload.state.phase === 'recoverable_error',
        })
      }
      case 'run.completed': {
        const status = outcomeStatus(event.payload.outcome)
        const changed = this.settleOpenNodes(event, status, event.runId)
        const cleared = this.activeRunId === event.runId
        if (event.runId) this.releaseRun(event.runId)
        if (this.activeRunId === event.runId) this.activeRunId = undefined
        return changed || cleared
      }
      case 'turn.started': {
        const turn = event.payload.turn
        if (turn.role !== 'user') return false
        const runId = event.runId || turn.metadata?.workRunId || this.activeRunId || turn.id
        if (this.activeRunId && this.activeRunId !== runId) this.releaseRun(this.activeRunId)
        this.activeRunId = runId
        return this.upsert(event, {
          key: `input:${turn.id}`,
          kind: 'input',
          status: 'completed',
          runId,
          turnId: turn.id,
          content: turn.content,
          settled: true,
        })
      }
      case 'turn.completed': {
        const turn = event.payload.turn
        if (turn.role !== 'assistant') return false
        const runId = event.runId || turn.metadata?.workRunId || this.activeRunId
        const responseId = this.ensureResponse(runId, event.stepId, turn.id)
        const status: WorkNodeStatus = turn.metadata?.interrupted ? 'interrupted' : 'completed'
        let changed = false
        for (const kind of ['reasoning', 'answer'] as const) {
          changed = this.updateNode(`${responseId}:${kind}`, event, { status, turnId: turn.id, settled: true }) || changed
        }
        for (const toolCall of turn.toolCalls || []) {
          const response = event.stepId ? `step:${event.stepId}` : responseId
          const streamed = this.toolIndex.matching(toolCall.id, toolCall.operationIdentity, runId, response)
          if (streamed && toolCall.operationIdentity) {
            changed = this.updateNode(streamed[0], event, {
              turnId: turn.id, invocationId: toolInvocationKey(toolCall.id, toolCall.operationIdentity), toolCall,
            }) || changed
          }
          this.toolPlacements.set(toolInvocationKey(toolCall.id, toolCall.operationIdentity), {
            responseId,
            runId,
            turnId: turn.id,
          })
          // A complete model turn already declares every call. Create missing
          // slots now; later dispatch order must not reshuffle visible calls.
          changed = this.applyToolCall(event, toolCall) || changed
        }
        this.currentResponseId = undefined
        this.currentResponseRunId = undefined
        return changed
      }
      case 'step.started':
        this.currentResponseRunId = event.runId || this.activeRunId
        this.currentResponseId = this.ensureResponse(event.runId, event.stepId)
        return false
      case 'step.completed': {
        let changed = this.settleResponse(event, outcomeStatus(event.payload.outcome), event.stepId)
        for (const [key, stepId] of this.streamingToolSteps) {
          if (stepId !== event.stepId) continue
          if (event.payload.outcome !== 'completed') {
            changed = this.updateNode(key, event, {
              status: outcomeStatus(event.payload.outcome), settled: true,
            }) || changed
          }
          this.streamingToolSteps.delete(key)
        }
        return changed
      }
      case 'stream.started':
        this.ensureResponse(event.runId, event.stepId)
        return false
      case 'stream.delta':
        return this.appendResponse(event, event.payload.channel === 'thinking' ? 'reasoning' : 'answer', event.payload.text)
      case 'stream.committed': {
        const kind = event.payload.channel === 'thinking' ? 'reasoning' : 'answer'
        const responseId = this.ensureResponse(event.runId, event.stepId, event.turnId)
        const existing = this.nodes[`${responseId}:${kind}`]
        const status = existing && terminal(existing.status) ? existing.status : 'completed'
        return this.commitResponse(event, responseId, kind, event.payload.text, status, event.turnId, event.runId)
      }
      case 'stream.ended':
        return this.updateNode(
          `${this.ensureResponse(event.runId, event.stepId)}:${event.payload.channel === 'thinking' ? 'reasoning' : 'answer'}`,
          event,
          { status: event.payload.interrupted ? 'interrupted' : 'completed', settled: true },
        )
      case 'tool.delta': {
        const callId = event.payload.toolCallId
        const runId = event.runId || this.activeRunId
        const responseId = event.stepId ? `step:${event.stepId}` : undefined
        const previous = this.toolIndex.matching(callId, undefined, runId, responseId)
        if (previous?.[1].settled || !previous && this.toolIndex.hasBound(callId, runId, responseId)) return false
        const key = previous?.[0] || newToolProjectionKey(this.nodes, callId, undefined, runId, responseId, event.seq)
        this.streamingToolSteps.set(key, event.stepId)
        return this.upsert(event, {
          key,
          kind: 'tool',
          status: 'running',
          runId,
          responseId,
          callId,
          invocationId: callId,
          toolName: event.payload.toolName,
          content: event.payload.toolName,
          detail: event.payload.partialJson,
          settled: false,
        })
      }
      case 'tool.proposed':
        return this.applyToolCall(event, event.payload.toolCall)
      case 'tool.completed':
        return this.applyToolResult(event, event.payload.toolResult)
      case 'approval.requested':
        return this.upsert(event, {
          key: `approval:${event.payload.requestId}`,
          kind: 'approval',
          status: 'waiting',
          runId: event.runId,
          content: event.payload.toolName || event.payload.kind,
          detail: event.payload.question,
          settled: false,
        })
      case 'approval.resolved':
        return this.updateNode(`approval:${event.payload.requestId}`, event, {
          status: event.payload.decision === 'deny' ? 'cancelled' : 'completed',
          settled: true,
        })
      case 'approval.cancelled':
        return this.updateNode(`approval:${event.payload.requestId}`, event, {
          status: 'cancelled',
          detail: event.payload.reason,
          settled: true,
        })
      case 'input.state_changed': {
        const key = `input:${event.payload.inputId}`
        if (!this.nodes[key]) {
          return this.upsert(event, {
            key,
            kind: 'input',
            status: event.payload.state === 'committed' ? 'completed' : 'waiting',
            runId: event.runId,
            turnId: event.turnId,
            content: event.payload.text || '',
            detail: event.payload.reason,
            settled: event.payload.state === 'committed',
          })
        }
        const cancelled = event.payload.state === 'rejected' || event.payload.state === 'restored' || event.payload.state === 'removed' || event.payload.state === 'cancelled'
        return this.updateNode(key, event, {
          status: cancelled ? 'cancelled' : event.payload.state === 'committed' ? 'completed' : 'waiting',
          detail: event.payload.reason,
          settled: cancelled || event.payload.state === 'committed',
        })
      }
      default:
        return false
    }
  }

  private appendResponse(envelope: AnyConversationEvent, kind: 'reasoning' | 'answer', text: string): boolean {
    if (!text) return false
    const responseId = this.ensureResponse(envelope.runId, envelope.stepId, envelope.turnId)
    const key = `${responseId}:${kind}`
    const existing = this.nodes[key]
    if (!existing) {
      this.upsert(envelope, {
        key,
        kind,
        status: 'running',
        runId: this.currentResponseRunId || this.activeRunId,
        responseId,
        content: '',
        settled: false,
      })
    } else {
      this.nodes[key] = {
        ...existing,
        status: this.pausedRuns.has(existing.runId || '') ? 'paused' : 'running',
        settled: false,
        lastSeq: envelope.seq,
        updatedAt: envelope.at,
      }
      this.openNodeKeys.add(key)
    }
    const chunks = this.pendingResponseChunks.get(key) || []
    chunks.push(text)
    this.pendingResponseChunks.set(key, chunks)
    return true
  }

  private commitResponse(
    envelope: AnyConversationEvent,
    responseId: string,
    kind: 'reasoning' | 'answer',
    content: string,
    status: WorkNodeStatus,
    turnId: string | undefined,
    runId?: string,
  ): boolean {
    const key = `${responseId}:${kind}`
    this.pendingResponseChunks.delete(key)
    return this.upsert(envelope, {
      key,
      kind,
      status,
      runId,
      turnId,
      responseId,
      content,
      settled: true,
    })
  }

  private settleResponse(envelope: AnyConversationEvent, status: WorkNodeStatus, stepId?: string): boolean {
    const responseId = stepId ? this.ensureResponse(envelope.runId, stepId, envelope.turnId) : this.currentResponseId
    if (!responseId) return false
    let changed = false
    for (const kind of ['reasoning', 'answer'] as const) {
      changed = this.updateNode(`${responseId}:${kind}`, envelope, { status, settled: true }) || changed
    }
    return changed
  }

  private applyToolCall(envelope: AnyConversationEvent, toolCall: ToolCall): boolean {
    const invocation = toolInvocationKey(toolCall.id, toolCall.operationIdentity)
    const placement = this.toolPlacements.get(invocation)
    const runId = placement?.runId || envelope.runId || this.activeRunId
    const responseId = placement?.responseId || (envelope.stepId ? `step:${envelope.stepId}` : undefined)
    const matched = this.toolIndex.matching(toolCall.id, toolCall.operationIdentity, runId, responseId)
    const key = matched?.[0] || newToolProjectionKey(this.nodes, toolCall.id, toolCall.operationIdentity, runId, responseId, envelope.seq)
    const previous = matched?.[1]
    this.streamingToolSteps.delete(key)
    const changed = this.upsert(envelope, {
      key,
      kind: 'tool',
      status: previous?.settled ? previous.status : 'running',
      runId: previous?.runId || runId,
      turnId: toolCall.operationIdentity?.turnId || previous?.turnId || placement?.turnId || envelope.turnId,
      responseId: previous?.responseId || responseId,
      callId: toolCall.id,
      invocationId: invocation,
      toolName: toolCall.name,
      toolCall,
      content: toolCall.name,
      detail: previous?.toolResult ? previous.detail : JSON.stringify(toolCall.arguments),
      settled: previous?.settled ?? false,
    })
    this.toolPlacements.delete(invocation)
    return changed
  }

  private applyToolResult(envelope: AnyConversationEvent, result: ToolResult): boolean {
    const runId = envelope.runId || this.activeRunId
    const responseId = envelope.stepId ? `step:${envelope.stepId}` : undefined
    const matched = this.toolIndex.matching(result.toolCallId, result.operationIdentity, runId, responseId)
    const key = matched?.[0] || newToolProjectionKey(this.nodes, result.toolCallId, result.operationIdentity, runId, responseId, envelope.seq)
    const status: WorkNodeStatus = result.interruption?.kind === 'pause' ? 'interrupted' : toolResultCallStatus(result)
    if (!this.nodes[key]) {
      return this.upsert(envelope, {
        key,
        kind: 'tool',
        status,
        runId,
        responseId,
        turnId: result.operationIdentity?.turnId || envelope.turnId,
        callId: result.toolCallId,
        invocationId: toolInvocationKey(result.toolCallId, result.operationIdentity),
        toolName: result.name,
        toolResult: result,
        content: result.name,
        detail: result.output,
        settled: true,
      })
    }
    this.streamingToolSteps.delete(key)
    return this.updateNode(key, envelope, { status, detail: result.output, toolResult: result,
      turnId: result.operationIdentity?.turnId || envelope.turnId || matched?.[1].turnId,
      invocationId: toolInvocationKey(result.toolCallId, result.operationIdentity), settled: true })
  }

  private ensureResponse(runId?: string, stepId?: string, turnId?: string): string {
    if (stepId) {
      const responseId = `step:${stepId}`
      this.currentResponseRunId = runId || this.activeRunId
      this.currentResponseId = responseId
      return responseId
    }
    if (this.currentResponseId) return this.currentResponseId
    const resolvedRunId = runId || this.activeRunId || this.sessionId
    if (turnId) {
      this.currentResponseRunId = resolvedRunId
      this.currentResponseId = `turn:${turnId}:response`
      return this.currentResponseId
    }
    const sequence = (this.responseSequenceByRun.get(resolvedRunId) ?? 0) + 1
    this.responseSequenceByRun.set(resolvedRunId, sequence)
    this.currentResponseRunId = resolvedRunId
    this.currentResponseId = `run:${resolvedRunId}:response:${sequence}`
    return this.currentResponseId
  }

  private upsert(
    envelope: AnyConversationEvent,
    input: Omit<WorkNode, 'anchorSeq' | 'lastSeq' | 'ordinal' | 'startedAt' | 'updatedAt' | 'completedAt'>,
  ): boolean {
    if (input.status === 'running' && this.pausedRuns.has(input.runId || '')) {
      input = { ...input, status: 'paused' }
    }
    const existing = this.nodes[input.key]
    if (existing) {
      this.nodes[input.key] = {
        ...existing,
        ...input,
        lastSeq: envelope.seq,
        updatedAt: envelope.at,
        completedAt: input.settled ? existing.completedAt ?? envelope.at : existing.completedAt,
      }
      this.toolIndex.upsert(input.key, this.nodes[input.key]!)
      this.trackNodeSettlement(input.key, input.settled)
      return true
    }
    const ordinal = ++this.nextOrdinal
    const node: WorkNode = {
      ...input,
      anchorSeq: envelope.seq,
      lastSeq: envelope.seq,
      ordinal,
      startedAt: envelope.at,
      updatedAt: envelope.at,
      completedAt: input.settled ? envelope.at : undefined,
    }
    this.nodes[input.key] = node
    this.toolIndex.upsert(input.key, node)
    this.trackNodeSettlement(input.key, input.settled)
    this.order.push(input.key)
    return true
  }

  private updateNode(key: string, envelope: AnyConversationEvent, patch: Partial<WorkNode>): boolean {
    const existing = this.nodes[key]
    if (!existing) return false
    const settled = patch.settled ?? existing.settled
    this.nodes[key] = {
      ...existing,
      ...patch,
      lastSeq: envelope.seq,
      updatedAt: envelope.at,
      completedAt: settled ? existing.completedAt ?? envelope.at : existing.completedAt,
    }
    this.toolIndex.upsert(key, this.nodes[key]!)
    this.trackNodeSettlement(key, settled)
    return true
  }

  private settleOpenNodes(envelope: AnyConversationEvent, status: WorkNodeStatus, runId = this.activeRunId): boolean {
    let changed = false
    for (const key of [...this.openNodeKeys]) {
      const node = this.nodes[key]
      if (!node || (runId && node.runId !== runId)) continue
      this.nodes[key] = {
        ...node,
        status,
        settled: true,
        lastSeq: envelope.seq,
        updatedAt: envelope.at,
        completedAt: envelope.at,
      }
      this.toolIndex.upsert(key, this.nodes[key]!)
      this.openNodeKeys.delete(key)
      changed = true
    }
    return changed
  }

  private trackNodeSettlement(key: string, settled: boolean): void {
    if (settled) this.openNodeKeys.delete(key)
    else this.openNodeKeys.add(key)
  }

  private flushPendingResponses(): void {
    for (const [key, chunks] of this.pendingResponseChunks) {
      const existing = this.nodes[key]
      if (existing && chunks.length > 0) {
        this.nodes[key] = { ...existing, content: `${existing.content}${chunks.join('')}` }
      }
    }
    this.pendingResponseChunks.clear()
  }

  private releaseRun(runId: string): void {
    this.pausedRuns.delete(runId)
    for (const key of this.streamingToolSteps.keys()) {
      if (this.nodes[key]?.runId === runId) this.streamingToolSteps.delete(key)
    }
    this.responseSequenceByRun.delete(runId)
    for (const [callId, placement] of this.toolPlacements) {
      if (placement.runId === runId) this.toolPlacements.delete(callId)
    }
    if (this.currentResponseRunId === runId) {
      this.currentResponseId = undefined
      this.currentResponseRunId = undefined
    }
  }

  private reset(sessionId: string, threadId: string): void {
    this.sessionId = sessionId
    this.threadId = threadId
    this.nodes = {}
    this.toolIndex.clear()
    this.order = []
    this.revision = 0
    this.lastSeq = 0
    this.generation = 0
    this.activeRunId = undefined
    this.responseSequenceByRun.clear()
    this.currentResponseId = undefined
    this.currentResponseRunId = undefined
    this.toolPlacements.clear()
    this.pendingResponseChunks.clear()
    this.openNodeKeys.clear()
    this.pausedRuns.clear()
    this.streamingToolSteps.clear()
    this.nextOrdinal = 0
  }
}
