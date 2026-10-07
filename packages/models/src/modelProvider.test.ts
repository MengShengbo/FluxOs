import { describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '@fluxos/contracts/agentTypes'
import type { ModelProtocol } from './modelProtocol'
import { exchangeModelRequest, getModelProviderAdapter, type ModelRequestInput } from './modelProvider'

const protocols: ModelProtocol[] = ['anthropic_messages', 'openai_chat', 'openai_responses']
function fixture(): ModelRequestInput {
  return { config: { provider: 'custom', apiKey: 'fixture-key', baseUrl: 'http://fixture.invalid', defaultModel: 'unlisted-fixture-model' },
    model: null, settings: { temperature: 0.3 }, systemPrompt: 'system',
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'task' }],
    tools: [], externalTools: [], traceHeaders: { 'x-fixture-trace': 'one' }, promptCacheKey: () => 'fixture-cache' }
}

describe('independent model provider adapters', () => {
  it.each(protocols)('%s prepares an unlisted provider model without runtime services', protocol => {
    const input = fixture(), before = JSON.stringify(input)
    const request = getModelProviderAdapter(protocol).prepare(input)
    expect(request.body.model).toBe('unlisted-fixture-model')
    expect(request.headers['x-fixture-trace']).toBe('one')
    expect(JSON.stringify(input)).toBe(before)
    expect(request.body.tools).toBeUndefined()
    expect(request.body.tool_choice).toBeUndefined()
  })

  it.each(protocols)('%s preserves external schemas and host visibility', protocol => {
    const input = fixture()
    const schema = { type: 'object', properties: { record: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['record'] }
    input.externalTools = [{ name: 'mcp__fixture__write', description: 'fixture', inputSchema: schema, parameters: [] } as unknown as AgentTool]
    input.config.provider = 'openai'
    const request = getModelProviderAdapter(protocol).prepare(input)
    const tools = request.body.tools as any[]
    expect(tools).toHaveLength(1)
    expect(protocol === 'anthropic_messages' ? tools[0].input_schema : protocol === 'openai_chat' ? tools[0].function.parameters : tools[0].parameters).toEqual(schema)
    expect(protocol === 'openai_chat' ? tools[0].function.strict : tools[0].strict).toBeUndefined()
    expect(JSON.stringify(schema)).not.toContain('cache_control')
  })

  it.each(protocols)('%s retries a rejected optional field once before any stream bytes', async protocol => {
    const adapter = getModelProviderAdapter(protocol), request = adapter.prepare(fixture())
    const bodies: Record<string, unknown>[] = []
    const send = vi.fn(async (_request, serialized) => {
      bodies.push(JSON.parse(serialized))
      return bodies.length === 1 ? { success: false, status: 400, error: 'Unsupported parameter: temperature' } : { success: true, data: '' }
    })
    await exchangeModelRequest(adapter, request, { streamId: 42, callbacks: {}, send })
    expect(send).toHaveBeenCalledTimes(2)
    expect(bodies[0].temperature).toBe(0.3)
    expect(bodies[1].temperature).toBeUndefined()
    expect(send.mock.calls[0][0].headers['x-fixture-trace']).toBe('one')
  })

  it.each(protocols.flatMap(protocol => ['parser', 'transport', 'cancel'].map(source => ({ protocol, source }))))(
    '$protocol does not renegotiate after $source', async ({ protocol, source }) => {
      const adapter = getModelProviderAdapter(protocol), request = adapter.prepare(fixture()), controller = new AbortController()
      const send = vi.fn(async (_request, _serialized, line) => {
        if (source === 'parser') line('data: malformed-but-received')
        if (source === 'cancel') controller.abort()
        return { success: false, status: 400, error: 'Unsupported parameter: temperature', receivedStreamData: source === 'transport' }
      })
      await exchangeModelRequest(adapter, request, { streamId: 42, callbacks: {}, signal: controller.signal, send })
      expect(send).toHaveBeenCalledTimes(1)
      expect(request.body.temperature).toBe(0.3)
    },
  )

  it('does not send a new attempt when the retry notification observer cancels', async () => {
    const adapter = getModelProviderAdapter('openai_chat'), controller = new AbortController()
    const send = vi.fn(async () => ({ success: false, status: 400, error: 'Unsupported parameter: temperature' }))
    await exchangeModelRequest(adapter, adapter.prepare(fixture()), { streamId: 42, callbacks: {}, signal: controller.signal,
      send, notify: () => controller.abort() })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('bounds parameter negotiation to five total HTTP attempts', async () => {
    const adapter = getModelProviderAdapter('openai_chat'), request = adapter.prepare(fixture())
    request.body.reasoning_effort = 'max'
    const send = vi.fn(async () => ({ success: false, status: 400, error: 'Invalid reasoning_effort value' }))
    await exchangeModelRequest(adapter, request, { streamId: 42, callbacks: {}, send })
    expect(send).toHaveBeenCalledTimes(5)
  })

  it.each(protocols)('%s leaves network/429/500 retry to the host orchestrator', async protocol => {
    for (const status of [undefined, 429, 500]) {
      const adapter = getModelProviderAdapter(protocol)
      const send = vi.fn(async () => ({ success: false, status, retryAfterMs: 200, error: 'fixture failure' }))
      const exchange = await exchangeModelRequest(adapter, adapter.prepare(fixture()), { streamId: 42, callbacks: {}, send })
      expect(send).toHaveBeenCalledTimes(1)
      expect(adapter.complete(exchange).failure?.error).toMatchObject({ protocol, status, retryAfterMs: 200, receivedStreamData: false,
        kind: status ? 'http' : 'network' })
    }
  })

  it.each(protocols)('%s builds a warm summary without mutating the accepted request', protocol => {
    const adapter = getModelProviderAdapter(protocol), input = fixture(), request = adapter.prepare(input)
    const before = structuredClone(request.body)
    const summary = adapter.prepareSummary({ config: input.config, systemPrompt: 'summary instructions', prompt: 'continue', maxTokens: 123, warmPrefix: request.body })
    expect(request.body).toEqual(before)
    expect(summary.body.stream).toBe(false)
    expect(summary.body[protocol === 'openai_responses' ? 'max_output_tokens' : 'max_tokens']).toBe(123)
    const messages = summary.body[protocol === 'openai_responses' ? 'input' : 'messages'] as unknown[]
    expect(messages).toHaveLength((before[protocol === 'openai_responses' ? 'input' : 'messages'] as unknown[]).length + 1)
    expect(JSON.stringify(messages.at(-1))).toContain('continue')
    if (protocol === 'openai_chat') expect(summary.body.stream_options).toBeUndefined()
  })

  it('preserves nonstream text, response ID and progressive Anthropic usage', () => {
    const adapter = getModelProviderAdapter('anthropic_messages')
    const response = adapter.readSummary(JSON.stringify({ id: 'summary-id', content: [{ type: 'text', text: 'summary' }],
      usage: { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } }))
    expect(response).toMatchObject({ text: 'summary', responseId: 'summary-id', structured: true })
    expect(response.usage.length).toBe(2)
    expect(response.usage.at(-1)).toMatchObject({ input: 27, output: 3, cached: 5, cacheWrite: 2 })
    expect(adapter.readSummary('plain summary')).toEqual({ text: 'plain summary', structured: false, usage: [] })
  })
})
