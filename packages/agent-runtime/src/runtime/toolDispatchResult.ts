import type { ToolResult } from '@fluxos/contracts/agentTypes'
import { toolRecovery, type ToolRecovery } from '@fluxos/contracts/toolResultData'
import type { FileMutationResult } from '@fluxos/contracts/toolExecutor'

export type ToolDispatchResult = Pick<ToolResult, 'output' | 'isError' | 'errorKind' | 'recovery' | 'attachments' | 'retrieval' | 'data' | 'outputSource'>
/** Plain strings are successful content, regardless of their text. Failures must be explicit. */
export type ToolDispatchOutput = string | ToolDispatchResult

export function toolFailure(output: string, errorKind: NonNullable<ToolResult['errorKind']>, effects: ToolRecovery['effects']): ToolDispatchResult {
  return { output, isError: true, errorKind, recovery: toolRecovery(errorKind, effects) }
}

export function fileMutationOutput(result: FileMutationResult, successOutput: string): ToolDispatchOutput {
  return result.success ? successOutput : toolFailure(result.error, result.errorKind ?? 'execution', result.mutation === 'not_committed' ? 'none' : result.mutation)
}
