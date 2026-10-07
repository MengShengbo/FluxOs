import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { AgentTurn } from '@fluxos/contracts/agentTypes'
import type { ModelProtocol } from '@fluxos/models/modelProtocol'
import { NodeToolExecutor } from '@fluxos/tools/nodeToolExecutor'
import { AgentEngine } from '../agentEngine'
import { DefaultAgentStateProvider } from '../runtime/stateProvider'

const protocols: ModelProtocol[] = ['anthropic_messages', 'openai_chat', 'openai_responses']
function frames(protocol: ModelProtocol, complete = true): unknown[] {
  if (protocol === 'anthropic_messages') return [
    { type: 'message_start', message: { id: 'reply-fixture', usage: { input_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '网络样本🙂' } },
    ...(complete ? [{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }] : []),
  ]
  if (protocol === 'openai_responses') return [
    { type: 'response.output_text.delta', delta: '网络样本🙂' },
    ...(complete ? [{ type: 'response.completed', response: { id: 'reply-fixture', status: 'completed', output: [],
      usage: { input_tokens: 20, output_tokens: 3, input_tokens_details: { cached_tokens: 5 } } } }] : []),
  ]
  return [{ id: 'reply-fixture', choices: [{ delta: { content: '网络样本🙂' }, finish_reason: null }] },
    ...(complete ? [{ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 5 } } }] : []),
  ]
}

describe('provider adapters through real loopback HTTP/SSE', () => {
  it.each(protocols.flatMap(protocol => ['complete', 'reject-optional', 'cancel', 'disconnect'].map(mode => ({ protocol, mode }))))(
    '$protocol / $mode', async ({ protocol, mode }) => {
      const requests: Array<{ url: string; body: any }> = []
      const sockets = new Set<ServerResponse>()
      const timers = new Set<ReturnType<typeof setTimeout>>()
      const server = createServer((req, res) => {
        sockets.add(res)
        res.on('close', () => sockets.delete(res))
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('end', () => {
          requests.push({ url: req.url || '', body: JSON.parse(Buffer.concat(chunks).toString()) })
          if (mode === 'reject-optional' && requests.length === 1) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Unsupported parameter: temperature' } }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          const bytes = Buffer.from(frames(protocol, !['cancel', 'disconnect'].includes(mode)).map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''))
          // Deliberately split an actual UTF-8 codepoint across transport chunks.
          const split = bytes.indexOf(Buffer.from('🙂')) + 1
          res.write(bytes.subarray(0, split))
          const timer = setTimeout(() => {
            timers.delete(timer)
            if (res.destroyed) return
            res.write(bytes.subarray(split))
            if (mode === 'disconnect') {
              const drop = setTimeout(() => { timers.delete(drop); res.destroy() }, 30)
              timers.add(drop)
            } else if (mode !== 'cancel') res.end()
          }, 10)
          timers.add(timer)
        })
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No fixture server')
      const state = new DefaultAgentStateProvider({ provider: protocol === 'anthropic_messages' ? 'anthropic' : 'custom',
        apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${address.port}`, model: 'fixture-model', reasoning: { enabled: false } }, process.cwd())
      const executor = new NodeToolExecutor(process.cwd())
      const send = vi.spyOn(executor, 'streamMessage')
      const engine = new AgentEngine({ mode: 'vibe', workspacePath: process.cwd(), gitEnabled: false, temperature: 0.3 }, executor, state)
      const internal = engine as any
      internal.abortController = new AbortController()
      engine.subscribe(event => { if (mode === 'cancel' && event.type === 'stream:delta') engine.abort() })
      try {
        const turn: AgentTurn = await internal.callModelProvider(protocol, state.getActiveConfig(), null,
          [{ role: 'system', content: 'fixture' }, { role: 'user', content: 'request' }], Date.now())
        expect(turn.content).toBe('网络样本🙂')
        expect(turn.toolCalls ?? []).toHaveLength(0)
        expect(requests).toHaveLength(mode === 'reject-optional' ? 2 : 1)
        expect(send).toHaveBeenCalledTimes(requests.length)
        expect(requests[0].url).toContain(protocol === 'anthropic_messages' ? '/messages' : protocol === 'openai_responses' ? '/responses' : '/chat/completions')
        if (mode === 'reject-optional') {
          expect(requests[0].body.temperature).toBe(0.3)
          expect(requests[1].body.temperature).toBeUndefined()
        }
        if (mode === 'complete' || mode === 'reject-optional') {
          expect(turn.metadata?.tokens).toMatchObject({ input: protocol === 'anthropic_messages' ? 27 : 20, output: 3, cached: 5 })
          expect(engine.getTokenUsage()).toEqual({ input: protocol === 'anthropic_messages' ? 27 : 20, output: 3 })
        } else {
          expect(turn.metadata?.interrupted).toBe(true)
          if (mode === 'disconnect') expect(turn.metadata?.internalKind).toBe('request_error')
        }
      } finally {
        engine.destroy()
        for (const timer of timers) clearTimeout(timer)
        for (const socket of sockets) socket.destroy()
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
        send.mockRestore()
      }
    },
  )
})
