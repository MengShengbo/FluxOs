import { describe, expect, it, vi } from 'vitest'
import type { AgentTurn, ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import type { CommandOutput, Result, ToolExecutor } from '@fluxos/contracts/toolExecutor'
import type { TerminalSessionInfo } from '@fluxos/contracts/terminalTypes'
import { toolResultExecutionStatus, type CommandProcessOutcome } from '@fluxos/contracts/toolResultData'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'
import { AgentSessionRehydrator } from './runtime/agentSessionRehydrator'
import { TaskManager } from './taskManager'
import { WorkExecutionTracker } from './workExecutionTracker'

const call: ToolCall = { id: 'command', name: 'run_command', arguments: {
  command: 'fixture', display_kind: 'check', display_title: '检查', run_in_background: false,
} }

function harness(executor: Partial<ToolExecutor>) {
  const workspace = process.cwd()
  const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', workspacePath: workspace, gitEnabled: false },
    executor as ToolExecutor, new DefaultAgentStateProvider({
      provider: 'custom', apiKey: 'fixture', baseUrl: 'http://example.test', model: 'test', contextWindow: 100_000, maxTokens: 4096,
    }, workspace))
  const internals = engine as unknown as {
    executeSingleTool(call: ToolCall): Promise<ToolResult>
    buildToolRetryHint(calls: ToolCall[], results: ToolResult[]): string | null
    linkToolCallToActiveTask(call: ToolCall): void
    updateTaskToolCallStatus(result: ToolResult): void
    taskManager: TaskManager
    workExecution: WorkExecutionTracker
  }
  return { engine, internals }
}

function result(process: CommandProcessOutcome, id = 'command', expectedExitCodes = [0]): ToolResult {
  return { toolCallId: id, name: id === 'command' ? 'run_command' : 'read_terminal', isError: false, output: 'captured',
    data: { kind: 'command', stdout: 'captured', process, expectedExitCodes, sessionId: 'session' } }
}

