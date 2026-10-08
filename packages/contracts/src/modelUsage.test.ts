import { describe, expect, it } from 'vitest'
import { isModelRequestRecord, isTokenUsage, mergeModelRequest, summarizeModelRequests, summarizeAgentRun } from './modelUsage'
import type { ModelRequestRecord } from './agentTypes'

function record(id = 'attempt', patch: Partial<ModelRequestRecord> = {}): ModelRequestRecord {
  return { id, requestId: 'request', purpose: 'turn', status: 'running', startedAt: 1, updatedAt: 1, usage: { source: 'unknown' }, usageFinal: false, ...patch }
}

describe('model request accounting', () => {
  it('counts attempts separately from requests and unknown usage separately from zero usage', () => {
    const first = record('rejected', { status: 'failed' })
    const second = record('accepted', { status: 'completed', usageFinal: true, usage: { input: 100, output: 10, cached: 80, reasoning: 3, source: 'provider' } })
    expect(summarizeModelRequests([first, second])).toMatchObject({ attempts: 2, requests: 1, knownUsageAttempts: 1, unknownUsageAttempts: 1, incompleteUsageAttempts: 1,
      totals: { input: 100, cached: 80, output: 10, reasoning: 3 }, cacheHitRate: .8 })
  })

  it('upserts cumulative reports and does not let a late running event reopen a completed attempt', () => {
    const start = record()
    const progress = record('attempt', { updatedAt: 2, usage: { input: 100, output: 4, cached: 80, source: 'provider' } })
    const end = record('attempt', { updatedAt: 3, status: 'completed', usageFinal: true, usage: { input: 100, output: 10, cached: 80, source: 'provider' } })
    const result = summarizeModelRequests([start, progress, end, end, { ...progress, updatedAt: 9 }])
    expect(result).toMatchObject({ attempts: 1, unknownUsageAttempts: 0, incompleteUsageAttempts: 0, totals: { input: 100, output: 10, cached: 80 } })
  })

  it('retains measured partial usage when interruption has no final usage', () => {
    const before = record('attempt', { usage: { input: 50, output: 2, source: 'provider' } })
    const after = mergeModelRequest(before, record('attempt', { status: 'interrupted', updatedAt: 2 }))
    expect(after.usage).toEqual(before.usage)
    expect(after.usageFinal).toBe(false)
  })

  it('rejects malformed tokens and identities and isolates merged records', () => {
    expect(isTokenUsage({ input: -1 })).toBe(false)
    expect(isTokenUsage({ input: Number.NaN })).toBe(false)
    expect(isModelRequestRecord(record())).toBe(true)
    expect(isModelRequestRecord(record('', { usage: { input: Infinity } }))).toBe(false)
    expect(() => mergeModelRequest(record(), record('other'))).toThrow('identity')
    const original = record('attempt', { usage: { source: 'provider', input: 20 } })
    const copy = mergeModelRequest(undefined, original)
    copy.usage.input = 500
    expect(original.usage.input).toBe(20)
  })
})

it('validates timing/settings and rejects fabricated latency or arbitrary fields', () => {
  expect(isModelRequestRecord(record('a', { durationMs: 100, outputTiming: { firstOutputChunkMs: 10, firstReasoningChunkMs: 10, firstAnswerChunkMs: 20 }, requestSettings: { maxOutputTokens: 100, reasoningEffort: 'high' } }))).toBe(true)
  expect(isModelRequestRecord(record('a', { outputTiming: { firstOutputChunkMs: -1 } }))).toBe(false)
  expect(isModelRequestRecord(record('a', { outputTiming: { firstOutputChunkMs: 20, firstAnswerChunkMs: 10 } }))).toBe(false)
  expect(isModelRequestRecord(record('a', { durationMs: 5, outputTiming: { firstOutputChunkMs: 10 } }))).toBe(false)
  expect(isModelRequestRecord({ ...record(), requestSettings: { prompt: 'private' } })).toBe(false)
})

it('summarizes pauses, concurrent tools, retries, unknown usage and never exports content', () => {
  const run: import('./workExecutionTypes').WorkRun = {
    id: 'run', conversationId: 'conversation', objective: 'PRIVATE PROMPT', presentation: 'work',
    status: 'completed', phase: 'delivery', rootStepIds: [], steps: {},
    startedAt: 0, updatedAt: 1000, completedAt: 1000,
    executionSegments: [{ startedAt: 0, endedAt: 200, outcome: 'paused' }, { startedAt: 500, endedAt: 1000 }],
    activities: {
      a: { id: 'a', runId: 'run', kind: 'tool', title: 'PRIVATE COMMAND', status: 'failed', attempt: 1, startedAt: 100, updatedAt: 180, completedAt: 180, error: 'SECRET' },
      b: { id: 'b', runId: 'run', kind: 'browser', title: 'PRIVATE URL', status: 'completed', attempt: 1, startedAt: 150, updatedAt: 200, completedAt: 200, metadata: { arguments: { token: 'SECRET' } } },
    },
  }
  const failed = record('rejected', { runId: 'run', status: 'failed', startedAt: 20, durationMs: 20 })
  const accepted = record('accepted', { runId: 'run', status: 'completed', startedAt: 50, durationMs: 100, outputTiming: { firstOutputChunkMs: 10, firstReasoningChunkMs: 10, firstAnswerChunkMs: 30 }, usageFinal: true, usage: { input: 100, output: 10, cached: 80, source: 'provider' } })
  const summary = summarizeAgentRun(run, [failed, accepted, accepted, record('other', { runId: 'unrelated' })])
  expect(summary).toMatchObject({ wallDurationMs: 1000, activeDurationMs: 700, inactiveDurationMs: 300, pausedDurationMs: 300, firstOutputChunkMs: 60, firstAnswerChunkMs: 80,
    model: { attempts: 2, requests: 1, additionalAttempts: 1, unknownUsageAttempts: 1, measuredRequestDurationMs: 120 },
    tools: { count: 2, failed: 1, measuredActivityDurationMs: 130, measuredBusyDurationMs: 100 },
  })
  expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|SECRET/)
  expect(summarizeAgentRun({ ...run, status: 'running', completedAt: undefined, executionSegments: undefined }, []).activeDurationMs).toBeUndefined()
  expect(summarizeAgentRun(run, []).firstOutputChunkMs).toBeUndefined()
})

it('does not mislabel task startup and teardown gaps as user pauses', () => {
  const run: import('./workExecutionTypes').WorkRun = { id: 'run', conversationId: 'conversation', objective: '', presentation: 'work', status: 'completed', phase: 'delivery', rootStepIds: [], steps: {}, activities: {}, startedAt: 0, updatedAt: 1000, completedAt: 1000, executionSegments: [{ startedAt: 100, endedAt: 900, outcome: 'completed' }] }
  expect(summarizeAgentRun(run, [])).toMatchObject({ activeDurationMs: 800, inactiveDurationMs: 200, pausedDurationMs: 0 })
})
