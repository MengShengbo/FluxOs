import { NodeToolExecutor } from '@fluxos/tools/nodeToolExecutor'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentTurn } from '@fluxos/contracts/agentTypes'
import { createAgentRuntime } from './runtime/agentRuntime'
import { SubAgentCompletionCoordinator } from './subAgentCompletionCoordinator'
import { createSubAgentDelivery } from './subAgentDelivery'
import { buildContinuationEvidence, collectContinuationHandoffFacts } from './contextCompaction'
import { reconcileSubAgentSteps } from './subAgentStepCoordinator'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fixture(workspace = mkdtempSync(join(tmpdir(), 'fluxagent-orchestration-'))) {
  const runtime = createAgentRuntime({
    workspacePath: workspace, workspaceName: 'orchestration', conversationId: 'session',
    connectMcp: false, approvalPolicy: 'full',
    config: {
      provider: 'custom', apiKey: 'unused', baseUrl: 'http://example.test',
      model: 'test-model', contextWindow: 100000, maxTokens: 4096, gitEnabled: false,
    },
  })
  cleanups.push(async () => { await runtime.destroy(); rmSync(workspace, { recursive: true, force: true }) })
  const engine = runtime.engine as any
  vi.spyOn(engine, 'initializeGit').mockResolvedValue(true)
  vi.spyOn(engine, 'prepareContextWindow').mockResolvedValue(undefined)
  const child = (name: string, run: (context: any) => Promise<any>, extra = {}) => runtime.subAgentTaskManager.startTask({
    kind: 'agent', agentType: 'research', label: 'Research', objective: name,
    workspacePath: workspace, ownerSessionId: 'session', workRunId: 'run', joinPolicy: 'required',
    run, isSuccess: result => result.ok, getError: result => result.error || 'Failed', ...extra,
  })
  return { runtime, engine, child, workspace }
}
const final = (content = 'Complete'): AgentTurn => ({
  id: 'assistant-' + Math.random().toString(36).slice(2), role: 'assistant', content, timestamp: Date.now(),
})
const success = (finalText: string) => ({ ok: true, finalText, turns: 1, elapsedMs: 1, evidence: [] })
const context = (engine: any) => engine.getSession().turns.map((turn: AgentTurn) => turn.metadata?.runtimeContext || '').join('\n')

