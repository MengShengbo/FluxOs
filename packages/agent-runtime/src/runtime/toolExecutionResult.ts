import type { AgentRunInterruption, ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import { copyToolResultDetails, toolRecovery, toolResultExecutionStatus, type ToolRecovery } from '@fluxos/contracts/toolResultData'
import { isAgentRunInterruption, resolveAgentRunInterruption } from './runControl'

export function createInterruptedToolResult(
  toolCall: ToolCall,
  interruption: AgentRunInterruption,
  settledResult?: ToolResult,
  unsettledEffects: ToolRecovery['effects'] = 'none',
): ToolResult {
  const message = interruption.kind === 'pause' ? 'Cancelled: paused by user' : 'Cancelled: stopped by user'
  return {
    ...(settledResult ? copyToolResultDetails(settledResult) : {}),
    toolCallId: toolCall.id,
    name: toolCall.name,
    output: settledResult?.output ?? message,
    isError: true,
    errorKind: 'abort',
    recovery: toolRecovery('abort', settledResult ? resultEffects(settledResult, unsettledEffects) : unsettledEffects),
    interruption,
  }
}

export function createToolExecutionErrorResult(toolCall: ToolCall, error: unknown, effects: ToolRecovery['effects'] = 'unknown'): ToolResult {
  return {
    toolCallId: toolCall.id,
    name: toolCall.name,
    output: `Tool execution error: ${error instanceof Error ? error.message : String(error)}`,
    isError: true,
    errorKind: 'execution',
    recovery: toolRecovery('execution', effects),
  }
}

export function resultEffects(result: ToolResult, fallback: ToolRecovery['effects']): ToolRecovery['effects'] {
  const data = result.data
  if (data?.kind === 'patch') {
    if (data.unknown.length) return 'unknown'
    if (data.committed.length) return data.pending.length ? 'partial' : 'committed'
    return 'none'
  }
  if (data?.kind === 'tasks') return data.tasks.length ? data.status === 'completed' ? 'committed' : 'partial' : 'none'
  if (result.recovery) return result.recovery.effects
  // A terminal observation says nothing about filesystem/network effects of the command.
  if (data?.kind === 'command') return 'unknown'
  if (result.changeSummary) return 'committed'
  return fallback
}

/** Called at production settlement, never as a replay migration or a text classifier. */
export function finalizeToolRecovery(result: ToolResult, effects: ToolRecovery['effects']): ToolResult {
  const status = toolResultExecutionStatus(result)
  if (status !== 'failed' && status !== 'cancelled') return result
  const errorKind = result.errorKind ?? (status === 'cancelled' ? 'abort'
    : result.data?.kind === 'command' && result.data.process.state === 'timed_out' ? 'timeout' : 'execution')
  return { ...result, errorKind, recovery: {
    ...toolRecovery(errorKind, resultEffects(result, effects)),
    ...(result.operation?.replay === 'blocked' || result.operation?.persistence === 'unconfirmed' ? { retry: 'after_inspection' as const } : {}),
    ...(result.recovery?.guidance ? { guidance: result.recovery.guidance } : {}),
  } }
}

/** Bind every outcome to its caller, including failures before dispatch. */
export async function settleToolExecution(
  toolCall: ToolCall,
  signal: AbortSignal | undefined,
  execute: () => Promise<ToolResult>,
  unsettledEffects: () => ToolRecovery['effects'] = () => 'unknown',
): Promise<ToolResult> {
  const interruption = resolveAgentRunInterruption(signal)
  if (interruption) return createInterruptedToolResult(toolCall, interruption)

  try {
    const result = await execute()
    return { ...result, toolCallId: toolCall.id, name: toolCall.name }
  } catch (error) {
    const executionInterruption = isAgentRunInterruption(error)
      ? resolveAgentRunInterruption(undefined, error)
      : resolveAgentRunInterruption(signal, error)
    return executionInterruption
      ? createInterruptedToolResult(toolCall, executionInterruption, undefined, unsettledEffects())
      : createToolExecutionErrorResult(toolCall, error, unsettledEffects())
  }
}
