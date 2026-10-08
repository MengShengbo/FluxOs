import type { ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import { toolResultExecutionStatus } from '@fluxos/contracts/toolResultData'
import type { OperationClaim, ToolOperationIdentity, ToolOperationStore } from '@fluxos/tools/toolOperationStore'
import { resultEffects } from './toolExecutionResult'
import { toolCallSignature } from '../toolExecutionLedger'

export interface ToolOperationPersistence {
  store: ToolOperationStore
  identity(call: ToolCall): ToolOperationIdentity
}

/** The caller owns write admission and settles exceptions before passing a result. */
export async function executeToolOperation(
  call: ToolCall,
  persistence: ToolOperationPersistence,
  execute: () => Promise<ToolResult>,
): Promise<ToolResult> {
  let claim: OperationClaim
  try { claim = persistence.store.begin(persistence.identity(call), toolCallSignature(call)) } catch {
    return { toolCallId: call.id, name: call.name, output: 'Operation journal could not acknowledge admission. This invocation was not dispatched. Inspect journal health and any prior invocation before issuing a new operation.',
      isError: true, errorKind: 'environment', recovery: { effects: 'unknown', retry: 'after_inspection' } }
  }
  if (claim.kind === 'existing') {
    const reason = claim.reason === 'identity_conflict' ? 'The same operation identity was used with different arguments or tool name.'
      : claim.reason === 'settled' ? 'This operation already has a persisted settlement.'
      : 'This operation has an intent without an acknowledged settlement; it may still be running or may have been interrupted.'
    return { toolCallId: call.id, name: call.name, output: `${reason} Replay was blocked without dispatch. Inspect current state before deciding whether a new operation is needed. An old receipt does not prove that the resource is unchanged.`,
      isError: true, errorKind: claim.reason === 'identity_conflict' ? 'validation' : 'environment', operation: claim.receipt,
      recovery: { effects: claim.receipt.effects, retry: 'after_inspection' } }
  }
  const result = await execute()
  const effects = resultEffects(result, 'unknown')
  try { return { ...result, operation: persistence.store.settle(claim, effects, toolResultExecutionStatus(result)) } } catch {
    // Preserve actual command/patch/task facts and payload. Failure to persist an
    // acknowledgement does not undo them and must not trigger another dispatch.
    return { ...result, isError: true, errorKind: 'environment',
      operation: { id: claim.intent.id, state: 'unsettled', replay: 'not_replayed', persistence: 'unconfirmed',
        coordination: 'host_process', effects: 'unknown' },
      recovery: { effects, retry: 'after_inspection', guidance: 'The tool settled, but its operation receipt could not be persisted. Keep the retained intent; inspect current state before any new operation.' } }
  }
}
