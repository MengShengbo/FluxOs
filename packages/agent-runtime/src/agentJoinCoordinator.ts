export interface JoinTaskView {
  id: string
  agentType: string
  status: string
  objective: string
  startedAt: number
}

export interface AgentJoinCoordinatorOptions {
  maxContinuations?: number
  maxWaitMs?: number
}

const DEFAULT_MAX_CONTINUATIONS = 4
const DEFAULT_MAX_WAIT_MS = 120_000

export class AgentJoinCoordinator {
  private continuationCount = 0
  private waitStartedAt: number | null = null
  private readonly maxContinuations: number
  private readonly maxWaitMs: number

  constructor(options: AgentJoinCoordinatorOptions = {}) {
    this.maxContinuations = Math.max(1, Math.floor(options.maxContinuations || DEFAULT_MAX_CONTINUATIONS))
    this.maxWaitMs = Math.max(1_000, Math.floor(options.maxWaitMs || DEFAULT_MAX_WAIT_MS))
  }

  beginRun(): void {
    this.continuationCount = 0
    this.waitStartedAt = null
  }

  tryBeginContinuation(now = Date.now()): boolean {
    if (this.continuationCount >= this.maxContinuations) return false
    if (this.waitStartedAt !== null && now - this.waitStartedAt >= this.maxWaitMs) return false
    if (this.continuationCount === 0) this.waitStartedAt = now
    this.continuationCount += 1
    return true
  }

  remainingWaitMs(now = Date.now()): number {
    if (this.waitStartedAt === null) return this.maxWaitMs
    return Math.max(0, this.maxWaitMs - (now - this.waitStartedAt))
  }

  getContinuationCount(): number {
    return this.continuationCount
  }

  formatRequiredContext(tasks: JoinTaskView[]): string {
    const lines = [
      'The main model attempted to finalize before all required child results were resolved and consumed.',
      'Do not submit the final answer yet. Call wait_agents with mode=all for running IDs; retry failed work with spawn_agent(retry_of), or detach_agent to explicitly release obsolete work. Cancellation alone is not success. If all children are terminal, consume the pending completion deliveries and synthesize their results.',
      'Required child results needing attention:',
    ]
    for (const task of tasks) {
      lines.push(
        '- agentId: ' + task.id,
        '  agentType: ' + task.agentType,
        '  status: ' + task.status,
        '  objective: ' + task.objective.slice(0, 500),
        '  elapsedMs: ' + Math.max(0, Date.now() - task.startedAt),
      )
    }
    lines.push('After joining or detaching, produce the final synthesized answer. Preserve the earlier candidate answer as a draft and revise it with the child results.')
    return lines.join(String.fromCharCode(10))
  }
}

export function formatIncompleteChildNotice(tasks: Array<JoinTaskView & { error?: string }>, chinese: boolean): string {
  if (!tasks.length) return ''
  const detail = tasks.slice(0, 6).map(task => {
    const objective = task.objective.replace(/\s+/g, ' ').slice(0, 140)
    const error = task.error?.replace(/\s+/g, ' ').slice(0, 220)
    return '- ' + objective + (error ? ': ' + error : ' (' + task.status + ')')
  }).join('\n')
  return chinese
    ? '\n\n协作执行说明：以下子任务未完整交付，本轮保留已取得的结果并标记为部分完成。\n' + detail
    : '\n\nDelegation note: the following child work did not fully complete. Available results are preserved; this run is partially complete.\n' + detail
}
