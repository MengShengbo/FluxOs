import { parseTextToolCalls, stripTextToolCallMarkup } from '@fluxos/contracts/toolCallMarkup'
import { ModelProtocolRequestError } from '../modelProtocol'
import { hasCompleteToolPayloads, isOutputLimitFinishReason } from '../modelStream'
import type { ModelCompletion, ModelExchange } from './providerAdapter'

/** Normalize wire results while preserving each protocol's terminal-event contract. */
export function completeModelExchange(exchange: ModelExchange): ModelCompletion {
  const { request, result, stream, receivedStreamData } = exchange
  const { protocol, url } = request
  const anthropic = protocol === 'anthropic_messages'
  const responses = protocol === 'openai_responses'
  const { inputTokens, outputTokens, cacheReadTokens } = stream
  const totalInput = inputTokens + (anthropic ? cacheReadTokens + (stream.cacheCreationTokens ?? 0) : 0)
  const completion: ModelCompletion = {
    text: stream.text, reasoning: stream.reasoning, toolCalls: [],
    tokens: { input: totalInput, output: outputTokens, cached: cacheReadTokens, total: totalInput + outputTokens, source: 'provider' },
    usage: { inputTokens: anthropic ? Math.max(0, inputTokens + (stream.cacheCreationTokens ?? 0))
      : stream.cacheMissTokens ?? Math.max(0, inputTokens - cacheReadTokens),
      outputTokens, cached: cacheReadTokens, totalInputTokens: totalInput },
    shouldRecordUsage: inputTokens > 0 || outputTokens > 0,
    cache: { inputTokens: totalInput, cacheReadTokens, ...(anthropic ? { cacheCreationTokens: stream.cacheCreationTokens ?? 0 } : {}) },
    interrupted: !responses && stream.interrupted === true,
    reasoningTokenCount: stream.reasoningTokens || Math.max(1, Math.ceil(stream.reasoning.length / 4)),
    rawReasoningPayload: anthropic
      ? (stream.rawReasoningBlocks?.length ? { provider: 'anthropic', blocks: stream.rawReasoningBlocks } : undefined)
      : (stream.reasoning ? { provider: 'openai-compatible', blocks: [], reasoningContent: stream.reasoning } : undefined),
    rememberRequest: result.success,
  }
  const fail = (message: string, kind: 'http' | 'network' | 'stream' | 'response_shape', report = true): ModelCompletion => {
    completion.failure = { error: new ModelProtocolRequestError(message, { protocol, url, kind, receivedStreamData,
      ...(kind === 'http' || kind === 'network' ? { status: result.status, retryAfterMs: result.retryAfterMs } : {}),
    }), reportAsRequestError: report, preservePartial: kind !== 'response_shape' }
    if (anthropic) completion.rememberRequest = false
    return completion
  }
  if (!result.success && !stream.sawTerminalEvent) {
    const message = (anthropic && stream.streamFailure) || result.error
      || (anthropic ? 'Anthropic request failed' : responses ? 'Responses request failed' : 'Model request failed')
    return fail(message, result.status ? 'http' : 'network')
  }
  const streamFailure = stream.streamFailure || (anthropic && !stream.sawTerminalEvent ? 'Anthropic stream ended before a terminal event' : '')
  if (streamFailure) return fail(streamFailure, 'stream', !(responses && isOutputLimitFinishReason(streamFailure)))

  let entries = stream.toolCalls
  if (!anthropic && !stream.sawTerminalEvent) {
    const textTools = parseTextToolCalls(completion.text)
    const visibleText = Boolean(stripTextToolCallMarkup(completion.text, { stripIncomplete: true }))
    const complete = hasCompleteToolPayloads(entries)
    if (!visibleText && !complete && textTools.toolCalls.length === 0) {
      return fail(`${responses ? 'Responses' : 'Model'} stream ended before a terminal event`, 'response_shape')
    }
    if (!complete) entries = []
    if (textTools.containsToolMarkup && textTools.toolCalls.length === 0) {
      completion.text = stripTextToolCallMarkup(completion.text, { stripIncomplete: true })
    }
  }
  completion.toolCalls = entries.map(entry => {
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(entry.argumentsJson || '{}') } catch { /* Runtime schema validation owns dispatch. */ }
    return { id: entry.id, name: entry.name, arguments: args }
  })
  if (!anthropic) {
    const textTools = parseTextToolCalls(completion.text)
    if (textTools.containsToolMarkup) {
      completion.text = textTools.cleanedText
      if (completion.toolCalls.length === 0 && textTools.toolCalls.length > 0) completion.toolCalls.push(...textTools.toolCalls)
    }
  }
  return completion
}
