import { buildModelProtocolUrl } from '../modelProtocol'
import { resolveNativeReasoningRequest } from '../modelRegistry'
import { resolveRequestMaxTokens } from '../modelRequestBudget'

import { completeModelExchange } from './completion'
import { prepareSummary, readSummary } from './summary'
import { requestHeaders, usesDefaultToolChoice, reviseRejectedRequest } from './requestShared'
import type { ModelProviderAdapter, ModelRequestInput, PreparedModelRequest } from './providerAdapter'
import { toolsToAnthropicFormat, externalToolSchema } from '../toolSchemas'
import { normalizeAnthropicToolMessages } from '../modelMessages'
import { withAnthropicMessageCacheControl, extractStructuredReasoningDelta } from './messageTransforms'
import { AnthropicStreamParser } from './anthropicStream'

function prepare(input: ModelRequestInput): PreparedModelRequest {
  const { config, model, settings, systemPrompt, messages } = input
  const url = buildModelProtocolUrl(config.baseUrl, 'anthropic_messages', config.provider)
  const headers = requestHeaders(config, 'anthropic_messages', input.traceHeaders)
  const anthropicTools = [...toolsToAnthropicFormat(input.tools), ...input.externalTools.map(tool => ({
    name: tool.name, description: tool.description, input_schema: externalToolSchema(tool),
  }))]

  // CRITICAL FIX: Anthropic only honors the LAST 4 cache_control breakpoints
  // per request. Previously every tool got cache_control, which (a) burned
  // all 4 breakpoints on tools, leaving system + history uncached, and
  // (b) ignored markers on earlier tools. Mark only the LAST tool so the
  // entire (system) + (tools-as-one-block) prefix is one cache breakpoint.
  // See: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
  const cachedTools = anthropicTools.length > 0
    ? anthropicTools.map((t, i) => i === anthropicTools.length - 1
        ? { ...(t as object), cache_control: { type: 'ephemeral' } }
        : t)
    : anthropicTools

  const maxTokens = resolveRequestMaxTokens(
    settings.maxTokens || config.maxTokens,
    model?.maxOutputTokens ?? config.maxOutputTokens,
  )
  const anthropicMaxTokens = maxTokens > 0 ? maxTokens : (model?.maxTokens || 8192)
  const temperature = settings.temperature ?? config.temperature ?? 0.7
  const requestMessages = withAnthropicMessageCacheControl(
    normalizeAnthropicToolMessages(messages.filter(m => m.role !== 'system')),
  )
  const requestBody: Record<string, unknown> = {
    model: config.defaultModel,
    max_tokens: anthropicMaxTokens,
    temperature,
    system: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages: requestMessages,
    stream: true,
  }
  const reasoningRequest = resolveNativeReasoningRequest(config.defaultModel, config.reasoning, config.provider, config.modelCapabilities)
  if (reasoningRequest?.thinking) {
    const thinking = { ...reasoningRequest.thinking }
    if (thinking.budget_tokens && thinking.budget_tokens >= anthropicMaxTokens) {
      thinking.budget_tokens = Math.max(1_024, anthropicMaxTokens - 1)
    }
    requestBody.thinking = thinking
  }
  if (reasoningRequest?.outputConfig) requestBody.output_config = reasoningRequest.outputConfig
  if (reasoningRequest?.omitTemperature) delete requestBody.temperature
  if (cachedTools.length > 0) {
    requestBody.tools = cachedTools
    // DeepSeek selects tools automatically when tool_choice is omitted. Keep
    // Thinking enabled because its Thinking mode rejects named tool choices.
    if (!usesDefaultToolChoice(config)) {
      requestBody.tool_choice = { type: 'auto' }
    }
  }
  return { protocol: 'anthropic_messages', url, headers, body: requestBody, reasoning: reasoningRequest, prompt: { system: systemPrompt, tools: anthropicTools, messages: requestMessages } }
}

export const anthropicAdapter: ModelProviderAdapter = {
  protocol: 'anthropic_messages',
  messageFormat: 'anthropic',
  prepare,
  createStream: (request, callbacks) => new AnthropicStreamParser({ ...callbacks, extractReasoningDelta: delta => extractStructuredReasoningDelta(delta, { allowTypedText: true }) }),
  reviseRejectedRequest,
  complete: completeModelExchange,
  prepareSummary: input => prepareSummary('anthropic_messages', input),
  readSummary: payload => readSummary('anthropic_messages', payload),
}
