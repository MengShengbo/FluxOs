import { describe, expect, it, vi } from 'vitest'
import type { AgentTurn } from '@fluxos/contracts/agentTypes'
import type { ToolExecutor } from '@fluxos/contracts/toolExecutor'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'

describe('provider retry after response data', () => {
  it.each(['text', 'reasoning', 'tool', 'transport'] as const)(
    'does not resend Chat after %s data and an optional parameter rejection', async kind => {
      const state = new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'fixture', baseUrl: 'http://fixture.invalid', model: 'fixture-model' }, process.cwd())
      const send = vi.fn(async (_url: string, _headers: unknown, _body: string, onLine: (line: string) => void) => {
        if (kind !== 'transport') onLine(`data: ${JSON.stringify({ choices: [{ delta: kind === 'text'
          ? { content: 'Keep the partial answer.' }
          : kind === 'reasoning' ? { reasoning_content: 'Keep the partial reasoning.' }
            : { tool_calls: [{ index: 0, id: 'partial', function: { name: 'write_file', arguments: '{"path":' } }] } }] })}`)
        return { success: false, status: 400, error: 'Unsupported parameter: stream_options', receivedStreamData: true }
      })
      const engine = new AgentEngine({ mode: 'vibe', workspacePath: process.cwd(), gitEnabled: false },
        { streamMessage: send, streamAbort: vi.fn() } as unknown as ToolExecutor, state)
      try {
        const turn = await (engine as unknown as { callModelProvider(...args: unknown[]): Promise<AgentTurn> })
          .callModelProvider('openai_chat', state.getActiveConfig(), state.getActiveModel(), [{ role: 'user', content: 'fixture' }], Date.now())
          .catch(() => undefined)
        expect(send).toHaveBeenCalledTimes(1)
        if (kind === 'text') expect(turn?.content).toContain('Keep the partial answer.')
        if (kind === 'reasoning') expect(turn?.metadata?.thinking?.content).toBe('Keep the partial reasoning.')
        expect(turn?.toolCalls ?? []).toHaveLength(0)
      } finally { engine.destroy() }
    },
  )
})
