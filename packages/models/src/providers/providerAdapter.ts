import type { AgentConfig, AgentTool, RawReasoningPayload, TokenUsage, ToolCall, AnthropicThinkingBlock } from '@fluxos/contracts/agentTypes'
import type { APIConfig, APIModel } from '@fluxos/contracts/stateTypes'
import type { RequestOptions, Result } from '@fluxos/contracts/toolExecutor'
import type { ModelProtocol, ModelProtocolRequestError } from '../modelProtocol'
import type { resolveNativeReasoningRequest } from '../modelRegistry'

export type ModelMessages = Array<Record<string, unknown>>
export interface ModelRequestInput {
  config: APIConfig
  model: APIModel | null
  settings: Pick<AgentConfig, 'maxTokens' | 'temperature'>
  systemPrompt: string
  messages: ModelMessages
  /** The host has already applied current mode, permission and catalog visibility. */
  tools: readonly AgentTool[]
  externalTools: readonly AgentTool[]
  traceHeaders: Record<string, string>
  promptCacheKey(model: string, tools: unknown[]): string
}

export interface PreparedModelRequest {
  protocol: ModelProtocol
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  reasoning: ReturnType<typeof resolveNativeReasoningRequest>
  prompt: { system: string; tools: unknown[]; messages: ModelMessages }
  customToolInputs?: Record<string, string>
}

export interface ModelStreamSnapshot {
  text: string
  reasoning: string
  toolCalls: Array<{ id: string; name: string; argumentsJson: string }>
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens?: number
  cacheMissTokens?: number | null
  reasoningTokens?: number
  rawReasoningBlocks?: AnthropicThinkingBlock[]
  sawTerminalEvent: boolean
  interrupted?: boolean
  streamFailure?: string
  receivedData: boolean
}

export interface ModelStreamCallbacks {
  onTextDelta?(text: string): void
  onReasoningDelta?(text: string): void
  onToolCallDelta?(call: { id: string; name: string; argumentsJson: string }): void
  onUsage?(usage: TokenUsage): void
  onResponseId?(id: string): void
}

export interface ModelResponseStream {
  readonly hasReceivedData: boolean
  handleLine(line: string): void
  snapshot(): ModelStreamSnapshot
}

export interface ModelExchange {
  request: PreparedModelRequest
  result: Result<string>
  stream: ModelStreamSnapshot
  receivedStreamData: boolean
  serializedBody: string
  requestStartedAt: number
  responseReceivedAt: number
}

export interface ModelCompletion {
  text: string
  reasoning: string
  toolCalls: ToolCall[]
  tokens: TokenUsage & { input: number; output: number; cached: number; total: number }
  /** Uncached/provider-billable input is distinct from complete context input. */
  usage: { inputTokens: number; outputTokens: number; cached: number; totalInputTokens: number }
  shouldRecordUsage: boolean
  cache: { inputTokens: number; cacheReadTokens: number; cacheCreationTokens?: number }
  interrupted: boolean
  reasoningTokenCount: number
  rawReasoningPayload?: RawReasoningPayload
  /** The host decides how to retain partial output and create an interrupted turn. */
  failure?: { error: ModelProtocolRequestError; reportAsRequestError: boolean; preservePartial: boolean }
  rememberRequest: boolean
}

export interface ModelSummaryInput {
  config: APIConfig
  systemPrompt: string
  prompt: string
  maxTokens: number
  warmPrefix?: Record<string, unknown>
}

export interface ModelSummaryResponse {
  text: string
  structured: boolean
  responseId?: string
  usage: TokenUsage[]
}

/** No sessions, tools executor, persistence, UI, or host policy dependencies. */
export interface ModelProviderAdapter {
  readonly protocol: ModelProtocol
  readonly messageFormat: 'openai' | 'anthropic'
  prepare(input: ModelRequestInput): PreparedModelRequest
  createStream(request: PreparedModelRequest, callbacks: ModelStreamCallbacks): ModelResponseStream
  reviseRejectedRequest(request: PreparedModelRequest, result: Result<string>): string | undefined
  complete(exchange: ModelExchange): ModelCompletion
  prepareSummary(input: ModelSummaryInput): Pick<PreparedModelRequest, 'url' | 'headers' | 'body'>
  readSummary(payload: string): ModelSummaryResponse
}

export interface ModelExchangeOptions {
  signal?: AbortSignal
  streamId: number
  callbacks: ModelStreamCallbacks
  notify?(message: string): void
  send(request: PreparedModelRequest, serializedBody: string, onLine: (line: string) => void,
    options: RequestOptions, state: () => ModelStreamSnapshot): Promise<Result<string>>
}