describe('subagent orchestration reliability', () => {
  it('injects sequential batches exactly once without rewriting the original user turn', async () => {
    const { runtime, engine, child } = fixture()
    engine.workExecution.startRun('run', 'Audit', Date.now())
    const original: AgentTurn = { id: 'run', role: 'user', content: 'Audit', timestamp: Date.now() }
    engine.getSession().turns.push(original)
    await child('A', async () => success('FIRST_RESULT')).promise
    engine.injectPendingSubAgentCompletions()
    await child('B', async () => success('SECOND_RESULT')).promise
    engine.injectPendingSubAgentCompletions()
    engine.injectPendingSubAgentCompletions()
    expect(context(engine).match(/FIRST_RESULT/g)).toHaveLength(1)
    expect(context(engine).match(/SECOND_RESULT/g)).toHaveLength(1)
    expect(original.metadata).toBeUndefined()
    expect(runtime.subAgentTaskManager.listPendingCompletions('session', 'run')).toEqual([])
    expect(new Set(engine.getSession().turns.map((turn: AgentTurn) => turn.id)).size).toBe(3)
  })

  it('recovers dequeued results and committed parent contexts across both crash windows', async () => {
    const { runtime, child, workspace } = fixture()
    await child('durable', async () => success('DURABLE_RESULT')).promise
    const result = runtime.subAgentTaskManager.listPendingCompletions('session', 'run')[0]!
    const storageDir = join(workspace, 'crash-window')
    let coordinator = new SubAgentCompletionCoordinator({ storageDir })
    coordinator.enqueue(result)
    coordinator.take({ ownerSessionId: 'session', workRunId: 'run' })
    coordinator.destroy()
    coordinator = new SubAgentCompletionCoordinator({ storageDir })
    expect(coordinator.listPending('session', 'run')).toHaveLength(1)
    const delivery = createSubAgentDelivery(coordinator.take(), 'session', 'run')!
    coordinator.commitDelivery(delivery)
    coordinator.destroy()
    coordinator = new SubAgentCompletionCoordinator({ storageDir })
    expect(coordinator.listPending('session', 'run')).toEqual([])
    expect(coordinator.listDeliveries('session', 'run')).toEqual([delivery])
    coordinator.commitDelivery(delivery)
    expect(coordinator.listDeliveries('session', 'run')).toHaveLength(1)
    expect(coordinator.listDeliveries('other-session', 'run')).toEqual([])
    expect(coordinator.listDeliveries('session', 'other-run')).toEqual([])
    coordinator.destroy()
  })

  it('replays a durably committed delivery into its original parent after runtime recovery', async () => {
    const first = fixture()
    await first.child('restore', async () => success('RECOVERED_RESULT')).promise
    const pending = first.runtime.subAgentTaskManager.listPendingCompletions('session', 'run')
    first.runtime.subAgentTaskManager.commitCompletionDelivery(createSubAgentDelivery(pending, 'session', 'run')!)
    await first.runtime.destroy()
    const recovered = fixture(first.workspace)
    const callModel = vi.spyOn(recovered.engine, 'callModel').mockImplementation(async () => {
      expect(context(recovered.engine).match(/RECOVERED_RESULT/g)).toHaveLength(1)
      return final()
    })
    await recovered.engine.run('Resume original work', { userTurnId: 'run' })
    expect(callModel).toHaveBeenCalledOnce()
    const turns = recovered.engine.getSession().turns as AgentTurn[]
    recovered.engine.restoreFromTurns(turns)
    expect(recovered.engine.getSession().turns.filter((turn: AgentTurn) => turn.metadata?.internalKind === 'subagent_completion')).toHaveLength(1)
    expect(recovered.runtime.subAgentTaskManager.listPendingCompletions('session', 'run')).toEqual([])
  })

  it('does not acknowledge a delivery when its durable write fails', async () => {
    const { runtime, child, workspace } = fixture()
    await child('disk', async () => success('NOT_LOST')).promise
    const result = runtime.subAgentTaskManager.listPendingCompletions('session', 'run')[0]!
    const storageDir = join(workspace, 'disk-failure')
    const coordinator = new SubAgentCompletionCoordinator({ storageDir })
    coordinator.enqueue(result)
    const journal = join(storageDir, 'subagent-completions.jsonl')
    rmSync(journal)
    mkdirSync(journal)
    expect(() => coordinator.commitDelivery(createSubAgentDelivery([result], 'session', 'run')!)).toThrow()
    expect(coordinator.listPending('session', 'run')).toHaveLength(1)
    expect(coordinator.listDeliveries('session', 'run')).toEqual([])
    coordinator.destroy()
  })

  it('continues synthesis when a child finishes during the candidate final request', async () => {
    const { runtime, engine, child } = fixture()
    let release!: (result: any) => void
    const started = child('late', () => new Promise(resolve => { release = resolve }))
    await Promise.resolve()
    const inputEvents: AgentTurn[] = []
    runtime.engine.subscribe(event => { if (event.type === 'turn:start' && event.turn.role === 'user') inputEvents.push(event.turn) })
    const callModel = vi.spyOn(engine, 'callModel').mockImplementation(async () => {
      if (callModel.mock.calls.length === 1) {
        release(success('RESULT_DURING_FINAL'))
        await started.promise
        return final('Candidate without child evidence')
      }
      expect(context(engine)).toContain('RESULT_DURING_FINAL')
      return final('Synthesized result')
    })
    await engine.run('Audit', { userTurnId: 'run' })
    expect(callModel).toHaveBeenCalledTimes(2)
    expect(inputEvents).toHaveLength(1)
    expect(runtime.subAgentTaskManager.listPendingCompletions('session', 'run')).toEqual([])
    expect(engine.getSession().turns.some((turn: AgentTurn) => turn.content === 'Candidate without child evidence' && turn.metadata?.internalKind === 'subagent_candidate')).toBe(true)
    expect(engine.getWorkExecutionSnapshot().runs[0]?.status).toBe('completed')
  })

  it('does not complete a delegated step or parent run after an unresolved child failure', async () => {
    const { engine, child } = fixture()
    const tasks = engine.getTaskManager()
    tasks.setCurrentWorkRunId('run')
    const step = tasks.createTask({ title: 'Delegated work', description: 'Needs child evidence', priority: 'medium' })
    tasks.updateTask(step.id, { status: 'in_progress' })
    tasks.addToolCallToActiveTask({ toolCallId: 'spawn', toolName: 'spawn_agent', status: 'completed' }, step.id)
    await child('failed', async () => ({ ok: false, error: 'Could not finish' }), { stepId: step.id }).promise
    const callModel = vi.spyOn(engine, 'callModel').mockResolvedValue(final('Verified findings from the remaining work.'))
    await engine.run('Audit', { userTurnId: 'run' })
    expect(tasks.getTask(step.id)?.status).toBe('failed')
    expect(engine.getWorkExecutionSnapshot().runs[0]?.status).not.toBe('completed')
    expect(callModel).toHaveBeenCalledOnce()
    expect(engine.getSession().turns.at(-1)?.content).toContain('Verified findings from the remaining work.')
    expect(engine.getSession().turns.at(-1)?.content).toContain('Could not finish')
    expect(engine.getSession().turns.at(-1)?.metadata?.interrupted).not.toBe(true)
    expect(engine.getWorkExecutionSnapshot().runs[0]?.status).toBe('partial')
  })

  it('synthesizes two successful results and one failure without repeated final requests', async () => {
    const { engine, child, runtime } = fixture()
    await Promise.all([
      child('A', async () => success('A_RESULT')).promise,
      child('B', async () => success('B_RESULT')).promise,
      child('C', async () => ({ ok: false, error: 'Source unavailable', finalText: 'C_PARTIAL' })).promise,
    ])
    const callModel = vi.spyOn(engine, 'callModel').mockImplementation(async () => {
      expect(context(engine)).toContain('A_RESULT')
      expect(context(engine)).toContain('B_RESULT')
      expect(context(engine)).toContain('C_PARTIAL')
      return final('A and B verified; C needs follow-up.')
    })
    await engine.run('Summarize the research', { userTurnId: 'run' })
    expect(callModel).toHaveBeenCalledOnce()
    expect(runtime.subAgentTaskManager.listPendingCompletions('session', 'run')).toEqual([])
    expect(engine.getSession().turns.at(-1)?.content).toContain('A and B verified; C needs follow-up.')
    expect(engine.getWorkExecutionSnapshot().runs[0]?.status).toBe('partial')
  })

  it('requires all sibling results, and a successful retry resolves only its predecessor', async () => {
    const { engine, runtime, child } = fixture()
    engine.workExecution.startRun('run', 'Audit', Date.now())
    const tasks = engine.getTaskManager()
    tasks.setCurrentWorkRunId('run')
    const step = tasks.createTask({ title: 'Two child results', description: 'Need both', priority: 'medium' })
    tasks.updateTask(step.id, { status: 'in_progress' })
    const failed = child('failed', async () => ({ ok: false, error: 'Failed' }), { stepId: step.id })
    let release!: (result: any) => void
    const sibling = child('sibling', () => new Promise(resolve => { release = resolve }), { stepId: step.id })
    await failed.promise
    reconcileSubAgentSteps(tasks, runtime.subAgentTaskManager.listTasks())
    expect(tasks.getTask(step.id)?.status).toBe('failed')
    await child('retry', async () => success('RETRIED'), { retryOf: failed.task.id, stepId: step.id }).promise
    engine.injectPendingSubAgentCompletions()
    reconcileSubAgentSteps(tasks, runtime.subAgentTaskManager.listTasks())
    expect(tasks.getTask(step.id)?.status).toBe('in_progress')
    const blocked = await engine.dispatchTool('update_task', { task_id: step.id, status: 'completed' }, 'update')
    expect(blocked).toContain('Required child results')
    expect(tasks.getTask(step.id)?.status).toBe('in_progress')
    release(success('SIBLING_DONE'))
    await sibling.promise
    engine.injectPendingSubAgentCompletions()
    expect(tasks.getCompletionBlocker(step.id)).toBeNull()
    await engine.dispatchTool('update_task', { task_id: step.id, status: 'completed' }, 'update2')
    expect(tasks.getTask(step.id)?.status).toBe('completed')
  })

  it('does not complete a parent step through automatic child-step aggregation while its agent is running', async () => {
    const { engine, child } = fixture()
    engine.workExecution.startRun('run', 'Audit', Date.now())
    const tasks = engine.getTaskManager()
    tasks.setCurrentWorkRunId('run')
    const parent = tasks.createTask({ title: 'Parent', description: 'Parent', priority: 'major' })
    const leaf = tasks.createTask({ title: 'Leaf', description: 'Leaf', priority: 'medium', parentId: parent.id })
    const started = child('parent agent', ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
    }), { stepId: parent.id })
    await Promise.resolve()
    tasks.updateTask(leaf.id, { status: 'completed' })
    expect(tasks.getTask(parent.id)?.status).not.toBe('completed')
    expect(tasks.getCompletionBlocker(parent.id)).toContain(started.task.id)
  })

  it('isolates completion injection by session and run and bounds multilingual deliveries', async () => {
    const { runtime, child, engine } = fixture()
    engine.workExecution.startRun('run', 'Audit', Date.now())
    await child('elsewhere', async () => success('OTHER_RUN_SECRET'), { workRunId: 'other-run' }).promise
    await child('elsewhere', async () => success('OTHER_SESSION_SECRET'), { ownerSessionId: 'other-session' }).promise
    for (let index = 0; index < 6; index++) await child('Long result', async () => success('研究结果'.repeat(5000))).promise
    for (let index = 0; index < 8; index++) engine.injectPendingSubAgentCompletions()
    expect(context(engine)).not.toContain('OTHER_RUN_SECRET')
    expect(context(engine)).not.toContain('OTHER_SESSION_SECRET')
    const deliveries = runtime.subAgentTaskManager.listCompletionDeliveries('session', 'run')
    expect(deliveries.flatMap(item => item.completionIds)).toHaveLength(6)
    for (const delivery of deliveries) expect(Buffer.byteLength(delivery.turn.metadata!.runtimeContext!)).toBeLessThanOrEqual(12000)
    expect(runtime.subAgentTaskManager.listPendingCompletions('session', 'run')).toEqual([])
  })

  it('retains completion evidence in compaction and does not replay covered deliveries', async () => {
    const { engine, child } = fixture()
    engine.workExecution.startRun('run', 'Audit', Date.now())
    await child('compact', async () => success('COMPACTED_CHILD_RESULT')).promise
    engine.injectPendingSubAgentCompletions()
    const turn = engine.getSession().turns.at(-1) as AgentTurn
    expect(buildContinuationEvidence([turn], [], { workspacePath: '' })).toContain('COMPACTED_CHILD_RESULT')
    const facts = collectContinuationHandoffFacts([turn], [], { workspacePath: '' })
    expect(facts.progress[0]?.text).toContain('COMPACTED_CHILD_RESULT')
    expect(facts.userRequirements).toEqual([])
    engine.setContextSegments([{
      startMessageId: turn.id, endMessageId: turn.id, coveredTurnIds: [turn.id],
      summary: 'Child reported COMPACTED_CHILD_RESULT', isValid: true, isModelGenerated: false, originalCharCount: 2000,
    }])
    engine.getSession().turns = []
    engine.setContextReservoir([])
    engine.injectPendingSubAgentCompletions()
    expect(engine.getSession().turns).toEqual([])
  })

  it('preserves delivery context when retrying an empty final answer', async () => {
    const { engine, child } = fixture()
    await child('empty-final', async () => success('RETRY_VISIBLE_RESULT')).promise
    const callModel = vi.spyOn(engine, 'callModel')
      .mockResolvedValueOnce(final(''))
      .mockImplementationOnce(async () => {
        expect(context(engine)).toContain('RETRY_VISIBLE_RESULT')
        return final('Delivered')
      })
    await engine.run('Audit', { userTurnId: 'run' })
    expect(callModel).toHaveBeenCalledTimes(2)
  })

  it('stops only required children of the aborted parent run', async () => {
    const { runtime, child } = fixture()
    const running = ({ signal }: { signal: AbortSignal }) => new Promise<any>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
    })
    const required = child('required', running)
    const detached = child('detached', running, { joinPolicy: 'detached' })
    const otherRun = child('other', running, { workRunId: 'other' })
    await Promise.resolve()
    await runtime.subAgentTaskManager.stopAll('Parent stopped', { ownerSessionId: 'session', workRunId: 'run' })
    expect(runtime.subAgentTaskManager.getTask(required.task.id)?.runtimeTask.status).toBe('stopped')
    expect(runtime.subAgentTaskManager.getTask(detached.task.id)?.runtimeTask.status).toBe('running')
    expect(runtime.subAgentTaskManager.getTask(otherRun.task.id)?.runtimeTask.status).toBe('running')
  })

  it('runs two built-in research agents through spawn, real file tools, wait, delivery and final synthesis', async () => {
    const { runtime, engine, workspace } = fixture()
    writeFileSync(join(workspace, 'alpha.txt'), 'ALPHA_SOURCE')
    writeFileSync(join(workspace, 'beta.txt'), 'BETA_SOURCE')
    let waiting = 0, maxWaiting = 0
    const releases: Array<() => void> = []
    vi.spyOn(NodeToolExecutor.prototype, 'streamMessage').mockImplementation(async (_url, _headers, body, onLine) => {
      const request = JSON.parse(body)
      const objective = request.messages.find((message: any) => message.role === 'user').content
      const label = objective.includes('alpha') ? 'alpha' : 'beta'
      let calls: any[] | undefined
      let content: string | undefined
      if (request.tool_choice?.function?.name === 'set_response_mode') {
        calls = [{ id: label + '-mode', name: 'set_response_mode', args: { mode: 'task' } }]
      } else if (!request.messages.some((message: any) => message.role === 'tool' && message.content?.includes('_SOURCE'))) {
        waiting++
        maxWaiting = Math.max(maxWaiting, waiting)
        await new Promise<void>(resolve => {
          releases.push(resolve)
          if (releases.length === 2) releases.forEach(release => release())
        })
        waiting--
        calls = [{ id: label + '-read', name: 'read_file', args: { path: label + '.txt' } }]
      } else {
        expect(JSON.stringify(request.messages)).toContain(label.toUpperCase() + '_SOURCE')
        content = label.toUpperCase() + '_CHILD_RESULT'
      }
      onLine('data: ' + JSON.stringify({ choices: [{ delta: calls ? {
        tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })),
      } : { content }, finish_reason: calls ? 'tool_calls' : 'stop' }] }))
      onLine('data: [DONE]')
      return { success: true, data: '' }
    })
    let rounds = 0
    runtime.toolExecutor.streamMessage = vi.fn(async (_url, _headers, body, onLine) => {
      const request = JSON.parse(body)
      let calls: any[] | undefined
      let content: string | undefined
      if (request.tool_choice?.function?.name === 'set_response_mode') {
        calls = [{ id: 'mode', name: 'set_response_mode', args: { mode: 'task' } }]
      } else if (++rounds === 1) {
        expect(request.tools.some((tool: any) => tool.function?.name === 'spawn_agent')).toBe(true)
        calls = ['alpha', 'beta'].map(label => ({ id: 'spawn-' + label, name: 'spawn_agent', args: { name: label, agent_type: 'research', objective: 'Inspect ' + label + '.txt' } }))
      } else if (rounds === 2) {
        calls = [{ id: 'wait', name: 'wait_agents', args: { mode: 'all', timeout_ms: 1000, include_results: true } }]
      } else {
        expect(JSON.stringify(request.messages)).toContain('ALPHA_CHILD_RESULT')
        expect(JSON.stringify(request.messages)).toContain('BETA_CHILD_RESULT')
        expect(JSON.stringify(request.messages)).toContain('subagent_completions')
        content = 'Both inspected sources were synthesized.'
      }
      onLine('data: ' + JSON.stringify({ choices: [{ delta: calls ? {
        tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })),
      } : { content }, finish_reason: calls ? 'tool_calls' : 'stop' }] }))
      onLine('data: [DONE]')
      return { success: true, data: '' }
    })
    await engine.run('Inspect the two independent sources with two child agents', { userTurnId: 'run' })
    expect(maxWaiting).toBe(2)
    expect(runtime.subAgentTaskManager.listTasks().map(task => task.runtimeTask.status)).toEqual(['completed', 'completed'])
    expect(runtime.subAgentTaskManager.listTasks().every(task => (task.stats?.toolExecutions || 0) >= 1)).toBe(true)
    expect(runtime.subAgentTaskManager.listPendingCompletions('session', 'run')).toEqual([])
    expect(engine.getSession().turns.at(-1)?.content).toBe('Both inspected sources were synthesized.')
    expect(engine.getWorkExecutionSnapshot().runs[0]?.status).toBe('completed')
  })
})
