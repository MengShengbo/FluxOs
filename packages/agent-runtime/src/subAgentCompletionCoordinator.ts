import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import type { AgentTurn } from '@fluxos/contracts/agentTypes'
import path from 'node:path'
import type { SubAgentEvidence } from '@fluxos/contracts/subAgentTypes'

export type SubAgentCompletionStatus = 'completed' | 'failed' | 'stopped' | 'interrupted'
export type SubAgentJoinPolicy = 'required' | 'detached'

export interface SubAgentCompletionStats {
  turns: number
  modelRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  toolExecutions: number
  protocolFallbacks: number
  retries: number
}

export interface SubAgentCompletionResult {
  id: string
  agentId: string
  agentType: string
  objective: string
  ownerSessionId?: string
  workRunId?: string
  stepId?: string
  status: SubAgentCompletionStatus
  finalText?: string
  error?: string
  evidence: SubAgentEvidence[]
  turns: number
  elapsedMs: number
  completedAt: number
  joinPolicy: SubAgentJoinPolicy
  stats: SubAgentCompletionStats
}

export interface SubAgentCompletionDelivery {
  id: string
  ownerSessionId: string
  workRunId: string
  completionIds: string[]
  turn: AgentTurn
}

type CompletionJournalRecord =
  | { version: 1; type: 'completion'; completion: SubAgentCompletionResult }
  | { version: 1; type: 'delivered'; completionId: string; deliveredAt: number }
  | { version: 2; type: 'delivery'; delivery: SubAgentCompletionDelivery }

export interface SubAgentCompletionTakeOptions {
  ownerSessionId?: string
  workRunId?: string
  maxResults?: number
  maxBytes?: number
}

export interface SubAgentCompletionCoordinatorOptions {
  storageDir?: string | false
  now?: () => number
  maxPendingResults?: number
  maxPendingBytes?: number
}

function completionBytes(completion: SubAgentCompletionResult): number {
  try {
    return Buffer.byteLength(JSON.stringify(completion))
  } catch {
    return 0
  }
}

export class SubAgentCompletionCoordinator {
  private storageDir: string | null
  private journalPath: string | null
  private readonly maxPendingResults: number
  private readonly maxPendingBytes: number
  private completions = new Map<string, SubAgentCompletionResult>()
  private completionSizes = new Map<string, number>()
  private delivered = new Set<string>()
  private deliveries = new Map<string, SubAgentCompletionDelivery>()

  constructor(options: SubAgentCompletionCoordinatorOptions = {}) {
    this.maxPendingResults = Math.max(1, Math.floor(options.maxPendingResults || 64))
    this.maxPendingBytes = Math.max(1024, Math.floor(options.maxPendingBytes || 512 * 1024))
    this.storageDir = null
    this.journalPath = null
    this.switchStorage(options.storageDir === false ? false : options.storageDir)
  }

  switchStorage(storageDir?: string | false): void {
    this.completions.clear()
    this.completionSizes.clear()
    this.delivered.clear()
    this.deliveries.clear()
    this.storageDir = storageDir === false ? null : storageDir || null
    this.journalPath = this.storageDir ? path.join(this.storageDir, 'subagent-completions.jsonl') : null
    if (this.storageDir) mkdirSync(this.storageDir, { recursive: true })
    this.recover()
  }

