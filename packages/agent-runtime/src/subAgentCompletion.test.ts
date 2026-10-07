import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeTaskManager } from '@fluxos/tools/runtimeTaskManager'
import { createSubAgentDelivery } from './subAgentDelivery'
import { SubAgentTaskManager } from './runtime/subAgentTaskManager'

function createWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), 'fluxagent-completions-'))
}

describe('subagent completion delivery', () => {
  it('enqueues one durable completion result and consumes it at most once', async () => {
    const workspacePath = createWorkspace()
    const runtimeTaskManager = new RuntimeTaskManager({ defaultOwnerSessionId: 'conversation-1' })
    const manager = new SubAgentTaskManager({ workspacePath, runtimeTaskManager, ownerSessionId: 'conversation-1' })
    try {
      const started = manager.startTask({
        kind: 'agent',
        agentType: 'reviewer',
        label: 'Reviewer',
        objective: 'Review closure',
        workspacePath,
        ownerSessionId: 'conversation-1',
        workRunId: 'run-1',
        joinPolicy: 'required',
        run: async ({ recordEvent }) => {
          recordEvent({ type: 'turn_complete', turn: 1, calls: 1, inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, reasoningTokens: 1 })
          recordEvent({ type: 'tool_result', toolCallId: 'call-1', tool: 'read_file', ok: true, summary: 'read', turn: 1 })
          return {
            ok: true,
            finalText: 'Closure reviewed',
            turns: 1,
            elapsedMs: 5,
            evidence: [{ path: 'src/a.ts', startLine: 1, endLine: 2, preview: 'const a = 1', reason: 'entry' }],
          }
        },
        isSuccess: result => result.ok,
      })
      await started.promise

      const pending = manager.listPendingCompletions('conversation-1', 'run-1')
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        agentId: started.task.id,
        status: 'completed',
        finalText: 'Closure reviewed',
        joinPolicy: 'required',
      })
      expect(pending[0].stats).toMatchObject({ turns: 1, inputTokens: 10, outputTokens: 4, toolExecutions: 1 })
      expect(manager.takePendingCompletions('other-conversation', 'run-1')).toEqual([])
      const selected = manager.takePendingCompletions('conversation-1', 'run-1')
      expect(selected).toHaveLength(1)
      expect(manager.listPendingCompletions('conversation-1', 'run-1')).toHaveLength(1)
      manager.commitCompletionDelivery(createSubAgentDelivery(selected, 'conversation-1', 'run-1')!)
      expect(manager.listPendingCompletions('conversation-1', 'run-1')).toEqual([])
      expect(manager.takePendingCompletions('conversation-1', 'run-1')).toEqual([])
    } finally {
      manager.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('recovers undelivered completions after restart and does not redeliver consumed ones', async () => {
    const workspacePath = createWorkspace()
    const firstRuntime = new RuntimeTaskManager({ defaultOwnerSessionId: 'conversation-2' })
    const firstManager = new SubAgentTaskManager({ workspacePath, runtimeTaskManager: firstRuntime, ownerSessionId: 'conversation-2' })
    try {
      const started = firstManager.startTask({
        kind: 'agent',
        agentType: 'researcher',
        label: 'Researcher',
        objective: 'Persist a completion',
        workspacePath,
        ownerSessionId: 'conversation-2',
        workRunId: 'run-2',
        run: async () => ({ ok: true, finalText: 'Persisted', turns: 1, elapsedMs: 2, evidence: [] }),
        isSuccess: result => result.ok,
      })
      await started.promise
      expect(firstManager.listPendingCompletions('conversation-2', 'run-2')).toHaveLength(1)
    } finally {
      firstManager.destroy()
    }

    const recoveredManager = new SubAgentTaskManager({
      workspacePath,
      runtimeTaskManager: new RuntimeTaskManager({ defaultOwnerSessionId: 'conversation-2' }),
      ownerSessionId: 'conversation-2',
    })
    try {
      expect(recoveredManager.listPendingCompletions('conversation-2', 'run-2')).toHaveLength(1)
      const selected = recoveredManager.takePendingCompletions('conversation-2', 'run-2')
      expect(selected).toHaveLength(1)
      recoveredManager.commitCompletionDelivery(createSubAgentDelivery(selected, 'conversation-2', 'run-2')!)
    } finally {
      recoveredManager.destroy()
    }

    const thirdManager = new SubAgentTaskManager({
      workspacePath,
      runtimeTaskManager: new RuntimeTaskManager({ defaultOwnerSessionId: 'conversation-2' }),
      ownerSessionId: 'conversation-2',
    })
    try {
      expect(thirdManager.listPendingCompletions('conversation-2', 'run-2')).toEqual([])
      expect(thirdManager.listCompletionDeliveries('conversation-2', 'run-2')[0]?.turn.metadata?.runtimeContext).toContain('Persisted')
    } finally {
      thirdManager.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('supports wait_agents all, any, timeout, abort, and join-policy changes', async () => {
    const workspacePath = createWorkspace()
    const runtimeTaskManager = new RuntimeTaskManager({ defaultOwnerSessionId: 'conversation-3' })
    const manager = new SubAgentTaskManager({ workspacePath, runtimeTaskManager, ownerSessionId: 'conversation-3' })
    try {
      let releaseA: () => void = () => {}
      let releaseB: () => void = () => {}
      const result = { ok: true, finalText: 'done', turns: 1, elapsedMs: 1, evidence: [] }
      const startedA = manager.startTask({
        kind: 'agent', agentType: 'a', label: 'A', objective: 'A', workspacePath,
        ownerSessionId: 'conversation-3', workRunId: 'run-3',
        run: () => new Promise(resolve => { releaseA = () => resolve(result) }),
        isSuccess: value => value.ok,
      })
      const startedB = manager.startTask({
        kind: 'agent', agentType: 'b', label: 'B', objective: 'B', workspacePath,
        ownerSessionId: 'conversation-3', workRunId: 'run-3',
        run: () => new Promise(resolve => { releaseB = () => resolve(result) }),
        isSuccess: value => value.ok,
      })

      await new Promise(resolve => setTimeout(resolve, 0))
      const allWait = manager.waitForTasks({
        agentIds: [startedA.task.id, startedB.task.id],
        mode: 'all',
        timeoutMs: 1_000,
        ownerSessionId: 'conversation-3',
        workRunId: 'run-3',
      })
      releaseA()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(await Promise.race([allWait.then(() => 'done'), new Promise(resolve => setTimeout(() => resolve('pending'), 20))])).toBe('pending')
      releaseB()
      const allResult = await allWait
      expect(allResult.agents.map(agent => agent.status)).toEqual(['completed', 'completed'])

      const anyResult = await manager.waitForTasks({
        agentIds: [startedA.task.id, startedB.task.id],
        mode: 'any',
        timeoutMs: 1_000,
        includeResults: true,
        ownerSessionId: 'conversation-3',
        workRunId: 'run-3',
      })
      expect(anyResult.timedOut).toBe(false)
      expect(anyResult.agents[0].finalText).toBe('done')

      let releaseC: () => void = () => {}
      const startedC = manager.startTask({
        kind: 'agent', agentType: 'c', label: 'C', objective: 'C', workspacePath,
        ownerSessionId: 'conversation-3', workRunId: 'run-3',
        run: () => new Promise(resolve => { releaseC = () => resolve(result) }),
        isSuccess: value => value.ok,
      })
      const timeoutResult = await manager.waitForTasks({
        agentIds: [startedC.task.id],
        mode: 'all',
        timeoutMs: 10,
        ownerSessionId: 'conversation-3',
        workRunId: 'run-3',
      })
      expect(timeoutResult.timedOut).toBe(true)
      expect(timeoutResult.agents[0]?.status).toBe('still_running')

      const controller = new AbortController()
      const abortWait = manager.waitForTasks({
        agentIds: [startedC.task.id],
        mode: 'all',
        timeoutMs: 1_000,
        signal: controller.signal,
        ownerSessionId: 'conversation-3',
        workRunId: 'run-3',
      })
      controller.abort()
      await expect(abortWait).rejects.toThrow('Subagent wait aborted')

      expect(manager.getRequiredUnfinished('conversation-3', 'run-3').map(task => task.id)).toContain(startedC.task.id)
      manager.setJoinPolicy(startedC.task.id, 'detached')
      expect(manager.getRequiredUnfinished('conversation-3', 'run-3').map(task => task.id)).not.toContain(startedC.task.id)

      await manager.stopTask(startedC.task.id)
      releaseC()
    } finally {
      manager.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })
  it('updates task statistics live for active budget checks', async () => {
    const workspacePath = createWorkspace()
    const runtimeTaskManager = new RuntimeTaskManager({ defaultOwnerSessionId: 'conversation-live' })
    const manager = new SubAgentTaskManager({ workspacePath, runtimeTaskManager, ownerSessionId: 'conversation-live' })
    try {
      let release: () => void = () => {}
      const started = manager.startTask({
        kind: 'agent', agentType: 'live', label: 'Live', objective: 'Live stats', workspacePath,
        ownerSessionId: 'conversation-live', workRunId: 'run-live',
        run: async ({ recordEvent }) => {
          recordEvent({ type: 'model_response', turn: 1, protocol: 'openai_chat', offeredTools: [], returnedTools: [] })
          recordEvent({ type: 'turn_complete', turn: 1, calls: 1, inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, reasoningTokens: 2 })
          recordEvent({ type: 'tool_result', toolCallId: 'call-live', tool: 'read_file', ok: true, summary: 'read', turn: 1 })
          await new Promise<void>(resolve => { release = resolve })
          return { ok: true, finalText: 'live done', turns: 1, elapsedMs: 1, evidence: [] }
        },
        isSuccess: value => value.ok,
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      const snapshot = manager.getTask(started.task.id)
      expect(snapshot?.stats).toMatchObject({ turns: 1, inputTokens: 7, outputTokens: 3, toolExecutions: 1 })
      release()
      await started.promise
    } finally {
      manager.destroy()
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

})
