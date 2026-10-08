import type { TaskNode, ToolCall, ToolResult } from './agentTypes'
import type { GitSnapshot } from './gitTypes'
import type { CommandOutput, Result, WebSearchResponse, WebFetchResponse } from './toolExecutor'

export type CommandProcessOutcome =
  | { state: 'running' }
  | { state: 'exited'; exitCode: number }
  | { state: 'signaled'; signal: string }
  | { state: 'timed_out' | 'aborted'; exitCode: number | null; signal?: string; termination?: CommandOutput['termination'] }
  | { state: 'execution_failed' | 'unknown' }

/** Result.success describes capture/transport, not the command's exit or task acceptance. */
export function commandProcessOutcome(result: Result<CommandOutput>): CommandProcessOutcome {
  const output = result.data
  if (output?.aborted || output?.timedOut) return {
    state: output.aborted ? 'aborted' : 'timed_out', exitCode: output.exitCode ?? null,
    ...(output.exitSignal ? { signal: output.exitSignal } : {}),
    ...(output.termination ? { termination: output.termination } : {}),
  }
  if (output?.exitSignal) return { state: 'signaled', signal: output.exitSignal }
  if (!result.success) return { state: 'execution_failed' }
  return typeof output?.exitCode === 'number' ? { state: 'exited', exitCode: output.exitCode } : { state: 'unknown' }
}

export interface PatchFileEffect {
  operationIndex: number
  /** Canonical path after path preflight; requested path if resolution failed. */
  path: string
  displayPath: string
  action: 'write' | 'delete'
}

export interface PatchReceipt {
  kind: 'patch'
  status: 'completed' | 'partial' | 'failed' | 'unknown'
  /** Acknowledged file publication/deletion, not a durability or task acceptance claim. */
  committed: PatchFileEffect[]
  /** Unattempted or explicitly rejected before target mutation. */
  pending: PatchFileEffect[]
  /** Attempted effects without an authoritative acknowledgement. Inspect before retry. */
  unknown: PatchFileEffect[]
  failure?: {
    stage: 'parse' | 'paths' | 'preflight' | 'snapshot' | 'write' | 'delete' | 'move_target' | 'move_cleanup' | 'cancelled'
    operationIndex?: number
    path?: string
    message: string
  }
}

/** Recovery guidance is conditional, never authorization to replay a call automatically. */
export interface ToolRecovery {
  /** Acknowledged effects are facts, not a promise of durability or unchanged current state. */
  effects: 'none' | 'committed' | 'partial' | 'unknown'
  retry: 'after_correction' | 'after_permission' | 'after_environment' | 'after_inspection' | 'explicit_request'
  /** Host recovery explanation, separate from the untouched tool payload. */
  guidance?: string
}

/** A receipt records an invocation, not global exactly-once or current resource state. */
export interface ToolOperationReceipt {
  id: string
  state: 'settled' | 'unsettled' | 'rejected'
  replay: 'not_replayed' | 'blocked'
  persistence: 'persisted' | 'unconfirmed'
  coordination: 'host_process'
  effects: ToolRecovery['effects']
  previousStatus?: 'completed' | 'failed' | 'cancelled' | 'running'
}

export function toolRecovery(errorKind: NonNullable<ToolResult['errorKind']>, effects: ToolRecovery['effects']): ToolRecovery {
  return { effects, retry: effects !== 'none' ? 'after_inspection'
    : errorKind === 'abort' ? 'explicit_request'
    : errorKind === 'validation' ? 'after_correction'
    : errorKind === 'permission' ? 'after_permission' : 'after_environment' }
}

/** Only acknowledged task nodes are replayed; skipped input items are not created on recovery. */
export interface TaskMutationReceipt {
  kind: 'tasks'
  status: 'completed' | 'partial' | 'failed'
  tasks: TaskNode[]
  failures: Array<{ index: number; stage: 'create' | 'dependency' | 'execution'; errorKind: 'validation' | 'execution'; message: string; taskId?: string }>
}

export type ToolResultData =
  | PatchReceipt
  | TaskMutationReceipt
  | {
      kind: 'command'
      command?: string
      cwd?: string
      stdout: string
      stderr?: string
      error?: string
      process: CommandProcessOutcome
      /** Invocation-specific expected exits; never a task-level acceptance decision. */
      expectedExitCodes: number[]
      sessionId?: string
      truncated?: boolean
    }
  | { kind: 'repository'; snapshot: GitSnapshot }
  | { kind: 'web_search'; response: WebSearchResponse }
  | { kind: 'web_fetch'; response: WebFetchResponse }
  | { kind: 'items'; items: Array<{ title: string; description?: string; path?: string; status?: string }> }

/** Shared by live execution, statistics and replay; no parsing of user-visible output. */
export function toolResultExecutionStatus(result: ToolResult): 'completed' | 'failed' | 'cancelled' | 'running' {
  if (result.interruption || result.errorKind === 'abort') return 'cancelled'
  if (result.isError) return 'failed'
  if (result.data?.kind === 'patch' || result.data?.kind === 'tasks') return result.data.status === 'completed' ? 'completed' : 'failed'
  if (result.data?.kind !== 'command') return 'completed'
  const { process, expectedExitCodes } = result.data
  if (process.state === 'running') return 'running'
  if (process.state === 'aborted') return 'cancelled'
  return process.state === 'exited' && expectedExitCodes.includes(process.exitCode) ? 'completed' : 'failed'
}

/** A returned background launch/poll settles the call while its process remains running. */
export function toolResultCallStatus(result: ToolResult): 'completed' | 'failed' | 'cancelled' {
  const status = toolResultExecutionStatus(result)
  return status === 'running' ? 'completed' : status
}

/** Stable across canonical display IDs; raw IDs remain valid for unbound calls. */
export function toolInvocationKey(callId: string, identity?: ToolCall['operationIdentity']): string {
  return identity ? JSON.stringify([identity.sessionId, identity.turnId, identity.callId]) : callId
}

type ToolResultDetails = Pick<ToolResult, 'retrieval' | 'data' | 'errorKind' | 'recovery' | 'interruption' | 'changeSummary' | 'attachments' | 'outputSource' | 'operation' | 'operationIdentity'>

export function copyToolResultDetails(result: ToolResultDetails): ToolResultDetails {
  return structuredClone({
    ...(result.retrieval ? { retrieval: result.retrieval } : {}),
    ...(result.data ? { data: result.data } : {}),
    ...(result.errorKind ? { errorKind: result.errorKind } : {}),
    ...(result.recovery ? { recovery: result.recovery } : {}),
    ...(result.outputSource ? { outputSource: result.outputSource } : {}),
    ...(result.operation ? { operation: result.operation } : {}),
    ...(result.operationIdentity ? { operationIdentity: result.operationIdentity } : {}),
    ...(result.interruption ? { interruption: result.interruption } : {}),
    ...(result.changeSummary ? { changeSummary: result.changeSummary } : {}),
    ...(result.attachments?.length ? { attachments: result.attachments } : {}),
  })
}
