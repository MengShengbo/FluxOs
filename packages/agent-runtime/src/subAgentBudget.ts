import type { RuntimeTaskStatus } from '@fluxos/contracts/runtimeTaskTypes'

export interface SubAgentBudgetConfig {
  maxParallelPerSession: number
  maxPerRun: number
  maxAgentDurationMs: number
  maxRunAgentDurationMs: number
  maxPendingResults: number
  maxPendingResultBytes: number
  maxTokensPerRun: number
  maxRequestsPerRun: number
}

export const DEFAULT_SUB_AGENT_BUDGET: SubAgentBudgetConfig = {
  maxParallelPerSession: 4,
  maxPerRun: 16,
  maxAgentDurationMs: 10 * 60_000,
  maxRunAgentDurationMs: 30 * 60_000,
  maxPendingResults: 64,
  maxPendingResultBytes: 512 * 1024,
  maxTokensPerRun: 2_000_000,
  maxRequestsPerRun: 200,
}

export interface SubAgentBudgetTaskView {
  ownerSessionId?: string
  workRunId?: string
  status: RuntimeTaskStatus
  startedAt: number
  endedAt?: number
  tokens?: number
  requests?: number
}

export interface SubAgentBudgetCheckInput {
  ownerSessionId?: string
  workRunId?: string
  tasks: readonly SubAgentBudgetTaskView[]
  pendingResults: number
  pendingResultBytes: number
  now?: number
}

export type SubAgentBudgetCheck =
  | { allowed: true }
  | { allowed: false; code: string; reason: string }

const ACTIVE_STATUSES = new Set<RuntimeTaskStatus>(['starting', 'running', 'stopping'])

function finitePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback
}

function taskElapsed(task: SubAgentBudgetTaskView, now: number): number {
  return Math.max(0, (task.endedAt ?? now) - task.startedAt)
}

export class SubAgentBudget {
  private config: SubAgentBudgetConfig

  constructor(config: Partial<SubAgentBudgetConfig> = {}) {
    this.config = this.normalize(config)
  }

  configure(config: Partial<SubAgentBudgetConfig> = {}): SubAgentBudgetConfig {
    this.config = this.normalize({ ...this.config, ...config })
    return this.getConfig()
  }

  getConfig(): SubAgentBudgetConfig {
    return { ...this.config }
  }

  get agentTimeoutMs(): number {
    return this.config.maxAgentDurationMs
  }

  checkSpawn(input: SubAgentBudgetCheckInput): SubAgentBudgetCheck {
    const now = input.now ?? Date.now()
    const sessionTasks = input.tasks.filter(task => input.ownerSessionId === undefined || task.ownerSessionId === input.ownerSessionId)
    const activeSession = sessionTasks.filter(task => ACTIVE_STATUSES.has(task.status))
    if (activeSession.length >= this.config.maxParallelPerSession) {
      return { allowed: false, code: 'subagent_parallel_budget', reason: 'Conversation reached its ' + this.config.maxParallelPerSession + '-subagent concurrency limit.' }
    }
    const runTasks = sessionTasks.filter(task => input.workRunId === undefined || task.workRunId === input.workRunId)
    if (runTasks.length >= this.config.maxPerRun) {
      return { allowed: false, code: 'subagent_run_budget', reason: 'Run reached its ' + this.config.maxPerRun + '-subagent limit.' }
    }
    const totalRunElapsed = runTasks.reduce((total, task) => total + taskElapsed(task, now), 0)
    if (totalRunElapsed >= this.config.maxRunAgentDurationMs) {
      return { allowed: false, code: 'subagent_run_time_budget', reason: 'Run reached its ' + this.config.maxRunAgentDurationMs + 'ms total subagent time budget.' }
    }
    if (input.pendingResults >= this.config.maxPendingResults) {
      return { allowed: false, code: 'subagent_pending_results_budget', reason: 'Pending subagent completion queue reached its ' + this.config.maxPendingResults + '-result limit.' }
    }
    if (input.pendingResultBytes >= this.config.maxPendingResultBytes) {
      return { allowed: false, code: 'subagent_pending_bytes_budget', reason: 'Pending subagent completion queue reached its ' + this.config.maxPendingResultBytes + '-byte limit.' }
    }
    const totalTokens = runTasks.reduce((total, task) => total + (task.tokens || 0), 0)
    if (this.config.maxTokensPerRun > 0 && totalTokens >= this.config.maxTokensPerRun) {
      return { allowed: false, code: 'subagent_token_budget', reason: 'Run reached its ' + this.config.maxTokensPerRun + '-token subagent budget.' }
    }
    const totalRequests = runTasks.reduce((total, task) => total + (task.requests || 0), 0)
    if (this.config.maxRequestsPerRun > 0 && totalRequests >= this.config.maxRequestsPerRun) {
      return { allowed: false, code: 'subagent_request_budget', reason: 'Run reached its ' + this.config.maxRequestsPerRun + '-request subagent budget.' }
    }
    return { allowed: true }
  }

  private normalize(config: Partial<SubAgentBudgetConfig>): SubAgentBudgetConfig {
    return {
      maxParallelPerSession: Math.max(1, finitePositive(config.maxParallelPerSession, DEFAULT_SUB_AGENT_BUDGET.maxParallelPerSession)),
      maxPerRun: Math.max(1, finitePositive(config.maxPerRun, DEFAULT_SUB_AGENT_BUDGET.maxPerRun)),
      maxAgentDurationMs: Math.max(1_000, finitePositive(config.maxAgentDurationMs, DEFAULT_SUB_AGENT_BUDGET.maxAgentDurationMs)),
      maxRunAgentDurationMs: Math.max(60_000, finitePositive(config.maxRunAgentDurationMs, DEFAULT_SUB_AGENT_BUDGET.maxRunAgentDurationMs)),
      maxPendingResults: Math.max(1, finitePositive(config.maxPendingResults, DEFAULT_SUB_AGENT_BUDGET.maxPendingResults)),
      maxPendingResultBytes: Math.max(1_024, finitePositive(config.maxPendingResultBytes, DEFAULT_SUB_AGENT_BUDGET.maxPendingResultBytes)),
      maxTokensPerRun: config.maxTokensPerRun === 0 ? 0 : finitePositive(config.maxTokensPerRun, DEFAULT_SUB_AGENT_BUDGET.maxTokensPerRun),
      maxRequestsPerRun: config.maxRequestsPerRun === 0 ? 0 : finitePositive(config.maxRequestsPerRun, DEFAULT_SUB_AGENT_BUDGET.maxRequestsPerRun),
    }
  }
}
