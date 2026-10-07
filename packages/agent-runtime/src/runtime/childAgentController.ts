import { toolCallSignature } from '../toolExecutionLedger'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeFileAtomicSync } from '@fluxos/platform/fileIO'
import { redactComputerTurns, redactComputerContextSegments, redactComputerReservoir } from '@fluxos/contracts/computerPrivacy'
import { AGENT_COLORS, normalizeChildName, type ChildAgentSnapshot, type ChildAgentDetail, type ChildTranscriptItem, type ChildCapabilityMode } from '@fluxos/contracts/childAgentTypes'
import type { AgentTurn, AgentConfig, CapabilityProfile, NativeReasoningConfig } from '@fluxos/contracts/agentTypes'
import type { APIConfig, ContextSegment, ContextReservoirEntry } from '@fluxos/contracts/stateTypes'
import type { AgentEventType, AgentEngine } from '../agentEngine'
import type { SubAgentResult } from '@fluxos/contracts/subAgentTypes'
import { childMessageBatch, enqueueChildMessage, messageReceipt, reconcileChildMessages, type ChildMessageOptions, type StoredChildMessage } from './childAgentMailbox'
import type { ChildAgentMessageReceipt } from '@fluxos/contracts/childAgentTypes'

export interface ChildRuntimeHandle {
  engine: AgentEngine
  destroy(): Promise<void>
  configure?(launch: ChildLaunch): void
}
export interface ChildLaunch {
  agentId: string
  executionId: string
  ownerSessionId: string
  name: string
  roleId: string
  roleLabel: string
  mode: ChildCapabilityMode
  capabilityProfile: CapabilityProfile
  objective: string
  instructions: string
  model: string
  reasoning?: NativeReasoningConfig
  parentConfig: AgentConfig
  limits?: { maxToolRounds: number; maxParallelTools: number; maxOutputTokens?: number; requestTimeoutMs?: number }
  requiredToolCalls?: Record<string, number>
  modelConfig: APIConfig
}
interface ChildRecord {
  schemaVersion: 2
  snapshot: ChildAgentSnapshot
  turns: AgentTurn[]
  segments?: ContextSegment[]
  reservoir?: ContextReservoirEntry[]
  items: ChildTranscriptItem[]
  messages: StoredChildMessage[]
  instructions: string
}
interface LiveChild { runtime: ChildRuntimeHandle; unsubscribe: () => void }

/** Owns reusable child identities and durable transcripts. Each execution still
 * uses the existing SubAgentTaskManager for run ownership, budgets and delivery.
 */
export class ChildAgentController {
  private readonly records = new Map<string, ChildRecord>()
  private readonly live = new Map<string, LiveChild>()
  private readonly leases = new Set<string>()
  private destroyed = false
  private destroyPromise: Promise<void> | null = null
  private readonly closing = new Map<string, Promise<void>>()
  constructor(
    private readonly storageRoot: string,
    private readonly createRuntime: (launch: ChildLaunch) => ChildRuntimeHandle,
    private readonly changed: (snapshot: ChildAgentSnapshot) => void,
  ) { mkdirSync(storageRoot, { recursive: true }); this.restore() }

  list(ownerSessionId: string): ChildAgentSnapshot[] {
    return [...this.records.values()].filter(record => record.snapshot.ownerSessionId === ownerSessionId).map(record => structuredClone(record.snapshot))
  }

  get(agentId: string, ownerSessionId: string): ChildAgentSnapshot {
    return structuredClone(this.require(agentId, ownerSessionId).snapshot)
  }

  assertNameAvailable(name: string, ownerSessionId: string, agentId?: string): void {
    const normalized = normalizeChildName(name)
    if (this.list(ownerSessionId).some(agent => agent.agentId !== agentId && agent.name === normalized)) throw new Error('Another child already has this name: ' + normalized)
  }

