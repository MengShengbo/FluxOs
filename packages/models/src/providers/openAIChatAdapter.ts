import { buildModelProtocolUrl } from '../modelProtocol'
import { resolveNativeReasoningRequest } from '../modelRegistry'
import { resolveRequestMaxTokens } from '../modelRequestBudget'
import { setOpenAIChatMaxTokens, setOpenAIPromptCacheLifetime, shouldOmitSamplingTemperature, supportsSamplingTemperature } from '../requestCompatibility'
import { completeModelExchange } from './completion'
import { prepareSummary, readSummary } from './summary'
import { requestHeaders, openAITools, usesDefaultToolChoice, usesPromptCacheKey, reviseRejectedRequest } from './requestShared'
import type { ModelProviderAdapter, ModelRequestInput, PreparedModelRequest } from './providerAdapter'
import { withOpenRouterCacheControl, extractStructuredReasoningDelta } from './messageTransforms'
import { OpenAIChatStreamParser } from './openAIChatStream'

function prepare(input: ModelRequestInput): PreparedModelRequest {
  const { config, model, settings, messages } = input
  const url = buildModelProtocolUrl(config.baseUrl, 'openai_chat', config.provider)
  const headers = requestHeaders(config, 'openai_chat', input.traceHeaders)
  const openaiTools = openAITools(input)

  const requestMessages = config.provider === 'openrouter'
    ? withOpenRouterCacheControl(messages)
    : messages

  const maxTokens = resolveRequestMaxTokens(
    settings.maxTokens || config.maxTokens,
    model?.maxOutputTokens ?? config.maxOutputTokens,
  )
  const body: Record<string, unknown> = {
    model: config.defaultModel,
    messages: requestMessages,
    stream: true,
  }
  if (!shouldOmitSamplingTemperature(config) && supportsSamplingTemperature(config)) {
    body.temperature = settings.temperature ?? config.temperature ?? 0.7
  }
  if (maxTokens > 0) setOpenAIChatMaxTokens(body, maxTokens, config.provider, config.defaultModel)
  const reasoningRequest = resolveNativeReasoningRequest(config.defaultModel, config.reasoning, config.provider, config.modelCapabilities)
  if (reasoningRequest?.thinking) body.thinking = reasoningRequest.thinking
  if (reasoningRequest?.reasoningEffort) body.reasoning_effort = reasoningRequest.reasoningEffort
  if (reasoningRequest?.outputConfig) body.output_config = reasoningRequest.outputConfig
  if (reasoningRequest?.omitTemperature) delete body.temperature
  // OpenAI streaming spec: usage is NOT sent unless we opt in via
  // stream_options.include_usage. Without this, mimo / Kimi / DeepSeek
  // / OpenRouter / Qwen all return zero token counts, the per-call
  // record gets dropped by tokenStatsStore's zero-value guard, and
  // the Settings → Usage panel stays empty no matter how much the
  // user spends. The OpenAI Cookbook explicitly recommends always
  // setting this when you stream and care about telemetry.
  // https://platform.openai.com/docs/api-reference/chat/create#chat-create-stream_options
  body.stream_options = { include_usage: true }
  if (openaiTools.length > 0) {
    body.tools = openaiTools
    if (!usesDefaultToolChoice(config)) {
      body.tool_choice = 'auto'
    }
    // Most OpenAI-compatible providers default this to true, but some
    // (older Azure deployments, certain proxies) require explicit opt-in
    // to emit multiple tool_calls in a single assistant turn. Without
    // parallel_tool_calls=true the model is silently forced into one
    // tool call per turn, which produces the "thinks→one search→thinks"
    // loop users see in chat.
    body.parallel_tool_calls = true
  }
  if (usesPromptCacheKey(config)) {
    body.prompt_cache_key = input.promptCacheKey(config.defaultModel, openaiTools)
    setOpenAIPromptCacheLifetime(body, config.defaultModel)
  }
  return { protocol: 'openai_chat', url, headers, body, reasoning: reasoningRequest, prompt: { system: (messages.find(m => m.role === 'system')?.content as string) || '', tools: openaiTools, messages: requestMessages } }
}

export const openAIChatAdapter: ModelProviderAdapter = {
  protocol: 'openai_chat',
  messageFormat: 'openai',
  prepare,
  createStream: (request, callbacks) => new OpenAIChatStreamParser({ ...callbacks, extractReasoningDelta: delta => extractStructuredReasoningDelta(delta) }),
  reviseRejectedRequest,
  complete: completeModelExchange,
  prepareSummary: input => prepareSummary('openai_chat', input),
  readSummary: payload => readSummary('openai_chat', payload),
}
