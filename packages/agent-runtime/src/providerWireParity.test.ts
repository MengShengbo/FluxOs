import { describe, expect, it, vi } from 'vitest'
import type { AgentTurn } from '@fluxos/contracts/agentTypes'
import type { APIConfig } from '@fluxos/contracts/stateTypes'
import type { ToolExecutor } from '@fluxos/contracts/toolExecutor'
import type { ModelProtocol } from '@fluxos/models/modelProtocol'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'

const cases: Array<[ModelProtocol, APIConfig['provider'], string, boolean]> = [
  ['anthropic_messages', 'anthropic', 'claude-3-7-sonnet', false],
  ['anthropic_messages', 'custom', 'claude-sonnet-4-6', false],
  ['openai_chat', 'openai', 'gpt-5.6', false],
  ['openai_chat', 'deepseek', 'deepseek-reasoner', false],
  ['openai_chat', 'openrouter', 'fixture-model', false],
  ['openai_chat', 'kimi', 'kimi-k2.5', false],
  ['openai_responses', 'openai', 'gpt-5.6', false],
  ['openai_responses', 'openai', 'gpt-5.6', true],
]

describe('provider wire parity frozen before adapter extraction', () => {
  it.each(cases)('%s / %s / %s / custom=%s', async (protocol, provider, model, custom) => {
    const state = new DefaultAgentStateProvider({ provider, apiKey: 'fixture-key', baseUrl: 'http://fixture.invalid/v1', model }, '/fixture/workspace')
    const config: APIConfig = { ...state.getActiveConfig()!, reasoning: { enabled: true, effort: 'high' },
      maxTokens: 4096, maxOutputTokens: 8192, customHeaders: { 'x-fixture': 'value' },
      modelCapabilities: { ...state.getActiveConfig()?.modelCapabilities, responsesCustomTools: custom } }
    let request: unknown
    const streamMessage = vi.fn(async (url: string, headers: Record<string, string>, body: string, line: (value: string) => void) => {
      expect(headers['x-client-request-id']).toMatch(/^[0-9a-f-]{36}$/)
      expect(headers['x-fluxagent-conversation-id']).toMatch(/^agent-/)
      request = { url, headers: { ...headers,
        'x-client-request-id': '<generated-request-id>',
        'x-fluxagent-conversation-id': '<generated-conversation-id>',
        'User-Agent': headers['User-Agent'].replace(/\([^)]*\)$/, '(platform; arch)'),
      }, body: JSON.parse(body) }
      const frames = protocol === 'anthropic_messages' ? [
        { type: 'message_start', message: { id: 'response-fixture', usage: { input_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture answer' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' },
      ] : protocol === 'openai_responses' ? [
        { type: 'response.completed', response: { id: 'response-fixture', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'fixture answer' }] }], usage: { input_tokens: 20, output_tokens: 3, input_tokens_details: { cached_tokens: 5 } } } },
      ] : [{ id: 'response-fixture', choices: [{ delta: { content: 'fixture answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 5 } } }]
      for (const frame of frames) line(`data: ${JSON.stringify(frame)}`)
      return { success: true, data: '' }
    })
    const engine = new AgentEngine({ mode: 'vibe', workspacePath: '/fixture/workspace', gitEnabled: false,
      allowedTools: ['read_file', 'apply_patch'], temperature: 0.2 }, { streamMessage, streamAbort: vi.fn() } as unknown as ToolExecutor, state)
    const messages = [{ role: 'system', content: 'fixture system' }, { role: 'user', content: 'fixture input' }]
    try {
      const internal = engine as any
      const turn: AgentTurn = await internal.callModelProvider(protocol, config, null, messages, Date.now())
      expect({ request, text: turn.content, toolCalls: turn.toolCalls, tokens: turn.metadata?.tokens,
        reasoningEnabled: turn.metadata?.reasoningEnabled, reasoningEffort: turn.metadata?.reasoningEffort }).toMatchSnapshot()
    } finally { engine.destroy() }
  })
})
