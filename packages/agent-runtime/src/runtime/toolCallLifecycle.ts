import type { AgentTool, ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import { ToolExecutionLedger } from '../toolExecutionLedger'
import { type AgentRunControl, createAgentRunInterruption, resolveAgentRunInterruption } from './runControl'
import { createInterruptedToolResult, finalizeToolRecovery, settleToolExecution } from './toolExecutionResult'
import type { ToolRecovery } from '@fluxos/contracts/toolResultData'
import { acquireToolWrite, needsOperationReceipt, needsWriteCoordination, type ToolWriteScope } from './toolWriteCoordinator'
import { executeToolOperation, type ToolOperationPersistence } from './toolOperationExecution'

export interface ToolCallLifecycleOptions {
  runControl: AgentRunControl
  resolveTool(name: string): AgentTool | undefined
  validate(toolCall: ToolCall, tool: AgentTool): ToolResult | undefined
  authorize(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult | null>
  execute(toolCall: ToolCall, tool: AgentTool, signal?: AbortSignal): Promise<ToolResult>
  writeScope?(): ToolWriteScope
  operations?: ToolOperationPersistence
}

/** Owns admission, cancellation and in-flight reuse for a single tool call. */
export class ToolCallLifecycle {
  private ledger = new ToolExecutionLedger()

  constructor(private readonly options: ToolCallLifecycleOptions) {}

  beginRun(): void {
    this.ledger = new ToolExecutionLedger()
  }

  invalidateReadResults(): void {
    this.ledger.invalidateReadResults()
  }

  execute(toolCall: ToolCall, signal = this.options.runControl.getOperationSignal()): Promise<ToolResult> {
    const ledger = this.ledger
    let effects: ToolRecovery['effects'] = 'none'
    return settleToolExecution(toolCall, signal, async () => {
      this.throwIfInterrupted(signal)
      const tool = this.options.resolveTool(toolCall.name)
      if (!tool) {
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: `Error: unknown tool "${toolCall.name}"`,
          isError: true,
          errorKind: 'validation',
        }
      }

      const validationError = this.options.validate(toolCall, tool)
      if (validationError) return validationError
      const permissionError = await this.options.authorize(toolCall, signal)
      this.throwIfInterrupted(signal)
      if (permissionError) return permissionError
      await this.waitUntilReady(signal)

      // Approval and pause can yield to policy/selection changes. Re-resolve
      // immediately before admission, including admission to shared reads.
      const currentTool = this.options.resolveTool(toolCall.name)
      if (!currentTool) return { toolCallId: toolCall.id, name: toolCall.name,
        output: 'Error: tool is no longer available after approval.', isError: true, errorKind: 'permission' }
      const revoked = this.options.validate(toolCall, currentTool)
      if (revoked) return revoked

      // Each caller must pass admission independently. Only physical reads share work.
      return ledger.execute(toolCall, async () => {
        const writing = needsWriteCoordination(currentTool)
        const release = writing ? acquireToolWrite(toolCall, currentTool, this.options.writeScope?.() ?? {}) : undefined
        if (writing && !release) return {
          toolCallId: toolCall.id, name: toolCall.name, output: 'Write conflict: another invocation owns an overlapping resource in this host process. This call was not dispatched; wait for its settlement and inspect current state before issuing a new call.',
          isError: true, errorKind: 'environment', recovery: { effects: 'none', retry: 'after_environment' },
        }
        try {
          const dispatch = async () => {
            const result = await settleToolExecution(toolCall, signal, async () => {
              this.throwIfInterrupted(signal)
              effects = writing ? 'unknown' : 'none'
              if (!currentTool.isReadOnly) ledger.invalidateReadResults()
              const dispatched = await this.options.execute(toolCall, currentTool, signal)
              try { await this.waitUntilReady(signal) } catch (error) {
                const interruption = resolveAgentRunInterruption(this.options.runControl.getRunSignal(), error)
                  || resolveAgentRunInterruption(signal, error)
                if (!interruption) throw error
                return createInterruptedToolResult(toolCall, interruption, dispatched, effects)
              }
              return dispatched
            }, () => effects)
            return finalizeToolRecovery(result, effects)
          }
          // Physical read sharing remains in the signal-only ledger. Ephemeral
          // catalog activation and cancellation have independent lifecycles.
          return writing && this.options.operations && needsOperationReceipt(currentTool)
            ? await executeToolOperation(toolCall, this.options.operations, dispatch)
            : await dispatch()
        } finally {
          release?.()
          // A failed or interrupted write can still have changed the workspace.
          if (!currentTool.isReadOnly) ledger.invalidateReadResults()
        }
      }, signal)
    }, () => effects).then(result => ({ ...finalizeToolRecovery(result, effects),
      ...(toolCall.operationIdentity ? { operationIdentity: structuredClone(toolCall.operationIdentity) } : {}),
    }))
  }

  private async waitUntilReady(signal?: AbortSignal): Promise<void> {
    this.throwIfInterrupted(signal)
    await this.options.runControl.waitIfPaused()
    this.throwIfInterrupted(signal)
  }

  private throwIfInterrupted(signal?: AbortSignal): void {
    const interruption = resolveAgentRunInterruption(this.options.runControl.getRunSignal())
      || resolveAgentRunInterruption(signal)
    if (interruption) throw createAgentRunInterruption(interruption.kind)
  }
}
