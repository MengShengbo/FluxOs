import type { ModelRequestRecord } from '@fluxos/contracts/agentTypes'
import { isModelRequestRecord, mergeModelRequest, summarizeModelRequests } from '@fluxos/contracts/modelUsage'
import type { SubAgentCompletionStats } from './subAgentCompletionCoordinator'

/** Same reducer for live events and durable transcript recovery. */
export class SubAgentTelemetry {
  private readonly requests = new Map<string, ModelRequestRecord>()
  private readonly turns = new Map<number, Record<string, unknown>>()
  private readonly tools = new Set<string>()
  private anonymousTools = 0
  private responses = 0
  private retries = 0
  private protocolFallbacks = 0

  record(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const event = value as Record<string, unknown>
    if (event.type === 'model_request' && isModelRequestRecord(event.request)) {
      this.requests.set(event.request.id, mergeModelRequest(this.requests.get(event.request.id), event.request))
    } else if (event.type === 'model_response') this.responses++
    else if (event.type === 'model_retry') {
      this.retries++
      if (/Protocol fallback/i.test(String(event.reason || ''))) this.protocolFallbacks++
    } else if (event.type === 'tool_result') {
      if (typeof event.toolCallId === 'string') this.tools.add(event.toolCallId)
      else this.anonymousTools++
    } else if (event.type === 'turn_complete') {
      const turn = Number(event.turn)
      if (Number.isFinite(turn) && turn >= 0) this.turns.set(turn, { ...event })
    }
  }

  snapshot(): SubAgentCompletionStats {
    const usage = summarizeModelRequests([...this.requests.values()])
    const sum = (field: string) => [...this.turns.values()].reduce((total, turn) => {
      const value = Number(turn[field] || 0)
      return total + (Number.isFinite(value) && value > 0 ? value : 0)
    }, 0)
    const turns = Math.max(0, ...this.turns.keys())
    const hasRequests = this.requests.size > 0
    const groups = new Map<string, ModelRequestRecord[]>()
    for (const request of this.requests.values()) {
      const group = groups.get(request.requestId) || []
      group.push(request)
      groups.set(request.requestId, group)
    }
    const retries = [...groups.values()].reduce((total, group) => total + Math.max(0, group.length - 1), 0)
    const fallbacks = [...groups.values()].reduce((total, group) => total + Math.max(0, new Set(group.map(request => request.protocol).filter(Boolean)).size - 1), 0)
    return {
      turns, modelRequests: hasRequests ? usage.attempts : Math.max(this.responses, turns),
      inputTokens: hasRequests ? usage.totals.input : sum('inputTokens'),
      outputTokens: hasRequests ? usage.totals.output : sum('outputTokens'),
      cacheReadTokens: hasRequests ? usage.totals.cached : sum('cacheReadTokens'),
      reasoningTokens: hasRequests ? usage.totals.reasoning : sum('reasoningTokens'),
      toolExecutions: this.tools.size + this.anonymousTools,
      retries: hasRequests ? retries : this.retries,
      protocolFallbacks: hasRequests ? fallbacks : this.protocolFallbacks,
    }
  }
}