  read(agentId: string, ownerSessionId: string, cursor = 0, limit = 40): ChildAgentDetail {
    const record = this.require(agentId, ownerSessionId)
    const start = Math.max(0, Math.floor(Number.isFinite(cursor) ? cursor : 0))
    const count = Math.max(1, Math.min(100, Math.floor(limit) || 40))
    const items: ChildTranscriptItem[] = []
    let bytes = 0
    for (const item of record.items.slice(start, start + count)) {
      const size = Buffer.byteLength(JSON.stringify(item))
      if (items.length && bytes + size > 256000) break
      items.push(item); bytes += size
    }
    return { agent: structuredClone(record.snapshot), messages: record.messages.map(messageReceipt), items: structuredClone(items), total: record.items.length,
      nextCursor: start + items.length < record.items.length ? start + items.length : undefined }
  }

  async execute(launch: ChildLaunch, signal: AbortSignal, progress: (event: AgentEventType) => void): Promise<SubAgentResult> {
    if (this.destroyed) throw new Error('Child agent controller is shutting down')
    if (this.closing.has(launch.agentId)) throw new Error('Child session is closing')
    if (this.leases.has(launch.agentId)) throw new Error('Child agent is already starting or running')
    let record = this.records.get(launch.agentId)
    if (record) {
      this.require(launch.agentId, launch.ownerSessionId)
      if (record.snapshot.state !== 'idle') throw new Error('Child agent is not idle: ' + record.snapshot.name)
      if (record.snapshot.mode !== launch.mode || ['read-only', 'workspace-write', 'danger-full-access'].indexOf(launch.capabilityProfile) > ['read-only', 'workspace-write', 'danger-full-access'].indexOf(record.snapshot.effectiveCapabilityProfile)) {
        throw new Error('Child permissions cannot be widened; create a new child with the current authority.')
      }
    } else {
      this.assertNameAvailable(launch.name, launch.ownerSessionId)
      record = { schemaVersion: 2, snapshot: {
        agentId: launch.agentId, ownerSessionId: launch.ownerSessionId, name: normalizeChildName(launch.name),
        roleId: launch.roleId, roleLabel: launch.roleLabel,
        color: AGENT_COLORS[this.list(launch.ownerSessionId).length % AGENT_COLORS.length],
        mode: launch.mode, effectiveCapabilityProfile: launch.capabilityProfile,
        state: 'idle', createdAt: Date.now(), updatedAt: Date.now(), revision: 0,
        model: launch.model, reasoning: launch.reasoning, pendingRequests: [],
      }, turns: [], items: [], messages: [], instructions: launch.instructions }
      this.save(record)
      this.records.set(launch.agentId, record)
    }
    this.leases.add(launch.agentId)
    try {
    let handle = this.live.get(launch.agentId)
    if (!handle) {
      let runtime: ChildRuntimeHandle
      try { runtime = this.createRuntime({ ...launch, instructions: record.instructions }) }
      catch (error) { this.leases.delete(launch.agentId); record.snapshot.lastOutcome = 'failed'; record.snapshot.error = String(error); this.save(record); throw error }
      if (record.turns.length) runtime.engine.restoreFromTurns(record.turns, { emitRunState: false, emitRuntimeEvents: false })
      runtime.engine.setContextSegments(record.segments || [])
      runtime.engine.setContextReservoir(record.reservoir || [])
      handle = { runtime, unsubscribe: () => {} }
      this.live.set(launch.agentId, handle)
    }
    handle.runtime.configure?.(launch)
    const child = handle.runtime.engine
    record.snapshot = { ...record.snapshot, state: 'running', effectiveCapabilityProfile: launch.capabilityProfile, executionId: launch.executionId, model: launch.model, reasoning: launch.reasoning,
      error: undefined, finalText: undefined, pendingRequests: [] }
    this.save(record)
    const startedAt = Date.now()
    let modelTurns = 0
    let lastStreamNotice = 0
    const calls = new Map<string, { name: string; signature: string }>()
    const successfulCalls = new Map<string, Set<string>>()
    const requestTimers = new Map<string, ReturnType<typeof setTimeout>>()
    let requestDeadlineError: Error | undefined
    const publish = (event: AgentEventType) => {
      if (event.type === 'model:request') {
        const request = event.request
        const timeoutMs = launch.limits?.requestTimeoutMs
        if (request.status !== 'running') {
          clearTimeout(requestTimers.get(request.id))
          requestTimers.delete(request.id)
        } else if (timeoutMs && timeoutMs > 0 && !requestTimers.has(request.id)) {
          requestTimers.set(request.id, setTimeout(() => {
            requestDeadlineError = new Error('Child model request timed out after ' + timeoutMs + 'ms')
            try { child.abort() } catch (error) { record!.snapshot.error = String(error) }
          }, timeoutMs))
        }
      }
      if (event.type === 'tool:call') calls.set(event.toolCall.id, { name: event.toolCall.name, signature: toolCallSignature(event.toolCall) })
      if (event.type === 'tool:result' && !event.toolResult.isError) {
        const call = calls.get(event.toolResult.toolCallId)
        if (call) {
          const signatures = successfulCalls.get(call.name) || new Set<string>()
          signatures.add(call.signature)
          successfulCalls.set(call.name, signatures)
        }
      }
      if (event.type === 'stream:start') record!.snapshot.streamingText = ''
      if (event.type === 'stream:delta') {
        record!.snapshot.streamingText = ((record!.snapshot.streamingText || '') + event.text).slice(-16000)
        if (Date.now() - lastStreamNotice > 150) { record!.snapshot.revision++; lastStreamNotice = Date.now(); this.changed(structuredClone(record!.snapshot)) }
      }
      if (event.type === 'turn:complete') record!.snapshot.streamingText = undefined
      if (event.type === 'turn:start' || event.type === 'turn:complete') {
        if (!event.turn.metadata?.internal) this.item(record!, launch.executionId, { kind: 'message', turn: redactComputerTurns([event.turn])[0]! })
        if (event.type === 'turn:complete' && event.turn.role === 'assistant') modelTurns++
      } else if (event.type === 'tool:call') {
        // Computer payloads are redacted by the same contract used by root history.
        const safe = redactComputerTurns([{ id: event.toolCall.id, role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [event.toolCall] }])[0]!
        this.item(record!, launch.executionId, { kind: 'tool_call', toolCall: safe.toolCalls![0]! })
      } else if (event.type === 'tool:result') {
        const safe = redactComputerTurns([{ id: event.toolResult.toolCallId, role: 'tool_result', content: '', timestamp: Date.now(), toolResults: [event.toolResult] }])[0]!
        this.item(record!, launch.executionId, { kind: 'tool_result', toolResult: safe.toolResults![0]! })
      } else if (event.type === 'run:state') {
        record!.snapshot.lastActivity = event.state.detail || event.state.phase
        this.item(record!, launch.executionId, { kind: 'status', phase: event.state.phase, detail: event.state.detail })
      } else if (event.type === 'ask:user' && event.requestId) {
        record!.snapshot.pendingRequests.push({ id: event.requestId, question: event.question, options: event.options, kind: event.toolName ? 'permission' : 'question' })
      } else if (event.type === 'approval:state' && event.state !== 'requested') {
        record!.snapshot.pendingRequests = record!.snapshot.pendingRequests.filter(request => request.id !== event.requestId)
      }
      if (['turn:start', 'turn:complete', 'tool:call', 'tool:result', 'ask:user', 'approval:state', 'input:state', 'context:compaction_completed'].includes(event.type)) {
        const previousTurns = record!.turns
        const previousMessages = record!.messages
        record!.turns = redactComputerTurns(child.getSession().turns)
        record!.messages = reconcileChildMessages(record!.messages, record!.turns)
        record!.segments = redactComputerContextSegments(child.getContextSegments(), child.getFullConversationTurns())
        record!.reservoir = redactComputerReservoir(child.getContextReservoir())
        try { this.save(record!) }
        catch (error) { record!.turns = previousTurns; record!.messages = previousMessages; throw error }
      }
      progress(event)
    }
    handle.unsubscribe = child.subscribe(publish)
    const abort = () => child.abort()
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      const queuedMessages = childMessageBatch(record.messages)
      const run = child.run(launch.objective, { userTurnId: launch.executionId })
      // run() registers ownership synchronously. Each queued message becomes its own
      // identified user turn at the existing steering boundary, with an atomic receipt.
      try {
        for (const message of queuedMessages) child.submitSteeringMessage(message.message!, message.messageId)
      } catch (error) {
        // Do not release execution ownership while a failed observer leaves run() alive.
        try { child.abort() } finally { await run.catch(() => {}) }
        throw error
      }
      const turns = await run
      const text = [...turns].reverse().find(turn => turn.role === 'assistant' && !turn.metadata?.internal)?.content || ''
      const outcome = child.getWorkExecutionSnapshot().runs.find(run => run.id === launch.executionId)?.status
      const missing = Object.entries(launch.requiredToolCalls || {}).filter(([name, count]) => (successfulCalls.get(name)?.size || 0) < count)
      const acceptanceError = missing.length ? 'Required successful tool calls missing: ' + missing.map(([name, count]) => name + ' (' + (successfulCalls.get(name)?.size || 0) + '/' + count + ')').join(', ') : undefined
      const ok = outcome === 'completed' && Boolean(text) && !acceptanceError && !requestDeadlineError
      record.snapshot.lastOutcome = requestDeadlineError ? 'failed' : ok ? 'completed' : signal.aborted ? 'interrupted' : 'partial'
      record.snapshot.finalText = text
      record.snapshot.error = ok ? undefined : requestDeadlineError?.message || acceptanceError || 'Child work did not complete fully'
      return { ok, finalText: text, turns: modelTurns, elapsedMs: Date.now() - startedAt, truncated: !ok, error: record.snapshot.error, evidence: [] }
    } catch (error) {
      record.snapshot.lastOutcome = requestDeadlineError ? 'failed' : signal.aborted || (error as { aborted?: boolean })?.aborted === true ? 'interrupted' : 'failed'
      record.snapshot.error = requestDeadlineError?.message || (error instanceof Error ? error.message : String(error))
      throw requestDeadlineError || error
    } finally {
      for (const timer of requestTimers.values()) clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      handle.unsubscribe()
      record.turns = redactComputerTurns(child.getSession().turns)
      record.messages = reconcileChildMessages(record.messages, record.turns)
      record.segments = redactComputerContextSegments(child.getContextSegments(), child.getFullConversationTurns())
      record.reservoir = redactComputerReservoir(child.getContextReservoir())
      record.snapshot.streamingText = undefined
      if (!this.closing.has(launch.agentId)) record.snapshot.state = 'idle'
      record.snapshot.pendingRequests = []
      this.save(record)
    }
    } finally { this.leases.delete(launch.agentId) }
  }

  message(agentId: string, ownerSessionId: string, message: string, options: ChildMessageOptions = {}): ChildAgentMessageReceipt {
    if (this.destroyed) throw new Error('Child agent controller is shutting down')
    const record = this.require(agentId, ownerSessionId)
    if (record.snapshot.state === 'closed') throw new Error('Child agent is closed')
    if (options.messageId && !record.messages.some(item => item.messageId === options.messageId)
      && record.turns.some(turn => turn.id === options.messageId)) {
      throw new Error('message_id conflicts with an existing transcript turn')
    }
    const queued = enqueueChildMessage(record.messages, message, options)
    if (queued.duplicate) return queued.receipt
    const previous = record.messages
    record.messages = queued.messages
    try { this.save(record) }
    catch (error) { record.messages = previous; throw error }
    if (record.snapshot.state === 'running') this.live.get(agentId)?.runtime.engine.submitSteeringMessage(message, queued.receipt.messageId)
    return messageReceipt(record.messages.find(item => item.messageId === queued.receipt.messageId)!)
  }

  interrupt(agentId: string, ownerSessionId: string): void {
    this.require(agentId, ownerSessionId)
    this.live.get(agentId)?.runtime.engine.abort()
  }
  respond(agentId: string, ownerSessionId: string, requestId: string, response: string): boolean {
    const record = this.require(agentId, ownerSessionId)
    if (!record.snapshot.pendingRequests.some(request => request.id === requestId)) return false
    return this.live.get(agentId)?.runtime.engine.submitAskUserResponse(response, requestId) || false
  }
  close(agentId: string, ownerSessionId: string): Promise<void> {
    const record = this.require(agentId, ownerSessionId)
    const existing = this.closing.get(agentId)
    if (existing) return existing
    if (record.snapshot.state === 'closed') return Promise.resolve()
    // Fence admission synchronously. execute() must never reopen this identity.
    const live = this.live.get(agentId)
    const closing = Promise.resolve().then(async () => {
      try { await live?.runtime.destroy() }
      finally {
        live?.unsubscribe()
        this.live.delete(agentId)
        record.snapshot.state = 'closed'
        record.snapshot.pendingRequests = []
        this.save(record)
      }
    })
    this.closing.set(agentId, closing)
    record.snapshot.state = 'closed'
    this.save(record)
    return closing
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise
    this.destroyed = true
    this.destroyPromise = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        ...this.closing.values(),
        ...[...this.live.entries()].filter(([id]) => !this.closing.has(id)).map(async ([, child]) => {
          try { await child.runtime.destroy() } finally { child.unsubscribe() }
        }),
      ])
      this.live.clear()
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Child runtime shutdown failed')
    })
    return this.destroyPromise
  }
  private require(agentId: string, ownerSessionId: string): ChildRecord {
    const record = this.records.get(agentId)
    if (!record || record.snapshot.ownerSessionId !== ownerSessionId) throw new Error('Child agent not found in this conversation')
    return record
  }
  private item(record: ChildRecord, executionId: string, item: Omit<Extract<ChildTranscriptItem, { kind: 'message' }>, 'id' | 'sequence' | 'executionId' | 'timestamp'> | Omit<Extract<ChildTranscriptItem, { kind: 'tool_call' }>, 'id' | 'sequence' | 'executionId' | 'timestamp'> | Omit<Extract<ChildTranscriptItem, { kind: 'tool_result' }>, 'id' | 'sequence' | 'executionId' | 'timestamp'> | { kind: 'status'; phase: string; detail?: string }): void {
    const sequence = record.items.length
    record.items.push({ ...item, id: record.snapshot.agentId + ':' + sequence, sequence, executionId, timestamp: Date.now() } as ChildTranscriptItem)
  }
  private file(agentId: string): string { return join(this.storageRoot, createHash('sha256').update(agentId).digest('hex') + '.json') }
  private save(record: ChildRecord): void {
    record.snapshot.revision++
    record.snapshot.updatedAt = Date.now()
    writeFileAtomicSync(this.file(record.snapshot.agentId), JSON.stringify(record), 0o600)
    this.changed(structuredClone(record.snapshot))
  }
  private restore(): void {
    for (const filename of readdirSync(this.storageRoot)) {
      if (!filename.endsWith('.json')) continue
      const record = JSON.parse(readFileSync(join(this.storageRoot, filename), 'utf8')) as ChildRecord
      if (record.schemaVersion !== 2 || !record.snapshot?.agentId) continue
      record.messages = reconcileChildMessages(record.messages, record.turns)
      if (record.snapshot.state === 'running') {
        record.snapshot.state = 'idle'; record.snapshot.lastOutcome = 'interrupted'
        record.snapshot.error = 'The application stopped before this child turn completed. Inspect history before continuing.'
        record.snapshot.pendingRequests = []
      }
      // Repair a crash between a durable tool result and the next model turn.
      // Never re-execute uncertain writes merely to manufacture a result.
      const results = new Map(record.items.flatMap(item => item.kind === 'tool_result' ? [[item.toolResult.toolCallId, item.toolResult] as const] : []))
      const paired = new Set(record.turns.flatMap(turn => turn.toolResults?.map(result => result.toolCallId) || []))
      record.turns = record.turns.flatMap(turn => {
        const missing = (turn.toolCalls || []).filter(call => !paired.has(call.id)).map(call => results.get(call.id) || {
          toolCallId: call.id, name: call.name, isError: true, errorKind: 'abort' as const,
          output: 'Execution was interrupted before its result was durably recorded. Inspect existing effects before retrying.',
        })
        return missing.length ? [turn, { id: turn.id + ':recovered-results', role: 'tool_result' as const, content: '', timestamp: turn.timestamp + 1, toolResults: missing }] : [turn]
      })
      this.records.set(record.snapshot.agentId, record)
    }
  }
}
