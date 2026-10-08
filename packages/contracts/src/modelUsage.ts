import type { ModelRequestRecord, TokenUsage } from './agentTypes'

const tokenFields = ['input', 'output', 'cached', 'cacheWrite', 'reasoning', 'total'] as const
const requestFields = new Set(['id', 'requestId', 'runId', 'model', 'provider', 'protocol', 'purpose', 'status', 'startedAt', 'updatedAt', 'endedAt', 'durationMs', 'outputTiming', 'requestSettings', 'providerResponseId', 'requestFingerprint', 'httpStatus', 'usage', 'usageFinal', 'cacheDiagnostic'])

export function isTokenUsage(value: unknown): value is TokenUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const usage = value as Record<string, unknown>
  if (Object.keys(usage).some(key => key !== 'source' && !tokenFields.includes(key as typeof tokenFields[number]))) return false
  if (usage.source !== undefined && usage.source !== 'provider' && usage.source !== 'unknown') return false
  if (!tokenFields.every(key => usage[key] === undefined || (Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0))) return false
  if (usage.source === 'provider' && !tokenFields.some(key => usage[key] !== undefined)) return false
  if (typeof usage.input === 'number' && typeof usage.cached === 'number' && usage.cached > usage.input) return false
  return true
}

export function isModelRequestRecord(value: unknown): value is ModelRequestRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => !requestFields.has(key))) return false
  if (typeof item.id !== 'string' || !item.id || typeof item.requestId !== 'string' || !item.requestId) return false
  if (!['running', 'completed', 'failed', 'interrupted'].includes(String(item.status))) return false
  if (!['turn', 'compaction'].includes(String(item.purpose))) return false
  if (!Number.isFinite(item.startedAt) || !Number.isFinite(item.updatedAt) || typeof item.usageFinal !== 'boolean') return false
  if (!isTokenUsage(item.usage)) return false
  if (item.usageFinal && (item.status === 'running' || item.usage.source !== 'provider')) return false
  if (item.protocol !== undefined && !['openai_responses', 'openai_chat', 'anthropic_messages'].includes(String(item.protocol))) return false
  for (const key of ['model', 'provider', 'runId', 'providerResponseId', 'requestFingerprint']) {
    if (item[key] !== undefined && typeof item[key] !== 'string') return false
  }
  if (item.endedAt !== undefined && !Number.isFinite(item.endedAt)) return false
  if (item.durationMs !== undefined && (!Number.isFinite(item.durationMs) || Number(item.durationMs) < 0)) return false
  if (item.outputTiming !== undefined) {
    const timing = item.outputTiming as Record<string, unknown>
    const fields = ['firstOutputChunkMs', 'firstAnswerChunkMs', 'firstReasoningChunkMs', 'firstToolCallChunkMs']
    if (!timing || typeof timing !== 'object' || Array.isArray(timing)
      || Object.keys(timing).some(key => !fields.includes(key))
      || !Object.values(timing).every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return false
    const first = timing.firstOutputChunkMs
    const channels = fields.slice(1).flatMap(key => timing[key] === undefined ? [] : [Number(timing[key])])
    if (channels.length && (first === undefined || first !== Math.min(...channels))) return false
    if (item.durationMs !== undefined && Object.values(timing).some(value => Number(value) > Number(item.durationMs))) return false
  }
  if (item.requestSettings !== undefined) {
    const settings = item.requestSettings as Record<string, unknown>
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
      || Object.keys(settings).some(key => !['maxOutputTokens', 'temperature', 'reasoningEffort', 'reasoningBudgetTokens', 'thinkingType'].includes(key))) return false
    for (const key of ['maxOutputTokens', 'reasoningBudgetTokens']) {
      if (settings[key] !== undefined && (!Number.isSafeInteger(settings[key]) || Number(settings[key]) < (key === 'maxOutputTokens' ? 1 : 0))) return false
    }
    if (settings.temperature !== undefined && (typeof settings.temperature !== 'number' || !Number.isFinite(settings.temperature) || settings.temperature < 0)) return false
    if (settings.reasoningEffort !== undefined && (typeof settings.reasoningEffort !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(settings.reasoningEffort))) return false
    if (settings.thinkingType !== undefined && !['enabled', 'disabled', 'adaptive'].includes(String(settings.thinkingType))) return false
  }
  if (item.httpStatus !== undefined && (!Number.isSafeInteger(item.httpStatus) || Number(item.httpStatus) < 100 || Number(item.httpStatus) > 599)) return false
  if (item.cacheDiagnostic !== undefined) {
    const diagnostic = item.cacheDiagnostic as Record<string, unknown>
    if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)
      || Object.keys(diagnostic).some(key => !['broken', 'reason', 'tokenDrop', 'likelyTtlExpiry', 'requestTiming'].includes(key))
      || typeof diagnostic.broken !== 'boolean'
      || typeof diagnostic.reason !== 'string' || !Number.isFinite(diagnostic.tokenDrop)
      || typeof diagnostic.likelyTtlExpiry !== 'boolean') return false
    const timing = diagnostic.requestTiming as Record<string, unknown> | undefined
    if (timing && (typeof timing !== 'object' || Array.isArray(timing)
      || Object.keys(timing).some(key => !['idleMs', 'durationMs'].includes(key))
      || !Number.isFinite(timing.idleMs) || Number(timing.idleMs) < 0 || !Number.isFinite(timing.durationMs) || Number(timing.durationMs) < 0)) return false
  }
  return true
}

