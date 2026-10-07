import { buildModelProtocolUrl, looksLikeResponsesPreferredModel, toResponsesInput, toResponsesTools } from '../modelProtocol'
import { resolveNativeReasoningRequest } from '../modelRegistry'
import { resolveRequestMaxTokens } from '../modelRequestBudget'
import { setOpenAIPromptCacheLifetime, shouldOmitSamplingTemperature } from '../requestCompatibility'
import { completeModelExchange } from './completion'
import { prepareSummary, readSummary } from './summary'
import { requestHeaders, openAITools, usesDefaultToolChoice, usesPromptCacheKey, reviseRejectedRequest } from './requestShared'
import type { ModelProviderAdapter, ModelRequestInput, PreparedModelRequest } from './providerAdapter'
import { OpenAIResponsesStreamParser } from './openAIResponsesStream'

function prepare(input: ModelRequestInput): PreparedModelRequest {
  const { config, model, settings, messages } = input
  const protocol = 'openai_responses'
  const url = buildModelProtocolUrl(config.baseUrl, protocol, config.provider)
  const headers = requestHeaders(config, protocol, input.traceHeaders)
  const chatTools = openAITools(input)
  const customToolInputs: Record<string, string> = config.modelCapabilities?.responsesCustomTools === true
    && chatTools.some(tool => (tool as { function?: { name?: string } }).function?.name === 'apply_patch')
    ? { apply_patch: 'patch' } : {}
  const responseTools = toResponsesTools(chatTools, customToolInputs)
  const instructions = messages
    .filter(message => message.role === 'system' || message.role === 'developer')
    .map(message => typeof message.content === 'string' ? message.content : '')
    .filter(Boolean)
    .join('\n\n')
  const inputMessages = toResponsesInput(messages, customToolInputs)
  const maxTokens = resolveRequestMaxTokens(
    settings.maxTokens || config.maxTokens,
    model?.maxOutputTokens ?? config.maxOutputTokens,
  )
  const body: Record<string, unknown> = {
    model: config.defaultModel,
    instructions,
    input: inputMessages,
    stream: true,
    store: false,
  }
  if (looksLikeResponsesPreferredModel(config.defaultModel)) {
    body.text = { verbosity: 'low' }
  }
  if (!shouldOmitSamplingTemperature(config)) {
    body.temperature = settings.temperature ?? config.temperature ?? 0.7
  }
  if (maxTokens > 0) body.max_output_tokens = maxTokens
  const reasoningRequest = resolveNativeReasoningRequest(config.defaultModel, config.reasoning, config.provider, config.modelCapabilities)
  const reasoningEffort = reasoningRequest?.reasoningEffort ?? reasoningRequest?.outputConfig?.effort
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort, summary: 'detailed' }
  if (reasoningRequest?.omitTemperature) delete body.temperature
  if (responseTools.length > 0) {
    body.tools = responseTools
    // Keep the tools prefix identical for every request.
    if (!usesDefaultToolChoice(config)) {
      body.tool_choice = 'auto'
    }
    body.parallel_tool_calls = Object.keys(customToolInputs).length === 0
  }
  if (usesPromptCacheKey(config)) {
    body.prompt_cache_key = input.promptCacheKey(config.defaultModel, responseTools)
    setOpenAIPromptCacheLifetime(body, config.defaultModel)
  }

  return { protocol, url, headers, body, reasoning: reasoningRequest, customToolInputs, prompt: { system: instructions, tools: responseTools, messages: inputMessages } }
}

export const openAIResponsesAdapter: ModelProviderAdapter = {
  protocol: 'openai_responses',
  messageFormat: 'openai',
  prepare,
  createStream: (request, callbacks) => new OpenAIResponsesStreamParser(callbacks, request.customToolInputs),
  reviseRejectedRequest,
  complete: completeModelExchange,
  prepareSummary: input => prepareSummary('openai_responses', input),
  readSummary: payload => readSummary('openai_responses', payload),
}
