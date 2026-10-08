import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnyConversationEvent } from '@fluxos/contracts/conversationEvent'
import type { ToolResult } from '@fluxos/contracts/agentTypes'
import { toolResultExecutionStatus, type CommandProcessOutcome } from '@fluxos/contracts/toolResultData'
import { ConversationRuntimeRepositoryV2 } from './conversationRuntimeRepositoryV2'

describe('canonical command outcome persistence', () => {
  it.each([
    [{ state: 'exited', exitCode: 7 }, [0], 'failed'],
    [{ state: 'exited', exitCode: 1 }, [0, 1], 'completed'],
    [{ state: 'signaled', signal: 'SIGTERM' }, [0], 'failed'],
    [{ state: 'timed_out', exitCode: null }, [0], 'failed'],
    [{ state: 'aborted', exitCode: null }, [0], 'cancelled'],
  ] satisfies Array<[CommandProcessOutcome, number[], string]>)('reopens %j from the journal with matching activities', (process, expectedExitCodes, status) => {
    const root = mkdtempSync(join(tmpdir(), 'fluxagent-command-outcome-'))
    const repository = () => new ConversationRuntimeRepositoryV2(root, 'profile', 'workspace', root)
    const context = { id: 'conversation', title: 'Command', createdAt: 1, updatedAt: 10, mode: 'vibe' as const, provider: 'custom', model: 'fixture' }
    const repo = repository()
    let seq = 0
    const append = (type: AnyConversationEvent['type'], payload: unknown, turnId = 'turn') => repo.appendCanonical({
      schemaVersion: 1, eventId: `event-${++seq}`, conversationId: context.id, threadId: context.id,
      runId: 'run', turnId, seq, at: seq, source: 'agent', provenance: 'live', type, payload,
    } as AnyConversationEvent, context)
    const command = (id: string, name: string, process: CommandProcessOutcome): ToolResult => ({
      toolCallId: id, name, output: 'captured', isError: false,
      data: { kind: 'command', command: 'fixture', stdout: '', process, expectedExitCodes, sessionId: 'session' },
    })
    try {
      append('run.started', { objective: 'Inspect' })
      append('turn.started', { turn: { id: 'turn', role: 'assistant', content: '', timestamp: seq + 1 } })
      append('tool.proposed', { toolCall: { id: 'launch', name: 'run_command', arguments: { command: 'fixture' } } })
      append('tool.completed', { toolResult: command('launch', 'run_command', { state: 'running' }) })
      append('tool.proposed', { toolCall: { id: 'poll', name: 'read_terminal', arguments: { session_id: 'session' } } })
      append('tool.completed', { toolResult: command('poll', 'read_terminal', process) })

      const loaded = repository().load(context.id)!
      const results = loaded.turns.flatMap(turn => turn.toolResults ?? [])
      expect(results).toHaveLength(2)
      expect(toolResultExecutionStatus(results[0]!)).toBe('running')
      expect(toolResultExecutionStatus(results[1]!)).toBe(status)
      expect(results[1]!.data).toMatchObject({ process, expectedExitCodes })
      const activities = Object.values(loaded.workExecution!.runs[0]!.activities).filter(activity => activity.kind === 'tool')
      expect(activities).toHaveLength(2)
      expect(activities.every(activity => activity.status === status)).toBe(true)
      expect(activities.every(activity => JSON.stringify(activity.process) === JSON.stringify(process))).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
