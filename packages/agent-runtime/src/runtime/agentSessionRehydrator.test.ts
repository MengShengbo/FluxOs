import { describe, expect, it } from 'vitest'
import type { AgentTurn } from '@fluxos/contracts/agentTypes'
import { toolResultExecutionStatus, type CommandProcessOutcome } from '@fluxos/contracts/toolResultData'
import { TaskManager } from '../taskManager'
import { AgentSessionRehydrator } from './agentSessionRehydrator'

describe('AgentSessionRehydrator', () => {
  it('rejects a settled result without explicit status instead of parsing text or dropping it', () => {
    const rehydrator = new AgentSessionRehydrator()
    expect(() => rehydrator.rehydrateMessages([{ role: 'assistant', content: '', metadata: { toolCalls: [
      { name: 'read_file', arguments: {}, result: 'Error: ambiguous content', status: 'completed' },
    ] } }], { systemTurns: [], taskManager: new TaskManager() })).toThrow('must declare isError')
  })

  it('retains canonical results attached to the assistant turn by call id', () => {
    const rehydrator = new AgentSessionRehydrator()
    const result = { toolCallId: 'canonical-call', name: 'read_file', output: 'Error: actual file text', isError: false }
    const messages = rehydrator.messagesFromTurns([{ id: 'canonical-turn', role: 'assistant', content: '', timestamp: 1,
      toolCalls: [{ id: 'canonical-call', name: 'read_file', arguments: { path: 'file.txt' } }], toolResults: [result] }])
    const turns = rehydrator.rehydrateMessages(messages, { systemTurns: [], taskManager: new TaskManager() })
    expect(turns.flatMap(turn => turn.toolResults ?? [])).toEqual([result])
  })

  it.each([
    [{ state: 'exited', exitCode: 7 }, [0], 'failed'],
    [{ state: 'exited', exitCode: 1 }, [0, 1], 'completed'],
    [{ state: 'signaled', signal: 'SIGTERM' }, [0], 'failed'],
    [{ state: 'timed_out', exitCode: null, signal: 'SIGKILL' }, [0], 'failed'],
    [{ state: 'aborted', exitCode: null }, [0], 'cancelled'],
    [{ state: 'running' }, [0], 'running'],
  ] satisfies Array<[CommandProcessOutcome, number[], string]>)('round trips command facts %j without changing transport success', (process, expectedExitCodes, status) => {
    const rehydrator = new AgentSessionRehydrator()
    const data = { kind: 'command' as const, stdout: 'captured', process, expectedExitCodes, sessionId: 'background-1' }
    const messages = rehydrator.messagesFromTurns([
      { id: 'call', role: 'assistant', content: '', timestamp: 1,
        toolCalls: [{ id: 'command', name: 'run_command', arguments: {} }] },
      { id: 'result', role: 'tool_result', content: '', timestamp: 2,
        toolResults: [{ toolCallId: 'command', name: 'run_command', output: 'captured', isError: false, data }] },
    ])
    const restored = rehydrator.rehydrateMessages(JSON.parse(JSON.stringify(messages)), {
      systemTurns: [], taskManager: new TaskManager(),
    })
    const result = restored[1]!.toolResults![0]!
    expect(result.data).toEqual(data)
    expect(result.isError).toBe(false)
    expect(toolResultExecutionStatus(result)).toBe(status)
    expect(restored[1]!.content).toContain(`[${status}]`)
    expect(messages[0]!.metadata!.toolCalls![0]!.data).not.toBe(data)
  })

  it('round trips explicit capture errors with their process facts', () => {
    const rehydrator = new AgentSessionRehydrator()
    const turns = rehydrator.rehydrateMessages([{
      role: 'assistant', content: '', metadata: { toolCalls: [{ id: 'timeout', name: 'run_command', arguments: {},
        result: 'timeout', isError: true, errorKind: 'timeout',
        data: { kind: 'command', stdout: 'partial', process: { state: 'timed_out', exitCode: null }, expectedExitCodes: [0] },
      }] },
    }], { systemTurns: [], taskManager: new TaskManager(),  })
    expect(turns[1]!.toolResults![0]).toMatchObject({ errorKind: 'timeout', data: { process: { state: 'timed_out' } } })
  })

  it('preserves interrupted assistant metadata across persistence rehydration', () => {
    const rehydrator = new AgentSessionRehydrator()
    const messages = rehydrator.messagesFromTurns([{
      id: 'recovered-assistant-1',
      role: 'assistant',
      content: 'partial answer',
      timestamp: 1,
      metadata: {
        interrupted: true,
        interruption: { kind: 'stop', resumable: false },
        thinking: { content: 'partial reasoning', status: 'interrupted' },
      },
    }])
    const turns = rehydrator.rehydrateMessages(messages, {
      systemTurns: [],
      taskManager: new TaskManager(),
    })

    expect(turns[0]?.metadata).toMatchObject({
      interrupted: true,
      interruption: { kind: 'stop', resumable: false },
      thinking: { content: 'partial reasoning', status: 'interrupted' },
    })
  })

  it('rebuilds tool results, interruption metadata, and provider reasoning payloads', () => {
    const rehydrator = new AgentSessionRehydrator()
    const turns = rehydrator.rehydrateMessages([{
      id: 'assistant-1',
      role: 'assistant',
      content: 'partial answer',
      timestamp: 10,
      metadata: {
        rawReasoningPayload: {
          provider: 'openai',
          blocks: [{ type: 'reasoning', text: 'trace' }],
          reasoningContent: 'provider-reasoning',
        },
        thinking: { content: 'thinking', source: 'provider', isStreaming: true },
        toolCalls: [{
          id: 'tool-1',
          name: 'read_file',
          arguments: { path: 'README.md' },
          result: 'Paused by user',
          status: 'cancelled', isError: true, errorKind: 'abort', interruption: { kind: 'pause', resumable: true },
        }],
      },
    }], {
      systemTurns: [],
      taskManager: new TaskManager(),
    })

    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({
      id: 'assistant-1',
      toolCalls: [{ id: 'tool-1', name: 'read_file' }],
      metadata: {
        thinking: { content: 'thinking', isStreaming: false },
        rawReasoningPayload: { reasoningContent: 'provider-reasoning' },
      },
    })
    expect(turns[1]?.toolResults?.[0]).toMatchObject({
      toolCallId: 'tool-1',
      errorKind: 'abort',
      interruption: { kind: 'pause' },
    })
  })

  it('preserves system turns and deterministically fills missing timestamps', () => {
    const rehydrator = new AgentSessionRehydrator()
    const systemTurn: AgentTurn = { id: 'system-1', role: 'system', content: 'system', timestamp: 1 }
    const turns = rehydrator.rehydrateMessages([
      { id: 'user-1', role: 'user', content: 'first' },
      { id: 'assistant-1', role: 'assistant', content: 'second' },
    ], {
      systemTurns: [systemTurn],
      taskManager: new TaskManager(),
      now: () => 100,
    })

    expect(turns.map(turn => turn.id)).toEqual(['system-1', 'user-1', 'assistant-1'])
    expect(turns.map(turn => turn.timestamp)).toEqual([1, 100, 101])
  })

  it('restores completed task calls while rejecting failed task history', () => {
    const rehydrator = new AgentSessionRehydrator()
    const taskManager = new TaskManager()
    rehydrator.rehydrateMessages([{
      id: 'assistant-tasks',
      role: 'assistant',
      content: '',
      timestamp: 20,
      metadata: {
        workRunId: 'run-1',
        toolCalls: [
          {
            name: 'create_task',
            arguments: { title: 'Keep me', priority: 'major' },
            isError: false, data: { kind: 'tasks', status: 'completed', failures: [], tasks: [{ id: 'task-1', title: 'Keep me', description: 'fixture', priority: 'major', status: 'completed', progress: 100, parentId: null, children: [], dependencies: [], order: 0, createdAt: 20, updatedAt: 20 }] },
            result: JSON.stringify({ id: 'task-1', status: 'completed' }),
            status: 'completed',
          },
          {
            name: 'create_task',
            arguments: { title: 'Drop me' },
            result: 'failed', isError: true, errorKind: 'validation',
            status: 'error',
          },
        ],
      },
    }], {
      systemTurns: [],
      taskManager,
    })

    expect(taskManager.getAllTasks()).toEqual([
      expect.objectContaining({ id: 'task-1', title: 'Keep me', status: 'completed', progress: 100 }),
    ])
  })

  it('joins standalone tool-result turns back onto their original calls', () => {
    const rehydrator = new AgentSessionRehydrator()
    const messages = rehydrator.messagesFromTurns([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 'tool-1', name: 'write_file', arguments: { path: 'a.txt' } }],
      },
      {
        id: 'result-1',
        role: 'tool_result',
        content: 'ok',
        timestamp: 2,
        toolResults: [{
          toolCallId: 'tool-1',
          name: 'write_file',
          output: 'written',
          isError: false,
          changeSummary: { path: 'a.txt', operation: 'write', addedLines: 1 },
        }],
      },
    ])

    expect(messages[0]?.metadata?.toolCalls?.[0]).toMatchObject({
      id: 'tool-1',
      result: 'written',
      status: 'completed',
      changeSummary: { path: 'a.txt', operation: 'write' },
    })
  })
})
