import type {
  AgentRunInterruption,
  AgentTurn,
  TaskNode,
  TokenUsage,
  ToolResult,
  ToolCall,
} from '@fluxos/contracts/agentTypes'
import { generateTurnId } from '@fluxos/contracts/agentTypes'
import { copyToolResultDetails, toolInvocationKey, toolResultExecutionStatus } from '@fluxos/contracts/toolResultData'
import { TaskManager } from '../taskManager'

export interface PersistedAgentMessage {
  id?: string
  role: string
  content: string
  timestamp?: number
  metadata?: {
    model?: string
    tokens?: number | TokenUsage
    duration?: number
    reasoningEnabled?: boolean
    reasoningEffort?: NonNullable<AgentTurn['metadata']>['reasoningEffort']
    thinking?: NonNullable<AgentTurn['metadata']>['thinking']
    rawReasoningPayload?: NonNullable<AgentTurn['metadata']>['rawReasoningPayload']
    attachments?: NonNullable<AgentTurn['metadata']>['attachments']
    capabilities?: NonNullable<AgentTurn['metadata']>['capabilities']
    runtimeContext?: string
    internal?: boolean
    internalKind?: string
    subAgentCompletionIds?: string[]
    toolCalls?: PersistedToolCall[]
    detectedSkills?: string[]
    isStreaming?: boolean
    workRunId?: string
    interrupted?: boolean
    interruption?: AgentRunInterruption
  }
}

export interface PersistedToolCall extends Pick<ToolResult, 'data' | 'errorKind' | 'recovery' | 'retrieval' | 'attachments' | 'outputSource' | 'operation'> {
  operationIdentity?: ToolCall['operationIdentity']
  id?: string
  name: string
  arguments: Record<string, unknown>
  result?: string
  isError?: boolean
  status?: string
  interruption?: AgentRunInterruption
  changeSummary?: {
    path: string
    operation: 'write' | 'edit' | 'delete'
    addedLines?: number
    removedLines?: number
    totalLines?: number
    preview?: string
    oldPreview?: string
    before?: string
    after?: string
  }
}

interface RehydrateMessagesOptions {
  systemTurns: AgentTurn[]
  taskManager: TaskManager
  now?: () => number
}

export class AgentSessionRehydrator {
  messagesFromTurns(turns: AgentTurn[]): PersistedAgentMessage[] {
    const resultByToolCallId = new Map<string, ToolResult>()
    for (const turn of turns) {
      // Canonical projection co-locates calls/results on the assistant turn;
      // live execution uses a separate tool_result turn. Both are current producers.
      if (!turn.toolResults) continue
      for (const result of turn.toolResults) resultByToolCallId.set(toolInvocationKey(result.toolCallId, result.operationIdentity), result)
    }

    return turns.map(turn => {
      const toolCalls = turn.toolCalls?.map(toolCall => {
        const result = resultByToolCallId.get(toolInvocationKey(toolCall.id, toolCall.operationIdentity))
        const executionStatus = result ? toolResultExecutionStatus(result) : undefined
        return {
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          ...(toolCall.operationIdentity ? { operationIdentity: structuredClone(toolCall.operationIdentity) } : {}),
          result: result?.output,
          isError: result?.isError,
          status: executionStatus === 'failed' ? 'error' : executionStatus,
          ...(result ? copyToolResultDetails(result) : {}),
        }
      })

      return {
        id: turn.id,
        role: turn.role,
        content: turn.content,
        timestamp: turn.timestamp,
        metadata: {
          ...(turn.metadata ?? {}),
          ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
        },
      }
    })
  }