describe('command outcomes across dispatch, retry, progress and replay', () => {
  it.each([
    [{ success: true, data: { stdout: '', stderr: '', exitCode: 7 } }, [0], { state: 'exited', exitCode: 7 }, 'failed'],
    [{ success: true, data: { stdout: '', stderr: '', exitCode: 1 } }, [0, 1], { state: 'exited', exitCode: 1 }, 'completed'],
    [{ success: true, data: { stdout: 'Error: fixture text', stderr: '', exitCode: 0 } }, [0], { state: 'exited', exitCode: 0 }, 'completed'],
    [{ success: true, data: { stdout: '', stderr: '', exitCode: null, exitSignal: 'SIGTERM' } }, [0], { state: 'signaled', signal: 'SIGTERM' }, 'failed'],
    [{ success: false, data: { stdout: '', stderr: '', exitCode: null, timedOut: true } }, [0], { state: 'timed_out', exitCode: null }, 'failed'],
    [{ success: false, data: { stdout: '', stderr: '', exitCode: null, aborted: true } }, [0], { state: 'aborted', exitCode: null }, 'cancelled'],
  ] satisfies Array<[Result<CommandOutput>, number[], CommandProcessOutcome, string]>)('keeps %j consistent without accepting the task', async (output, expectedExitCodes, process, status) => {
    const runCommand = vi.fn<ToolExecutor['runCommand']>(async () => output)
    const { engine, internals } = harness({ runCommand })
    try {
      internals.workExecution.startRun('run', 'Validate')
      const task = internals.taskManager.createTask({ title: 'Validate', description: '', priority: 'major' })
      internals.taskManager.updateTask(task.id, { status: 'in_progress' })
      internals.linkToolCallToActiveTask(call)
      const command = { ...call, arguments: { ...call.arguments, expected_exit_codes: expectedExitCodes } }
      const settled = await internals.executeSingleTool(command)
      internals.updateTaskToolCallStatus(settled)
      expect(settled.isError).toBe(!output.success)
      expect(settled.data).toMatchObject({ process, expectedExitCodes })
      expect(toolResultExecutionStatus(settled)).toBe(status)
      expect(runCommand.mock.calls[0]).toHaveLength(8)
      expect(runCommand.mock.calls[0][6]).toEqual(expectedExitCodes)
      expect(Boolean(internals.buildToolRetryHint([command], [settled]))).toBe(status === 'failed')
      const run = engine.getWorkExecutionSnapshot().runs[0]!
      expect(run.activities['activity-command']).toMatchObject({ status, process })
      expect(run.status).toBe('running')
      expect(internals.taskManager.getTask(task.id)!.status).toBe('in_progress')
      const replay = new AgentSessionRehydrator()
      const turns: AgentTurn[] = [
        { id: 'assistant', role: 'assistant', content: '', timestamp: 1, toolCalls: [command] },
        { id: 'tool', role: 'tool_result', content: '', timestamp: 2, toolResults: [settled] },
      ]
      const restored = replay.rehydrateMessages(JSON.parse(JSON.stringify(replay.messagesFromTurns(turns))), {
        systemTurns: [], taskManager: new TaskManager(),
      })
      expect(toolResultExecutionStatus(restored[1]!.toolResults![0]!)).toBe(status)
      expect(restored[1]!.toolResults![0]!.data).toEqual(settled.data)
    } finally { engine.destroy() }
  })

  it('settles a linked background launch after polling without accepting its semantic task', () => {
    const { engine, internals } = harness({})
    try {
      internals.workExecution.startRun('run', 'Inspect')
      const task = internals.taskManager.createTask({ title: 'Inspect', description: '', priority: 'major' })
      internals.taskManager.updateTask(task.id, { status: 'in_progress' })
      internals.linkToolCallToActiveTask(call)
      internals.updateTaskToolCallStatus(result({ state: 'running' }))
      expect(internals.taskManager.getTaskToolCalls(task.id)[0]!.status).toBe('running')
      internals.linkToolCallToActiveTask({ id: 'poll', name: 'read_terminal', arguments: { session_id: 'session' } })
      internals.updateTaskToolCallStatus(result({ state: 'exited', exitCode: 7 }, 'poll'))
      expect(internals.taskManager.getTaskToolCalls(task.id).map(item => item.status)).toEqual(['error', 'error'])
      expect(Object.values(engine.getWorkExecutionSnapshot().runs[0]!.activities).map(item => item.status)).toEqual(['failed', 'failed'])
      expect(internals.taskManager.getTask(task.id)!.status).toBe('in_progress')
    } finally { engine.destroy() }
  })

  it('recovers expected exits from canonical launch data with an empty session registry', async () => {
    const ptyGetBuffer = vi.fn(async () => ({ success: true, chunks: [], session: {
      id: 'session', status: 'exited', exitCode: 1, cwd: process.cwd(),
    } as TerminalSessionInfo }))
    const { engine, internals } = harness({ ptyGetBuffer })
    try {
      engine.restoreFromTurns([
        { id: 'user', role: 'user', content: 'query', timestamp: 1 },
        { id: 'assistant', role: 'assistant', content: '', timestamp: 2, toolCalls: [call] },
        { id: 'result', role: 'tool_result', content: '', timestamp: 3, toolResults: [result({ state: 'running' }, 'command', [0, 1])] },
      ])
      const polled = await internals.executeSingleTool({ id: 'poll', name: 'read_terminal', arguments: { session_id: 'session' } })
      expect(polled.data).toMatchObject({ process: { state: 'exited', exitCode: 1 }, expectedExitCodes: [0, 1] })
      expect(toolResultExecutionStatus(polled)).toBe('completed')
    } finally { engine.destroy() }
  })

  it.each([
    [{ status: 'error', exitCode: null, exitSignal: 'SIGTERM' }, { state: 'signaled', signal: 'SIGTERM' }, 'failed'],
    [{ status: 'exited', exitCode: null, exitSignal: 'SIGTERM', stopped: true }, { state: 'aborted', exitCode: null, signal: 'SIGTERM' }, 'cancelled'],
    [{ status: 'running' }, { state: 'running' }, 'running'],
    [{ status: 'error', exitCode: null }, { state: 'unknown' }, 'failed'],
  ] as const)('preserves terminal observation %j', async (session, process, status) => {
    const { engine, internals } = harness({ ptyGetBuffer: async () => ({ success: true, chunks: [], session: session as TerminalSessionInfo }) })
    try {
      const observed = await internals.executeSingleTool({ id: 'poll', name: 'read_terminal', arguments: { session_id: 'session' } })
      expect(observed.data).toMatchObject({ process })
      expect(toolResultExecutionStatus(observed)).toBe(status)
    } finally { engine.destroy() }
  })

  it('replays a background exit and deep copies its process in a persisted snapshot', () => {
    const manager = new TaskManager()
    const tracker = new WorkExecutionTracker('conversation')
    tracker.restoreFromTurns([
      { id: 'user', role: 'user', content: 'query', timestamp: 1 },
      { id: 'assistant', role: 'assistant', content: '', timestamp: 2, toolCalls: [call] },
      { id: 'started', role: 'tool_result', content: '', timestamp: 3, toolResults: [result({ state: 'running' })] },
      { id: 'poll-call', role: 'assistant', content: '', timestamp: 4, toolCalls: [{ id: 'poll', name: 'read_terminal', arguments: {} }] },
      { id: 'finished', role: 'tool_result', content: '', timestamp: 5, toolResults: [result({ state: 'exited', exitCode: 7 }, 'poll')] },
    ], manager)
    const snapshot = tracker.getSnapshot(manager)
    expect(Object.values(snapshot.runs[0]!.activities)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'activity-command', status: 'failed', process: { state: 'exited', exitCode: 7 } }),
      expect.objectContaining({ id: 'activity-poll', status: 'failed', process: { state: 'exited', exitCode: 7 } }),
    ]))
    const restored = new WorkExecutionTracker('conversation')
    restored.restoreSnapshot(JSON.parse(JSON.stringify(snapshot)), manager)
    snapshot.runs[0]!.activities['activity-command']!.process = { state: 'exited', exitCode: 0 }
    expect(restored.getSnapshot(manager).runs[0]!.activities['activity-command']!.process).toEqual({ state: 'exited', exitCode: 7 })
  })
})