export function mergeModelRequest(previous: ModelRequestRecord | undefined, incoming: ModelRequestRecord): ModelRequestRecord {
  if (!previous) return structuredClone(incoming)
  if (previous.id !== incoming.id || previous.requestId !== incoming.requestId) throw new Error('Model request identity changed')
  if (incoming.updatedAt < previous.updatedAt || (previous.status !== 'running' && incoming.status === 'running')) return previous
  return { ...structuredClone(previous), ...structuredClone(incoming),
    usage: incoming.usage.source === 'unknown' && previous.usage.source === 'provider'
      ? { ...previous.usage } : { ...previous.usage, ...incoming.usage },
  }
}

/** Totals cover known provider fields only; unknown/partial attempts remain explicit. */
export function summarizeModelRequests(records: readonly ModelRequestRecord[]) {
  const latest = new Map<string, ModelRequestRecord>()
  for (const record of records) latest.set(record.id, mergeModelRequest(latest.get(record.id), record))
  const attempts = [...latest.values()]
  const totals = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 }
  let cacheInput = 0
  let cacheTokens = 0
  let knownUsageAttempts = 0
  for (const record of attempts) {
    if (record.usage.source !== 'provider') continue
    knownUsageAttempts += 1
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += record.usage[key] ?? 0
    if (record.usage.cached !== undefined && record.usage.input !== undefined) {
      cacheInput += record.usage.input
      cacheTokens += record.usage.cached
    }
  }
  return {
    attempts: attempts.length,
    requests: new Set(attempts.map(record => record.requestId)).size,
    knownUsageAttempts,
    unknownUsageAttempts: attempts.length - knownUsageAttempts,
    incompleteUsageAttempts: attempts.filter(record => !record.usageFinal).length,
    totals,
    cacheHitRate: cacheInput > 0 ? cacheTokens / cacheInput : undefined,
    cacheMeasuredInput: cacheInput,
  }
}

export type ModelUsageSummary = ReturnType<typeof summarizeModelRequests>