  rehydrateMessages(messages: PersistedAgentMessage[], options: RehydrateMessagesOptions): AgentTurn[] {
    const turns = [...options.systemTurns]
    const taskSnapshots = new Map<string, TaskNode>()
    let restoredTimestampFallback = (options.now ?? Date.now)()
    for (const message of messages) {
      if (message.role === 'system') continue
      const timestamp = typeof message.timestamp === 'number' ? message.timestamp : restoredTimestampFallback++
      const metadata = message.metadata

      if (message.role === 'user') {
        const userMetadata: AgentTurn['metadata'] = {}
        if (metadata?.attachments?.length) {
          userMetadata.attachments = metadata.attachments.map(attachment => ({ ...attachment }))
        }
        if (metadata?.capabilities?.items.length) {
          userMetadata.capabilities = { items: metadata.capabilities.items.map(item => ({ ...item })) }
        }
        if (metadata?.internal === true) userMetadata.internal = true
        if (metadata?.internalKind) userMetadata.internalKind = metadata.internalKind
        if (metadata?.subAgentCompletionIds) userMetadata.subAgentCompletionIds = [...metadata.subAgentCompletionIds]
        if (typeof metadata?.runtimeContext === 'string') userMetadata.runtimeContext = metadata.runtimeContext
        if (typeof metadata?.workRunId === 'string') userMetadata.workRunId = metadata.workRunId
        turns.push({
          id: message.id || generateTurnId(),
          role: 'user',
          content: message.content,
          timestamp,
          metadata: Object.keys(userMetadata).length > 0 ? userMetadata : undefined,
        })
        continue
      }

      if (message.role !== 'assistant') continue
      const restoredIds = metadata?.toolCalls?.map((toolCall, index) => (
        toolCall.id || `restored_tc_${index}_${timestamp}`
      )) ?? []
      const toolCalls = metadata?.toolCalls?.map((toolCall, index) => ({
        id: restoredIds[index]!,
        name: toolCall.name,
        arguments: toolCall.arguments,
        ...(toolCall.operationIdentity ? { operationIdentity: structuredClone(toolCall.operationIdentity) } : {}),
      }))
      const toolResults = this.restoreToolResults(metadata?.toolCalls, restoredIds)
      const turnMetadata = this.restoreAssistantMetadata(metadata)
      const assistantTurn: AgentTurn = {
        id: message.id || generateTurnId(),
        role: 'assistant',
        content: message.content,
        timestamp,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        metadata: Object.keys(turnMetadata).length > 0 ? turnMetadata : undefined,
      }
      turns.push(assistantTurn)

      if (toolResults.length > 0) {
        turns.push({
          id: `${assistantTurn.id}:tool_results`,
          role: 'tool_result',
          content: toolResults.map(result => (
            `${result.name}: [${toolResultExecutionStatus(result)}] ${(result.output || '').slice(0, 500)}`
          )).join('\n\n'),
          timestamp: timestamp + 1,
          toolResults,
        })
      }

      if (metadata?.toolCalls?.length) {
        options.taskManager.setCurrentWorkRunId(metadata.workRunId || null)
        for (const toolCall of metadata.toolCalls) {
          // Receipts survive partial failure and interruption. Never execute the input again.
          if (toolCall.data?.kind !== 'tasks') continue
          for (const task of toolCall.data.tasks) taskSnapshots.set(task.id, structuredClone(task))
        }
      }
    }
    for (const task of taskSnapshots.values()) options.taskManager.restoreTask(task)
    return turns
  }

  private restoreToolResults(toolCalls: PersistedToolCall[] | undefined, restoredIds: string[]): ToolResult[] {
    if (!toolCalls?.length) return []
    const results: ToolResult[] = []
    toolCalls.forEach((toolCall, index) => {
      // Pending/running calls have no settled payload. Current settled results carry isError.
      if (typeof toolCall.isError !== 'boolean') {
        if (toolCall.result !== undefined || ['completed', 'error', 'cancelled'].includes(toolCall.status ?? '')) {
          throw new Error(`Settled tool result must declare isError: ${toolCall.name}`)
        }
        return
      }
      const result: ToolResult = {
        toolCallId: restoredIds[index]!,
        name: toolCall.name,
        output: toolCall.result ?? '',
        isError: toolCall.isError,
        ...copyToolResultDetails(toolCall),
      }
      if (toolCall.interruption) {
        result.interruption = { ...toolCall.interruption }
        result.errorKind = 'abort'
      }
      results.push(result)
    })
    return results
  }

  private restoreAssistantMetadata(metadata: PersistedAgentMessage['metadata']): NonNullable<AgentTurn['metadata']> {
    const turnMetadata: NonNullable<AgentTurn['metadata']> = {}
    if (metadata?.model) turnMetadata.model = metadata.model
    if (typeof metadata?.tokens === 'number') turnMetadata.tokens = { input: metadata.tokens, output: 0 }
    else if (metadata?.tokens) turnMetadata.tokens = metadata.tokens
    if (metadata?.duration) turnMetadata.duration = metadata.duration
    if (typeof metadata?.reasoningEnabled === 'boolean') turnMetadata.reasoningEnabled = metadata.reasoningEnabled
    if (metadata?.reasoningEffort) turnMetadata.reasoningEffort = metadata.reasoningEffort
    if (metadata?.thinking) turnMetadata.thinking = { ...metadata.thinking, isStreaming: false }
    if (typeof metadata?.workRunId === 'string') turnMetadata.workRunId = metadata.workRunId
    if (metadata?.internal === true) turnMetadata.internal = true
    if (metadata?.internalKind) turnMetadata.internalKind = metadata.internalKind
    if (metadata?.interrupted === true) turnMetadata.interrupted = true
    if (metadata?.interruption) turnMetadata.interruption = { ...metadata.interruption }
    if (metadata?.rawReasoningPayload) {
      turnMetadata.rawReasoningPayload = {
        provider: metadata.rawReasoningPayload.provider,
        blocks: metadata.rawReasoningPayload.blocks.map(block => ({ ...block })),
        ...(metadata.rawReasoningPayload.reasoningContent
          ? { reasoningContent: metadata.rawReasoningPayload.reasoningContent }
          : {}),
      }
    }
    return turnMetadata
  }

}