  private recover(): void {
    if (!this.journalPath || !existsSync(this.journalPath)) return
    const content = readFileSync(this.journalPath, 'utf8')
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line) as CompletionJournalRecord
        if (record.version === 2 && record.type === 'delivery') {
          this.applyDelivery(record.delivery)
          continue
        }
        if (record.version !== 1) continue
        if (record.type === 'completion' && record.completion?.id) {
          if (this.delivered.has(record.completion.id) || this.completions.has(record.completion.id)) continue
          this.completions.set(record.completion.id, record.completion)
          this.completionSizes.set(record.completion.id, completionBytes(record.completion))
        } else if (record.type === 'delivered' && record.completionId) {
          this.delivered.add(record.completionId)
          this.completions.delete(record.completionId)
          this.completionSizes.delete(record.completionId)
        }
      } catch {
        continue
      }
    }
  }

  enqueue(completion: SubAgentCompletionResult): boolean {
    if (this.delivered.has(completion.id) || this.completions.has(completion.id)) return false
    this.append({ version: 1, type: 'completion', completion })
    this.completions.set(completion.id, completion)
    this.completionSizes.set(completion.id, completionBytes(completion))
    return true
  }

  listPending(ownerSessionId?: string, workRunId?: string): SubAgentCompletionResult[] {
    return [...this.completions.values()]
      .filter(completion => ownerSessionId === undefined || completion.ownerSessionId === ownerSessionId)
      .filter(completion => workRunId === undefined || completion.workRunId === workRunId)
      .sort((left, right) => left.completedAt - right.completedAt || left.id.localeCompare(right.id))
  }

  pendingBytes(ownerSessionId?: string, workRunId?: string): number {
    return this.listPending(ownerSessionId, workRunId)
      .reduce((total, completion) => total + (this.completionSizes.get(completion.id) || 0), 0)
  }

  hasCapacity(): boolean {
    return this.completions.size < this.maxPendingResults && this.pendingBytes() < this.maxPendingBytes
  }

  take(options: SubAgentCompletionTakeOptions = {}): SubAgentCompletionResult[] {
    const maxResults = Math.max(1, Math.floor(options.maxResults || 8))
    const maxBytes = Math.max(1024, Math.floor(options.maxBytes || 24_000))
    const selected: SubAgentCompletionResult[] = []
    let bytes = 0
    for (const completion of this.listPending(options.ownerSessionId, options.workRunId)) {
      if (selected.length >= maxResults) break
      const size = this.completionSizes.get(completion.id) || completionBytes(completion)
      if (selected.length > 0 && bytes + size > maxBytes) continue
      selected.push(completion)
      bytes += size
    }
    return selected
  }

  /** Persist the parent context and its acknowledgement in ONE durable record.
   * Dequeue alone is deliberately non-destructive. A crash at any boundary
   * leaves either the completion pending or this replayable parent turn.
   */
  commitDelivery(delivery: SubAgentCompletionDelivery): void {
    if (this.deliveries.has(delivery.id)) return
    if (!delivery.completionIds.length || new Set(delivery.completionIds).size !== delivery.completionIds.length
      || delivery.turn.id !== delivery.id || delivery.turn.metadata?.workRunId !== delivery.workRunId
      || delivery.turn.metadata?.internalKind !== 'subagent_completion'
      || delivery.turn.metadata?.internal !== true
      || JSON.stringify(delivery.turn.metadata.subAgentCompletionIds) !== JSON.stringify(delivery.completionIds)
      || !delivery.turn.metadata.runtimeContext) {
      throw new Error('Invalid durable subagent delivery context')
    }
    for (const id of delivery.completionIds) {
      const completion = this.completions.get(id)
      if (!completion || completion.ownerSessionId !== delivery.ownerSessionId || completion.workRunId !== delivery.workRunId) {
        throw new Error('Completion delivery does not belong to this parent run: ' + id)
      }
    }
    this.append({ version: 2, type: 'delivery', delivery })
    this.applyDelivery(delivery)
  }

  listDeliveries(ownerSessionId: string, workRunId: string): SubAgentCompletionDelivery[] {
    return [...this.deliveries.values()]
      .filter(delivery => delivery.ownerSessionId === ownerSessionId && delivery.workRunId === workRunId)
      .map(delivery => structuredClone(delivery))
  }

  private applyDelivery(delivery: SubAgentCompletionDelivery): void {
    this.deliveries.set(delivery.id, structuredClone(delivery))
    for (const completionId of delivery.completionIds) {
      this.delivered.add(completionId)
      this.completions.delete(completionId)
      this.completionSizes.delete(completionId)
    }
  }

  private append(record: CompletionJournalRecord): void {
    if (!this.journalPath) return
    // Prefix a newline so a torn final record cannot swallow a later append.
    // Surface disk failures: an in-memory acknowledgement is not durability.
    appendFileSync(this.journalPath, '\n' + JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600, flush: true })
  }

  destroy(): void {
    this.completions.clear()
    this.completionSizes.clear()
    this.delivered.clear()
    this.deliveries.clear()
    this.journalPath = null
    this.storageDir = null
  }
}
