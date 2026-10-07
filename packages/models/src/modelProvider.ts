import { anthropicAdapter } from './providers/anthropicAdapter'
import { openAIChatAdapter } from './providers/openAIChatAdapter'
import { openAIResponsesAdapter } from './providers/openAIResponsesAdapter'
import type { ModelProtocol } from './modelProtocol'
import type { ModelProviderAdapter, ModelExchange, ModelExchangeOptions, PreparedModelRequest } from './providers/providerAdapter'
export type * from './providers/providerAdapter'

const adapters: Readonly<Record<ModelProtocol, ModelProviderAdapter>> = {
  anthropic_messages: anthropicAdapter,
  openai_chat: openAIChatAdapter,
  openai_responses: openAIResponsesAdapter,
}

/** Providers using an existing wire protocol only need config/capability registration. */
export function getModelProviderAdapter(protocol: ModelProtocol): ModelProviderAdapter {
  return adapters[protocol]
}

/** One bounded parameter-negotiation loop, independent of host retry/backoff policy. */
export async function exchangeModelRequest(
  adapter: ModelProviderAdapter, request: PreparedModelRequest, options: ModelExchangeOptions,
): Promise<ModelExchange> {
  const parser = adapter.createStream(request, options.callbacks)
  let serializedBody = JSON.stringify(request.body)
  let requestStartedAt = Date.now()
  let receivedStreamData = false
  const send = async () => {
    serializedBody = JSON.stringify(request.body)
    requestStartedAt = Date.now()
    const result = await options.send(request, serializedBody, line => parser.handleLine(line), {
      streamId: options.streamId, signal: options.signal, retry: false,
    }, () => parser.snapshot())
    receivedStreamData ||= parser.hasReceivedData || result.receivedStreamData === true
    return result
  }
  let result = await send()
  for (let retry = 0; !result.success && retry < 4; retry += 1) {
    // Every protocol must stop renegotiation once *any* response bytes were observed.
    if (options.signal?.aborted || receivedStreamData) break
    const message = adapter.reviseRejectedRequest(request, result)
    if (!message) break
    options.notify?.(message)
    // Notification observers may synchronously stop the run.
    if (options.signal?.aborted) break
    result = await send()
  }
  return { request, result, stream: parser.snapshot(), receivedStreamData, serializedBody,
    requestStartedAt, responseReceivedAt: Date.now() }
}
