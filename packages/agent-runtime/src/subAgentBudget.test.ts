import { describe, expect, it } from 'vitest'
import { SubAgentBudget } from './subAgentBudget'

describe('SubAgentBudget', () => {
  it('rejects spawns that exceed concurrency, run, time, queue, token, or request budgets', () => {
    const budget = new SubAgentBudget({
      maxParallelPerSession: 1,
      maxPerRun: 2,
      maxRunAgentDurationMs: 60_000,
      maxPendingResults: 1,
      maxPendingResultBytes: 1024,
      maxTokensPerRun: 10,
      maxRequestsPerRun: 2,
    })
    const base = {
      ownerSessionId: 'conversation-1',
      workRunId: 'run-1',
      status: 'running' as const,
      startedAt: 0,
    }
    expect(budget.checkSpawn({ ...base, tasks: [], pendingResults: 0, pendingResultBytes: 0, now: 0 })).toEqual({ allowed: true })
    expect(budget.checkSpawn({ ...base, tasks: [{ ...base, status: 'running' }], pendingResults: 0, pendingResultBytes: 0, now: 0 })).toMatchObject({ allowed: false, code: 'subagent_parallel_budget' })
    expect(budget.checkSpawn({ ...base, tasks: [{ ...base, workRunId: 'run-1', status: 'completed', startedAt: 0, endedAt: 1 }, { ...base, workRunId: 'run-1', status: 'completed', startedAt: 0, endedAt: 1 }], pendingResults: 0, pendingResultBytes: 0, now: 0 })).toMatchObject({ allowed: false, code: 'subagent_run_budget' })
    expect(budget.checkSpawn({ ...base, tasks: [{ ...base, status: 'completed', startedAt: 0, endedAt: 60_000 }], pendingResults: 0, pendingResultBytes: 0, now: 60_000 })).toMatchObject({ allowed: false, code: 'subagent_run_time_budget' })
    expect(budget.checkSpawn({ ...base, tasks: [], pendingResults: 1, pendingResultBytes: 0 })).toMatchObject({ allowed: false, code: 'subagent_pending_results_budget' })
    expect(budget.checkSpawn({ ...base, tasks: [], pendingResults: 0, pendingResultBytes: 1024 })).toMatchObject({ allowed: false, code: 'subagent_pending_bytes_budget' })
    expect(budget.checkSpawn({ ...base, tasks: [{ ...base, status: 'completed', endedAt: 1, tokens: 10 }], pendingResults: 0, pendingResultBytes: 0 })).toMatchObject({ allowed: false, code: 'subagent_token_budget' })
    expect(budget.checkSpawn({ ...base, tasks: [{ ...base, status: 'completed', endedAt: 1, requests: 2 }], pendingResults: 0, pendingResultBytes: 0 })).toMatchObject({ allowed: false, code: 'subagent_request_budget' })
  })
  it('scopes run budgets to the owning conversation even if run IDs collide', () => {
    const budget = new SubAgentBudget({ maxPerRun: 1, maxRequestsPerRun: 1 })
    expect(budget.checkSpawn({ ownerSessionId: 'current', workRunId: 'same-run', pendingResults: 0, pendingResultBytes: 0,
      tasks: [{ ownerSessionId: 'other', workRunId: 'same-run', status: 'completed', startedAt: 0, endedAt: 9999999, requests: 100 }],
    })).toEqual({ allowed: true })
  })
  it('supports an explicit zero to disable token and request admission limits', () => {
    const budget = new SubAgentBudget({ maxTokensPerRun: 0, maxRequestsPerRun: 0 })
    expect(budget.getConfig()).toMatchObject({ maxTokensPerRun: 0, maxRequestsPerRun: 0 })
    expect(budget.checkSpawn({ pendingResults: 0, pendingResultBytes: 0, tasks: [
      { status: 'completed', startedAt: 0, endedAt: 1, tokens: 99999999, requests: 99999999 },
    ] })).toEqual({ allowed: true })
  })
})
