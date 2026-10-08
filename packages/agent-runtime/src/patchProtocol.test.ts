import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentTurn, ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import { NodeToolExecutor } from '@fluxos/tools/nodeToolExecutor'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'

const patch = '*** Begin Patch\n*** Update File: target.ts\n@@ second\n-old\n+const text = "你好\\\\path $&"\n*** End of File\n*** End Patch'
const source = 'first\nold\nsecond\nold\n'
const expected = 'first\nold\nsecond\nconst text = "你好\\\\path $&"\n'
interface FixtureRequest {
  tools: Array<{ type?: string; name?: string; function?: { name: string }; input_schema?: { properties: Record<string, unknown> } }>
  input: Array<Record<string, unknown>>
  parallel_tool_calls?: boolean
}

describe('patch from model protocol to real file and history', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => { while (cleanup.length) cleanup.pop()!() })

  it.each([
    ['responses', true], ['responses', false], ['responses', undefined],
    ['chat/completions', true], ['messages', true],
  ] as const)('executes %s with explicit custom capability %s', async (protocol, capability) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fluxagent-patch-protocol-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    writeFileSync(join(root, 'target.ts'), source)
    const executor = new NodeToolExecutor(root, { capabilityProfile: 'danger-full-access' })
    const custom = protocol === 'responses' && capability === true
    const bodies: FixtureRequest[] = []
    const transport = vi.spyOn(executor, 'streamMessage').mockImplementation(async (url, _headers, body, onLine) => {
      expect(url.endsWith(`/${protocol}`)).toBe(true)
      bodies.push(JSON.parse(body))
      const event = (data: unknown) => onLine(`data: ${JSON.stringify(data)}`)
      if (protocol === 'responses') {
        if (bodies.length === 1) {
          const item = custom ? { type: 'custom_tool_call', id: 'item-1', call_id: 'patch-1', name: 'apply_patch', input: patch }
            : { type: 'function_call', id: 'item-1', call_id: 'patch-1', name: 'apply_patch', arguments: JSON.stringify({ patch }) }
          event({ type: 'response.completed', response: { output: [item] } })
        } else event({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] } })
      } else if (protocol === 'messages') {
        event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'patch-1', name: 'apply_patch', input: {} } })
        event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ patch }) } })
        event({ type: 'content_block_stop', index: 0 })
        event({ type: 'message_delta', delta: { stop_reason: 'tool_use' } })
        event({ type: 'message_stop' })
      } else {
        event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'patch-1', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ patch }) } }] }, finish_reason: 'tool_calls' }] })
        onLine('data: [DONE]')
      }
      return { success: true, data: '' }
    })
    const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', gitEnabled: false, workspacePath: root }, executor,
      new DefaultAgentStateProvider({ provider: protocol === 'messages' ? 'anthropic' : 'custom', apiKey: 'fixture', baseUrl: 'http://example.test/v1', model: 'fixture-model',
        contextWindow: 100_000, maxTokens: 4096, modelCapabilities: { supportedEndpoints: [`/${protocol}`], responsesCustomTools: capability } }, root))
    cleanup.push(() => engine.destroy())
    const internal = engine as unknown as { callModel(): Promise<AgentTurn>; executeSingleTool(call: ToolCall): Promise<ToolResult>; abortController: AbortController }
    internal.abortController = new AbortController()
    const user: AgentTurn = { id: 'user', role: 'user', content: 'Apply the fixture patch.', timestamp: Date.now() }
    engine.restoreFromTurns([user])
    const turn = await internal.callModel()
    expect(turn.toolCalls).toEqual([{ id: 'patch-1', name: 'apply_patch', arguments: { patch } }])
    const result = await internal.executeSingleTool(turn.toolCalls![0]!)
    expect(result.isError).toBe(false)
    expect(readFileSync(join(root, 'target.ts'), 'utf8')).toBe(expected)
    if (protocol === 'responses') {
      expect(bodies[0]!.tools.find(t => t.name === 'apply_patch')).toMatchObject({ type: custom ? 'custom' : 'function' })
      expect(bodies[0]!.parallel_tool_calls).toBe(!custom)
      engine.restoreFromTurns([user, turn, { id: 'result', role: 'tool_result', content: '', toolResults: [result], timestamp: Date.now() }])
      await internal.callModel()
      expect(bodies[1]!.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: custom ? 'custom_tool_call' : 'function_call', call_id: 'patch-1' }),
        expect.objectContaining({ type: custom ? 'custom_tool_call_output' : 'function_call_output', call_id: 'patch-1' }),
      ]))
    } else if (protocol === 'messages') {
      expect(bodies[0]!.tools.find(t => t.name === 'apply_patch')?.input_schema?.properties.patch).toMatchObject({ type: 'string' })
    } else expect(bodies[0]!.tools.find(t => t.function?.name === 'apply_patch')?.type).toBe('function')
    expect(transport).toHaveBeenCalledTimes(protocol === 'responses' ? 2 : 1)
  })
})
