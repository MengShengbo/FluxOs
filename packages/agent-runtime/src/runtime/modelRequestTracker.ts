import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { ModelRequestRecord, TokenUsage } from '@fluxos/contracts/agentTypes'

export interface ModelRequestHandle {
  readonly record: ModelRequestRecord
  usage(usage: TokenUsage): void
  responseId(id: string): void
  outputChunk(channel: 'answer' | 'reasoning' | 'tool', nonEmpty: boolean): void
  finish(status: ModelRequestRecord['status'], httpStatus?: number): ModelRequestRecord
}

export class ModelRequestTracker {
  constructor(private readonly emit: (record: ModelRequestRecord) => void) {}

  begin(input: {
    requestId: string; runId?: string; model: string; provider: string;
    protocol: NonNullable<ModelRequestRecord['protocol']>; purpose: ModelRequestRecord['purpose']; serializedBody: string;
  }): ModelRequestHandle {
    const clock = performance.now()
    const at = Date.now()
    const record: ModelRequestRecord = {
      id: randomUUID(), requestId: input.requestId, runId: input.runId,
      model: input.model, provider: input.provider, protocol: input.protocol, purpose: input.purpose,
      status: 'running', startedAt: at, updatedAt: at,
      requestFingerprint: createHash('sha256').update(input.serializedBody).digest('hex'),
      usage: { source: 'unknown' }, usageFinal: false,
      requestSettings: requestSettings(input.serializedBody),
    }
    const publish = () => this.emit(structuredClone(record))
    publish()
    return {
      record,
      usage: usage => {
        if (record.status !== 'running') return
        record.usage = { ...record.usage, ...usage }
        record.updatedAt = Math.max(record.updatedAt, Date.now())
        publish()
      },
      responseId: id => { if (record.status === 'running') record.providerResponseId = id },
      outputChunk: (channel, nonEmpty) => {
        if (!nonEmpty || record.status !== 'running') return
        const timing = record.outputTiming ??= {}
        const key = channel === 'answer' ? 'firstAnswerChunkMs' : channel === 'reasoning' ? 'firstReasoningChunkMs' : 'firstToolCallChunkMs'
        if (timing[key] !== undefined) return
        const elapsed = Math.max(0, performance.now() - clock)
        timing[key] = elapsed
        timing.firstOutputChunkMs ??= elapsed
        // Included in existing usage/terminal updates; never emit one event per chunk.
      },
      finish: (status, httpStatus) => {
        if (record.status !== 'running') return structuredClone(record)
        record.status = status
        record.updatedAt = Math.max(record.updatedAt, Date.now())
        record.endedAt = record.updatedAt
        record.durationMs = Math.max(0, performance.now() - clock)
        record.usageFinal = status === 'completed' && record.usage.source === 'provider'
        if (httpStatus !== undefined) record.httpStatus = httpStatus
        publish()
        return structuredClone(record)
      },
    }
  }
}

function requestSettings(serializedBody: string): ModelRequestRecord['requestSettings'] {
  try {
    const body = JSON.parse(serializedBody)
    const settings: NonNullable<ModelRequestRecord['requestSettings']> = {}
    const maxTokens = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens
    if (Number.isSafeInteger(maxTokens) && maxTokens > 0) settings.maxOutputTokens = maxTokens
    if (typeof body.temperature === 'number' && Number.isFinite(body.temperature) && body.temperature >= 0) settings.temperature = body.temperature
    const effort = body.reasoning?.effort ?? body.reasoning_effort ?? body.output_config?.effort
    if (typeof effort === 'string' && /^[a-z0-9_-]{1,32}$/i.test(effort)) settings.reasoningEffort = effort
    if (Number.isSafeInteger(body.thinking?.budget_tokens) && body.thinking.budget_tokens >= 0) settings.reasoningBudgetTokens = body.thinking.budget_tokens
    if (['enabled', 'disabled', 'adaptive'].includes(body.thinking?.type)) settings.thinkingType = body.thinking.type
    return Object.keys(settings).length ? settings : undefined
  } catch { return undefined }
}
