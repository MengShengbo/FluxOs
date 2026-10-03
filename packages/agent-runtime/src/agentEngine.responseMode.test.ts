import { describe, expect, it, vi } from 'vitest'
import { AgentEngine, type AgentEventType } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'
import type { ToolExecutor } from '@fluxagentcore/contracts/toolExecutor'

describe('runtime-inferred response mode', () => {
  it.each([1, 3])('counts every tool dispatch toward a budget of %i tool rounds', async maxToolRounds => {
    const streamMessage = vi.fn(async (_url, _headers, _serialized, onLine) => {
      const request = streamMessage.mock.calls.length
      const declaring = request <= 6
      onLine(`data: ${JSON.stringify({ choices: [{ delta: declaring
        ? { tool_calls: [{ index: 0, id: `mode-${request}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"source.ts"}' } }] }
        : { content: 'Unexpected completion' }, finish_reason: declaring ? 'tool_calls' : 'stop' }] })}`)
      onLine('data: [DONE]')
      return { success: true, data: '' }
    })
    const state = new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'test', baseUrl: 'http://example.test', model: 'test-model', contextWindow: 100_000, maxTokens: 4096 }, process.cwd())
    const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', gitEnabled: false, maxToolRounds }, { streamMessage, readFile: vi.fn(async () => ({ success: true, data: 'source' })) } as unknown as ToolExecutor, state)
    const events: AgentEventType[] = []
    engine.subscribe(event => events.push(event))
    vi.spyOn(engine as any, 'prepareContextWindow').mockResolvedValue(undefined)
    try {
      await engine.run('Inspect')
      expect(streamMessage).toHaveBeenCalledTimes(maxToolRounds)
      expect(events).toContainEqual(expect.objectContaining({
        type: 'turn:complete',
        turn: expect.objectContaining({ content: expect.stringContaining(`Stopped after ${maxToolRounds} tool rounds`), metadata: expect.objectContaining({ interrupted: true }) }),
      }))
    } finally {
      engine.destroy()
    }
  })

  it.each(['anthropic', 'responses'] as const)('promotes %s tool requests directly without a classification request', async protocol => {
    const bodies: Record<string, any>[] = []
    const streamMessage = vi.fn(async (_url, _headers, serialized, onLine) => {
      const body = JSON.parse(serialized)
      bodies.push(body)
      const declaring = bodies.length === 1
      const send = (value: unknown) => onLine(`data: ${JSON.stringify(value)}`)
      if (protocol === 'anthropic') {
        send({ type: 'content_block_start', index: 0, content_block: declaring
          ? { type: 'tool_use', id: 'mode-1', name: 'read_file', input: { path: 'source.ts' } }
          : { type: 'text', text: 'Done' } })
        send({ type: 'content_block_stop', index: 0 })
        send({ type: 'message_delta', delta: { stop_reason: declaring ? 'tool_use' : 'end_turn' } })
        send({ type: 'message_stop' })
      } else {
        if (declaring) send({ type: 'response.output_item.added', output_index: 0, item: {
          type: 'function_call', id: 'mode-item', call_id: 'mode-1', name: 'read_file', arguments: '{"path":"source.ts"}',
        } })
        send({ type: 'response.completed', response: { output: declaring ? [] : [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }] } })
      }
      return { success: true, data: '' }
    })
    const state = new DefaultAgentStateProvider({
      provider: protocol === 'anthropic' ? 'anthropic' : 'openai', apiKey: 'test', baseUrl: 'http://example.test',
      model: protocol === 'anthropic' ? 'claude-opus-4-1' : 'gpt-5-codex', reasoning: { enabled: false, effort: 'none' },
      contextWindow: 100_000, maxTokens: 4096,
    }, process.cwd())
    const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', gitEnabled: false, maxToolRounds: 3 }, { streamMessage, readFile: vi.fn(async () => ({ success: true, data: 'source' })) } as unknown as ToolExecutor, state)
    vi.spyOn(engine as any, 'prepareContextWindow').mockResolvedValue(undefined)
    try {
      await engine.run('Inspect')
      expect(bodies).toHaveLength(2)
      expect(bodies[0].tool_choice).toEqual(protocol === 'anthropic' ? { type: 'auto' } : 'auto')
      expect(bodies[1].tool_choice).toEqual(protocol === 'anthropic' ? { type: 'auto' } : 'auto')
      expect(engine.getWorkExecutionSnapshot().runs[0]).toMatchObject({ responseMode: 'task', status: 'completed' })
    } finally {
      engine.destroy()
    }
  })

  it.each(['chat', 'task'] as const)('infers %s from visible output and actual tools across successive runs', async mode => {
    const bodies: Record<string, any>[] = []
    const events: AgentEventType[] = []
    const streamMessage = vi.fn(async (_url, _headers, serialized, onLine) => {
      const body = JSON.parse(serialized)
      bodies.push(body)
      const tool = mode === 'task' && bodies.length % 2 === 1
      onLine(`data: ${JSON.stringify({ choices: [{ delta: tool
        ? { tool_calls: [{ index: 0, id: `read-${bodies.length}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"source.ts"}' } }] }
        : { content: 'Visible answer' }, finish_reason: tool ? 'tool_calls' : 'stop' }] })}`)
      onLine('data: [DONE]')
      return { success: true, data: '' }
    })
    const state = new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'test', baseUrl: 'http://example.test', model: 'test-model', contextWindow: 100_000, maxTokens: 4096 }, process.cwd())
    const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', gitEnabled: false }, { streamMessage, readFile: vi.fn(async () => ({ success: true, data: 'source' })) } as unknown as ToolExecutor, state)
    engine.subscribe(event => events.push(event))
    vi.spyOn(engine as any, 'prepareContextWindow').mockResolvedValue(undefined)
    try {
      await engine.run('First request')
      await engine.waitUntilIdle()
      await engine.run('Second request')
      expect(bodies).toHaveLength(mode === 'task' ? 4 : 2)
      expect(bodies.every(body => body.tool_choice === 'auto')).toBe(true)
      expect(bodies[0].tools.some((tool: any) => tool.function.name === 'set_response_mode')).toBe(false)
      expect(events.filter(event => event.type === 'stream:delta').map(event => event.text)).toEqual(['Visible answer', 'Visible answer'])
      expect(engine.getWorkExecutionSnapshot().runs.map(run => [run.responseMode, run.presentation, run.status])).toEqual([
        [mode, mode === 'task' ? 'work' : 'conversation', 'completed'],
        [mode, mode === 'task' ? 'work' : 'conversation', 'completed'],
      ])
    } finally { engine.destroy() }
  })

  it('accepts a normal response without a hidden declaration round', async () => {
    const state = new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'test', baseUrl: 'http://example.test', model: 'test-model', contextWindow: 100_000, maxTokens: 4096 }, process.cwd())
    const streamMessage = vi.fn(async (_url, _headers, _serialized, onLine) => {
      onLine('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }] }))
      onLine('data: [DONE]')
      return { success: true, data: '' }
    })
    const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', gitEnabled: false }, { streamMessage } as unknown as ToolExecutor, state)
    vi.spyOn(engine as any, 'prepareContextWindow').mockResolvedValue(undefined)
    try {
      await engine.run('Hello')
      expect(streamMessage).toHaveBeenCalledTimes(1)
      expect(engine.getSession().turns.at(-1)?.content).toBe('Hello')
      expect(engine.getWorkExecutionSnapshot().runs[0]).toMatchObject({ responseMode: 'chat', presentation: 'conversation', status: 'completed' })
    } finally { engine.destroy() }
  })
})
