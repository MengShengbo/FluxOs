import type { APIConfig } from '@fluxos/contracts/stateTypes'
import type { Result } from '@fluxos/contracts/toolExecutor'
import { createFluxAgentRequestHeaders } from '../clientIdentity'
import { looksLikeDeepSeekModel, looksLikeResponsesPreferredModel, type ModelProtocol } from '../modelProtocol'
import { toolsToOpenAIFormat, externalToolSchema } from '../toolSchemas'
import { downgradeReasoningEffort, extractUnsupportedRequestParam, isReasoningEffortValueError,
  removeAnthropicCompatibleRequestParam, removeOpenAICompatibleRequestParam } from '../requestCompatibility'
import type { ModelRequestInput, PreparedModelRequest } from './providerAdapter'

export function requestHeaders(config: APIConfig, protocol: ModelProtocol, trace: Record<string, string> = {}, turn = true): Record<string, string> {
  const anthropic = protocol === 'anthropic_messages'
  const model = config.defaultModel.toLowerCase()
  const beta = turn && (model.includes('claude-3-7') || model.includes('claude-3.7'))
  const headers = createFluxAgentRequestHeaders({
    'Content-Type': 'application/json',
    ...(anthropic ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01',
      ...(config.provider === 'anthropic' ? {} : { Authorization: `Bearer ${config.apiKey}` }),
      ...(beta ? { 'anthropic-beta': 'token-efficient-tools-2025-02-19' } : {}),
    } : { Authorization: `Bearer ${config.apiKey}` }),
    ...config.customHeaders,
    ...trace,
  })
  // Existing Messages turn routes did not include OpenRouter attribution; summaries did.
  if (config.provider === 'openrouter' && (!anthropic || !turn)) {
    headers['HTTP-Referer'] = 'https://fluxagent.dev'
    headers['X-Title'] = 'FluxAgent'
  }
  return headers
}

export function openAITools(input: ModelRequestInput): object[] {
  if (input.config.modelCapabilities?.tools === false) return []
  return [...toolsToOpenAIFormat(input.tools, { strict: input.config.provider === 'openai' }),
    ...input.externalTools.map(tool => ({ type: 'function', function: {
      name: tool.name, description: tool.description, parameters: externalToolSchema(tool),
    } }))]
}

export function usesDefaultToolChoice(config: APIConfig): boolean {
  return config.provider === 'deepseek' || looksLikeDeepSeekModel(config.defaultModel)
}

export function usesPromptCacheKey(config: APIConfig): boolean {
  return config.provider === 'openai' || config.provider === 'kimi' || looksLikeResponsesPreferredModel(config.defaultModel)
    || /(?:^|[/_.:-])(?:kimi|moonshot)(?:$|[/_.:-])/i.test(config.defaultModel)
}

export function reviseRejectedRequest(request: PreparedModelRequest, result: Result<string>): string | undefined {
  const { protocol, body, headers } = request
  if (result.status !== 400 && !(protocol === 'anthropic_messages' && result.status === 422)) return
  if (isReasoningEffortValueError(result.error)) {
    const fallback = downgradeReasoningEffort(body)
    if (fallback) return `${protocol === 'openai_responses' ? 'Responses endpoint' : 'Provider'} rejected reasoning effort ${fallback.from}; retrying with ${fallback.to}.`
  }
  const param = extractUnsupportedRequestParam(result.error)
  if (!param) return
  if (protocol === 'anthropic_messages') {
    if (removeAnthropicCompatibleRequestParam(body, headers, param)) return `Messages endpoint rejected "${param}"; retrying without that optional feature.`
  } else if (removeOpenAICompatibleRequestParam(body, param)) {
    return `${protocol === 'openai_responses' ? 'Responses endpoint' : 'Provider'} rejected "${param}"; retrying without that request parameter.`
  }
}
