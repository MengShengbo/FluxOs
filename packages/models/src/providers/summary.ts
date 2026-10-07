import { buildModelProtocolUrl, toResponsesInput, type ModelProtocol } from '../modelProtocol'
import { extractModelResponseText } from '../modelResponseText'
import { setOpenAIChatMaxTokens } from '../requestCompatibility'
import { requestHeaders } from './requestShared'
import { AnthropicStreamParser } from './anthropicStream'
import { OpenAIChatStreamParser } from './openAIChatStream'
import { OpenAIResponsesStreamParser } from './openAIResponsesStream'
import type { ModelSummaryInput, ModelSummaryResponse, PreparedModelRequest } from './providerAdapter'

export function prepareSummary(protocol: ModelProtocol, input: ModelSummaryInput): Pick<PreparedModelRequest, 'url' | 'headers' | 'body'> {
  const { config, prompt, maxTokens, systemPrompt, warmPrefix } = input
  let body: Record<string, unknown>
  if (warmPrefix) {
    body = JSON.parse(JSON.stringify(warmPrefix))
    if (protocol === 'openai_responses') {
      body.input = [...((body.input as unknown[]) || []), ...toResponsesInput([{ role: 'user', content: prompt }])]
      body.max_output_tokens = maxTokens
      body.store = false
    } else {
      body.messages = [...((body.messages as unknown[]) || []), { role: 'user', content: prompt }]
      if (protocol === 'anthropic_messages') body.max_tokens = maxTokens
      else { setOpenAIChatMaxTokens(body, maxTokens, config.provider, config.defaultModel); delete body.stream_options }
    }
    body.stream = false
  } else if (protocol === 'anthropic_messages') {
    body = { model: config.defaultModel, system: systemPrompt, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens }
  } else if (protocol === 'openai_responses') {
    body = { model: config.defaultModel, instructions: systemPrompt, input: toResponsesInput([{ role: 'user', content: prompt }]), max_output_tokens: maxTokens, store: false }
  } else {
    body = { model: config.defaultModel, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }], max_tokens: maxTokens, stream: false }
  }
  if (protocol === 'openai_chat') setOpenAIChatMaxTokens(body, maxTokens, config.provider, config.defaultModel)
  return { body, headers: requestHeaders(config, protocol, {}, false), url: buildModelProtocolUrl(config.baseUrl, protocol, config.provider) }
}

export function readSummary(protocol: ModelProtocol, raw: string): ModelSummaryResponse {
  const response: ModelSummaryResponse = { text: extractModelResponseText(protocol, raw), structured: false, usage: [] }
  try {
    const payload = JSON.parse(raw)
    if (typeof payload.id === 'string') response.responseId = payload.id
    response.structured = true
    const onUsage = (usage: ModelSummaryResponse['usage'][number]) => { response.usage.push(usage) }
    if (protocol === 'openai_responses') new OpenAIResponsesStreamParser({ onUsage }).handleLine(`data: ${JSON.stringify({ type: 'response.completed', response: payload })}`)
    else if (protocol === 'openai_chat') new OpenAIChatStreamParser({ onUsage, extractReasoningDelta: () => '' }).handleLine(`data: ${raw}`)
    else {
      const parser = new AnthropicStreamParser({ onUsage, extractReasoningDelta: () => '' })
      parser.handleLine(`data: ${JSON.stringify({ type: 'message_start', message: payload })}`)
      parser.handleLine(`data: ${JSON.stringify({ type: 'message_delta', usage: payload.usage })}`)
    }
  } catch { /* Plain response text is accepted by the existing summary contract. */ }
  return response
}