/** A content-free summary of one run. Execution outcome is not a benchmark score. */
export function summarizeAgentRun(
  run: import('./workExecutionTypes').WorkRun,
  records: readonly ModelRequestRecord[],
) {
  const latest = new Map<string, ModelRequestRecord>()
  for (const record of records.filter(record => record.runId === run.id)) {
    latest.set(record.id, mergeModelRequest(latest.get(record.id), record))
  }
  const attempts = [...latest.values()]
  const measuredUntil = run.completedAt ?? run.updatedAt
  const terminal = !['pending', 'running', 'waiting', 'paused'].includes(run.status)
  const wallDurationMs = Math.max(0, measuredUntil - run.startedAt)
  const segments = run.executionSegments?.map(segment => [
    Math.max(run.startedAt, segment.startedAt), Math.min(measuredUntil, segment.endedAt ?? measuredUntil),
  ] as const)
  const activeDurationMs = segments?.length ? intervalUnionMs(segments) : undefined
  const firstOutput = (key: keyof NonNullable<ModelRequestRecord['outputTiming']>) => {
    const arrivals = attempts.filter(record => record.purpose === 'turn' && record.outputTiming?.[key] !== undefined)
      .map(record => record.startedAt + record.outputTiming![key]! - run.startedAt)
    return arrivals.length ? Math.max(0, Math.min(...arrivals)) : undefined
  }
  const tools = Object.values(run.activities).filter(activity => activity.kind === 'tool'
    || (['browser', 'computer'].includes(activity.kind) && activity.metadata?.arguments !== undefined))
  const toolIntervals = tools.filter(activity => activity.completedAt !== undefined)
    .map(activity => [activity.startedAt, activity.completedAt!] as const)
  const durations = attempts.flatMap(record => record.durationMs === undefined ? [] : [record.durationMs])
  const firstChunks = attempts.flatMap(record => record.outputTiming?.firstOutputChunkMs === undefined ? [] : [record.outputTiming.firstOutputChunkMs])
  return {
    runId: run.id, status: run.status, terminal, recovered: run.recoveredFromPersistence === true,
    startedAt: run.startedAt, measuredUntil, wallDurationMs, activeDurationMs,
    inactiveDurationMs: activeDurationMs === undefined ? undefined : Math.max(0, wallDurationMs - activeDurationMs),
    pausedDurationMs: segments?.length ? (run.executionSegments ?? []).slice(0, -1).reduce((total, segment, index) => {
      const next = run.executionSegments![index + 1]
      return total + (segment.endedAt !== undefined && ['paused', 'stopped'].includes(segment.outcome ?? '')
        ? Math.max(0, Math.min(measuredUntil, next.startedAt) - Math.max(run.startedAt, segment.endedAt)) : 0)
    }, 0) : undefined,
    firstOutputChunkMs: firstOutput('firstOutputChunkMs'),
    firstAnswerChunkMs: firstOutput('firstAnswerChunkMs'),
    firstReasoningChunkMs: firstOutput('firstReasoningChunkMs'),
    firstToolCallChunkMs: firstOutput('firstToolCallChunkMs'),
    model: {
      ...summarizeModelRequests(attempts),
      failedAttempts: attempts.filter(record => record.status === 'failed').length,
      interruptedAttempts: attempts.filter(record => record.status === 'interrupted').length,
      additionalAttempts: attempts.length - new Set(attempts.map(record => record.requestId)).size,
      compactionAttempts: attempts.filter(record => record.purpose === 'compaction').length,
      measuredRequestDurationMs: durations.reduce((sum, value) => sum + value, 0),
      unmeasuredDurationAttempts: attempts.length - durations.length,
      firstOutputLatency: distribution(firstChunks),
      attemptsWithoutOutputTiming: attempts.length - firstChunks.length,
    },
    tools: {
      count: tools.length,
      failed: tools.filter(activity => activity.status === 'failed').length,
      cancelled: tools.filter(activity => activity.status === 'cancelled').length,
      completed: tools.filter(activity => activity.status === 'completed').length,
      measuredActivityDurationMs: toolIntervals.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0),
      measuredBusyDurationMs: intervalUnionMs(toolIntervals),
      unmeasuredActivities: tools.length - toolIntervals.length,
    },
    // A narrow allowlist avoids prompts, tool arguments/results, local paths and credentials.
    requests: attempts.map(record => ({
      id: record.id, requestId: record.requestId, purpose: record.purpose,
      provider: record.provider, model: record.model, protocol: record.protocol,
      status: record.status, httpStatus: record.httpStatus,
      startedAt: record.startedAt, durationMs: record.durationMs,
      outputTiming: record.outputTiming, requestSettings: record.requestSettings,
      usage: record.usage, usageFinal: record.usageFinal,
    })),
  }
}

function intervalUnionMs(intervals: readonly (readonly [number, number])[]): number {
  let total = 0
  let end = -Infinity
  for (const [start, stop] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (stop <= start) continue
    total += Math.max(0, stop - Math.max(start, end))
    end = Math.max(end, stop)
  }
  return total
}

function distribution(values: readonly number[]) {
  const ordered = [...values].sort((a, b) => a - b)
  const quantile = (fraction: number) => ordered.length ? ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] : undefined
  return { samples: ordered.length, p50Ms: quantile(.5), p95Ms: quantile(.95) }
}
