import { AgentJoinCoordinator } from './agentJoinCoordinator'
import { describe, expect, it, vi } from 'vitest'
import type { AgentTurn } from '@fluxos/contracts/agentTypes'
import type { ToolExecutor } from '@fluxos/contracts/toolExecutor'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'

function createEngine(): AgentEngine {
  const workspace = process.cwd()
  const stateProvider = new DefaultAgentStateProvider({
    provider: 'custom',
    apiKey: 'test',
    baseUrl: 'http://example.test',
    model: 'test-model',
    contextWindow: 100_000,
    maxTokens: 4096,
  }, workspace, { conversationId: 'conversation-1' })
  const engine = new AgentEngine({
    mode: 'vibe',
    approvalPolicy: 'full',
    workspacePath: workspace,
    workspaceName: 'join-test',
    conversationId: 'conversation-1',
    gitEnabled: false,
  }, {} as ToolExecutor, stateProvider)
  vi.spyOn(engine as any, 'initializeGit').mockResolvedValue(true)
  vi.spyOn(engine as any, 'prepareContextWindow').mockResolvedValue(undefined)
  return engine
}

function startPendingChild(engine: AgentEngine, joinPolicy: 'required' | 'detached') {
  const manager = (engine as unknown as { subAgentTaskManager: { startTask: (input: Record<string, unknown>) => { task: { id: string } } } }).subAgentTaskManager
  return manager.startTask({
    kind: 'agent',
    agentType: 'join_fixture',
    label: 'Join fixture',
    objective: 'Stay running until stopped',
    workspacePath: process.cwd(),
    ownerSessionId: 'conversation-1',
    workRunId: 'run-gate',
    joinPolicy,
    run: ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      const abort = () => {
        const error = new Error('Aborted')
        error.name = 'AbortError'
        reject(error)
      }
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener('abort', abort, { once: true })
    }),
  })
}

describe('AgentEngine subagent join gate', () => {
  it('does not commit a final answer while required children are unfinished', async () => {
    const engine = createEngine()
    const callModel = vi.spyOn(engine as any, 'callModel').mockImplementation(async () => ({
      id: 'assistant-' + Math.random().toString(36).slice(2),
      role: 'assistant',
      content: 'candidate final',
      timestamp: Date.now(),
    } satisfies AgentTurn))
    try {
      startPendingChild(engine, 'required')
      await engine.run('finish the task', { userTurnId: 'run-gate' })
      expect(callModel.mock.calls.length).toBeGreaterThanOrEqual(5)
      expect(engine.getSession().turns.some(turn => turn.role === 'assistant' && turn.content.includes('Partial result'))).toBe(true)
      expect(engine.getSession().turns.some(turn => turn.role === 'user' && turn.metadata?.internal === true)).toBe(true)
    } finally {
      engine.destroy()
    }
  })

  it('allows finalization when the child is explicitly detached', async () => {
    const engine = createEngine()
    const callModel = vi.spyOn(engine as any, 'callModel').mockResolvedValue({
      id: 'assistant-detached',
      role: 'assistant',
      content: 'detached final',
      timestamp: Date.now(),
    } satisfies AgentTurn)
    try {
      startPendingChild(engine, 'detached')
      await engine.run('finish the task', { userTurnId: 'run-gate' })
      expect(callModel).toHaveBeenCalledTimes(1)
      expect(engine.getSession().turns.some(turn => turn.role === 'assistant' && turn.content.includes('Partial result'))).toBe(false)
    } finally {
      engine.destroy()
    }
  })
  it('injects a pending completion once at a safe runtime-context boundary', async () => {
    const engine = createEngine()
    const internals = engine as unknown as {
      workExecution: { startRun: (runId: string, objective: string, startedAt: number) => void }
      injectPendingSubAgentCompletions: (newTurns?: AgentTurn[]) => void
      subAgentTaskManager: { startTask: (input: Record<string, unknown>) => { task: { id: string } } }
    }
    try {
      internals.workExecution.startRun('run-inject', 'Inject completion', Date.now())
      const started = internals.subAgentTaskManager.startTask({
        kind: 'agent',
        agentType: 'inject_fixture',
        label: 'Inject fixture',
        objective: 'Return a result',
        workspacePath: process.cwd(),
        ownerSessionId: 'conversation-1',
        workRunId: 'run-inject',
        run: async () => ({ ok: true, finalText: 'injected result', turns: 1, elapsedMs: 2, evidence: [] }),
        isSuccess: (result: { ok: boolean }) => result.ok,
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      const turn: AgentTurn = { id: 'user-inject', role: 'user', content: 'continue', timestamp: Date.now() }
      engine.getSession().turns.push(turn)
      internals.injectPendingSubAgentCompletions()
      const delivered = engine.getSession().turns.at(-1)!
      expect(delivered.metadata?.runtimeContext).toContain('subagent_completions')
      expect(delivered.metadata?.runtimeContext).toContain(started.task.id)
      expect(delivered.metadata?.internalKind).toBe('subagent_completion')
      expect(turn.metadata?.runtimeContext).toBeUndefined()
      const count = engine.getSession().turns.length
      internals.injectPendingSubAgentCompletions()
      expect(engine.getSession().turns).toHaveLength(count)
    } finally {
      engine.destroy()
    }
  })

})

it('starts the recovery deadline only when a premature final answer needs continuation', () => {
  const join = new AgentJoinCoordinator({ maxWaitMs: 1000 })
  expect(join.remainingWaitMs(0)).toBe(1000)
  expect(join.remainingWaitMs(9000)).toBe(1000)
  expect(join.tryBeginContinuation(10000)).toBe(true)
  expect(join.remainingWaitMs(10500)).toBe(500)
  expect(join.tryBeginContinuation(11000)).toBe(false)
  join.beginRun()
  expect(join.remainingWaitMs(20000)).toBe(1000)
})
