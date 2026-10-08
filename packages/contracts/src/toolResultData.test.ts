import { describe, expect, it } from 'vitest'
import { commandProcessOutcome, copyToolResultDetails, toolResultExecutionStatus, type CommandProcessOutcome } from './toolResultData'
import type { ToolResult } from './agentTypes'
import type { PatchReceipt } from './toolResultData'

function command(process: CommandProcessOutcome, expectedExitCodes = [0]): ToolResult {
  return { toolCallId: 'command-1', name: 'run_command', output: 'arbitrary output', isError: false,
    data: { kind: 'command', stdout: '', process, expectedExitCodes } }
}

describe('patch receipts independent of invocation error flags', () => {
  it.each(['partial', 'unknown', 'failed'] as const)('never counts %s as successful completion', status => {
    const data: PatchReceipt = { kind: 'patch', status, committed: [], pending: [], unknown: [] }
    const result: ToolResult = { toolCallId: 'patch', name: 'apply_patch', output: 'arbitrary output', isError: false, data }
    expect(toolResultExecutionStatus(result)).toBe('failed')
    expect(copyToolResultDetails(result).data).toEqual(data)
    expect(copyToolResultDetails(result).data).not.toBe(data)
  })
})

describe('command execution, process outcome and task acceptance boundaries', () => {
  it('does not confuse a captured nonzero exit with tool transport failure or successful execution', () => {
    const process = commandProcessOutcome({ success: true, data: { stdout: '', stderr: '', exitCode: 7 } })
    const result = command(process)
    expect(process).toEqual({ state: 'exited', exitCode: 7 })
    expect(result.isError).toBe(false)
    expect(toolResultExecutionStatus(result)).toBe('failed')
    expect(result).not.toHaveProperty('taskAccepted')
  })

  it('allows a caller to declare query exit 1 as expected without changing the recorded exit', () => {
    const result = command({ state: 'exited', exitCode: 1 }, [0, 1])
    expect(toolResultExecutionStatus(result)).toBe('completed')
    expect(result.data).toMatchObject({ process: { state: 'exited', exitCode: 1 } })
    expect(toolResultExecutionStatus(command({ state: 'exited', exitCode: 1 }))).toBe('failed')
  })

  it.each([
    [{ success: false, data: { exitCode: null, exitSignal: 'SIGTERM' } }, { state: 'signaled', signal: 'SIGTERM' }],
    [{ success: false, data: { exitCode: null, timedOut: true, exitSignal: 'SIGKILL' } }, { state: 'timed_out', exitCode: null, signal: 'SIGKILL' }],
    [{ success: false, data: { exitCode: null, aborted: true } }, { state: 'aborted', exitCode: null }],
    [{ success: false, error: 'spawn ENOENT' }, { state: 'execution_failed' }],
    [{ success: true, data: {} }, { state: 'unknown' }],
  ] as const)('preserves termination facts %j', (input, expected) => {
    const result = commandProcessOutcome(input as Parameters<typeof commandProcessOutcome>[0])
    expect(result).toEqual(expected)
    expect(toolResultExecutionStatus(command(result))).toBe(result.state === 'aborted' ? 'cancelled' : 'failed')
  })

  it('keeps a background process pending until a terminal observation and roundtrips facts', () => {
    const started = command({ state: 'running' })
    expect(toolResultExecutionStatus(started)).toBe('running')
    const replayed = { ...started, ...copyToolResultDetails(started) }
    expect(replayed.data).toEqual(started.data)
    expect(replayed.data).not.toBe(started.data)
    expect(toolResultExecutionStatus(replayed)).toBe('running')
    expect(toolResultExecutionStatus(command({ state: 'exited', exitCode: 0 }))).toBe('completed')
  })

  it('uses typed facts even when successful stdout starts with an error-like prefix', () => {
    const result = { ...command({ state: 'exited', exitCode: 0 }), output: 'Error: this is fixture data' }
    expect(toolResultExecutionStatus(result)).toBe('completed')
    expect(toolResultExecutionStatus({ ...result, isError: true, errorKind: 'permission' })).toBe('failed')
  })
})
