import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentTurn, ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import type { ToolExecutor } from '@fluxos/contracts/toolExecutor'
import { McpClient } from '@fluxos/extensions/mcp/client'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'

interface WireTool { name?: string; function?: { name: string } }
interface WireRequest { tools: WireTool[]; prompt_cache_key?: string; input?: unknown[]; messages?: unknown[] }
const roots: AgentEngine[] = []
afterEach(() => { roots.splice(0).forEach(engine => engine.destroy()) })
function harness(protocol = 'chat/completions', mode: 'plan' | 'vibe' = 'vibe') {
  const bodies: WireRequest[] = []
  let nextCall: ToolCall | undefined
  const streamMessage = vi.fn<NonNullable<ToolExecutor['streamMessage']>>(async (_url, _headers, body, onLine) => {
    bodies.push(JSON.parse(body))
    const event = (value: unknown) => onLine(`data: ${JSON.stringify(value)}`)
    const call = nextCall; nextCall = undefined
    if (protocol === 'messages') {
      if (call) {
        event({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } })
        event({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } })
        event({ type: 'content_block_stop', index: 1 })
      }
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture' } })
      event({ type: 'message_stop' })
    } else if (protocol === 'responses') {
      event({ type: 'response.completed', response: { output: call ? [{ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }] : [{ type: 'message', content: [{ type: 'output_text', text: 'fixture' }] }] } })
    } else {
      event({ choices: [{ delta: call ? { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: 'fixture' }, finish_reason: call ? 'tool_calls' : 'stop' }] })
      onLine('data: [DONE]')
    }
    return { success: true, data: '' }
  })
  const engine = new AgentEngine({ mode, approvalPolicy: 'full', gitEnabled: false, workspacePath: '/fixture' }, { streamMessage } as unknown as ToolExecutor,
    new DefaultAgentStateProvider({ provider: protocol === 'messages' ? 'anthropic' : 'openai', apiKey: 'fixture', baseUrl: 'http://fixture.invalid/v1', model: 'fixture', contextWindow: 100_000, maxTokens: 4096, modelCapabilities: { supportedEndpoints: [`/${protocol}`] } }, '/fixture'))
  roots.push(engine)
  const client = new McpClient()
  const handler = vi.fn(async () => ({ kind: 'local_tool_result' as const, content: 'called', isError: false }))
  client.registerLocalServer({ name: 'catalog', tools: Array.from({ length: 50 }, (_, i) => ({
    name: `tool${String(i).padStart(2, '0')}`, description: `unique${i} operation`, annotations: { readOnlyHint: i !== 49 },
    hostPolicy: { isReadOnly: i !== 49, isDestructive: i === 49, isConcurrencySafe: false, resources: [{ kind: 'external', access: i === 49 ? 'write' : 'read', scope: 'external' }] },
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Fixture schema documentation '.repeat(40) } }, required: ['query'], additionalProperties: false },
  })), handler })
  client.registerLocalServer({ name: 'unselected', requiresSelection: true, tools: [{ name: 'secret', description: 'unique7 secret connector', inputSchema: { type: 'object' } }], handler })
  engine.setMcpClient(client)
  const internal = engine as unknown as { callModel(): Promise<AgentTurn>; executeSingleTool(call: ToolCall): Promise<ToolResult>; executeToolCalls(calls: ToolCall[]): Promise<ToolResult[]>; abortController: AbortController }
  internal.abortController = new AbortController()
  engine.restoreFromTurns([{ id: 'user', role: 'user', content: 'Use a relevant tool.', timestamp: 1 }])
  const search = (query: string, limit = 1) => internal.executeSingleTool({ id: `search-${bodies.length}`, name: 'tool_search', arguments: { query, limit } })
  const wire = async () => { await internal.callModel(); return bodies.at(-1)! }
  const mcp = (request: WireRequest) => request.tools.map(tool => tool.function?.name ?? tool.name!).filter(name => name.includes('__'))
  const invoke = (name: string, args: Record<string, unknown> = { query: 'fixture' }) => internal.executeToolCalls([{ id: 'invoke', name: 'call_tool', arguments: { name, arguments_json: JSON.stringify(args) } }])
  return { engine, client, handler, internal, search, wire, mcp, invoke, setNextCall: (call: ToolCall) => { nextCall = call } }
}

describe('cache-stable built-in and MCP discovery', () => {
  it.each(['chat/completions', 'responses', 'messages'])('keeps the same small tools prefix after discovery on %s', async protocol => {
    const h = harness(protocol)
    const before = await h.wire()
    const names = before.tools.map(tool => tool.function?.name ?? tool.name!)
    expect(names.length).toBeLessThanOrEqual(14)
    expect(names).toEqual(expect.arrayContaining(['tool_search', 'call_tool', 'read_file']))
    expect(names).not.toContain('git_commit')
    expect(h.mcp(before)).toEqual([])
    const result = await h.search('unique7')
    expect(result.isError).toBe(false)
    expect(result.output).toContain('catalog__tool07')
    expect(result.output).not.toContain('unselected__secret')
    const after = await h.wire()
    expect(after.tools).toEqual(before.tools)
    expect(after.prompt_cache_key).toBe(before.prompt_cache_key)
    expect((await h.wire()).tools).toEqual(before.tools)
    const git = await h.search('git_commit')
    expect(git.output).toContain('git_commit')
    expect(git.output).toContain('inputSchema')
    expect((await h.wire()).tools).toEqual(before.tools)
    const metricsDirectory = process.env.FLUXAGENT_DISCOVERY_METRICS_DIR
    if (metricsDirectory) {
      writeFileSync(join(metricsDirectory, `discovery-${protocol.replace('/', '-')}.json`), JSON.stringify({
        protocol, residentCount: names.length, utf8Bytes: Buffer.byteLength(JSON.stringify(before.tools)),
        prefixHash: createHash('sha256').update(JSON.stringify(before.tools)).digest('hex'),
        unchangedAfterDiscovery: JSON.stringify(before.tools) === JSON.stringify(after.tools),
        limitation: 'Serialized wire fixture only; real-model token usage and provider cache hits were not measured.',
      }, null, 2))
    }
  })

  it.each(['chat/completions', 'responses', 'messages'])('decodes %s calls before lifecycle and replays the exact wire arguments', async protocol => {
    const h = harness(protocol)
    const wireCall = { id: 'wire-invoke', name: 'call_tool', arguments: { name: 'catalog__tool07', arguments_json: '{  "query": "fixture"  }' } }
    h.setNextCall(wireCall)
    const assistant = await h.internal.callModel()
    expect(assistant.toolCalls).toEqual([expect.objectContaining({ id: wireCall.id, name: 'catalog__tool07', arguments: { query: 'fixture' }, modelInvocation: { name: wireCall.name, arguments: wireCall.arguments } })])
    const results = await h.internal.executeToolCalls(assistant.toolCalls!)
    expect(results[0]).toMatchObject({ name: 'catalog__tool07', isError: false })
    expect(h.handler).toHaveBeenCalledTimes(1)
    h.engine.getSession().turns.push(assistant, { id: 'result', role: 'tool_result', content: '', timestamp: 2, toolResults: results })
    const replay = JSON.stringify(await h.wire())
    expect(replay).toContain('call_tool')
    expect(replay).toContain('arguments_json')
    expect(replay).toContain('  ')
  })

  it('searches built-ins without a connected MCP client', async () => {
    const h = harness()
    const result = await h.search('git_commit')
    expect(result.isError).toBe(false)
    expect(result.output).toContain('git_commit')
  })

  it('filters policy before ranking and rechecks actual targets after revocation', async () => {
    const h = harness()
    h.engine.setAllowedTools(['catalog__tool08'])
    h.engine.setDisabledTools(['catalog__tool07'])
    const found = await h.search('catalog', 1)
    expect(found.output).toContain('not semantic confidence or authorization')
    expect(found.output).toContain('catalog__tool08')
    expect(found.output).not.toContain('catalog__tool00')
    expect((await h.wire()).tools.map(tool => tool.function?.name ?? tool.name!)).toEqual(expect.arrayContaining(['tool_search', 'call_tool']))
    expect((await h.invoke('catalog__tool07'))[0]).toMatchObject({ isError: true, errorKind: 'permission' })
    h.engine.setDisabledTools(['catalog__tool08'])
    expect((await h.invoke('catalog__tool08'))[0]).toMatchObject({ isError: true, errorKind: 'permission' })
    expect(h.handler).not.toHaveBeenCalled()
  })

  it('cannot smuggle a write through the read-only discovery transport in plan mode', async () => {
    const h = harness('messages', 'plan')
    expect((await h.search('unique49')).output).not.toContain('catalog__tool49')
    expect((await h.search('git_commit')).output).not.toContain('"name":"git_commit"')
    expect((await h.invoke('catalog__tool49'))[0]).toMatchObject({ isError: true, errorKind: 'permission' })
    expect((await h.invoke('write_file', { path: 'x', content: 'x' }))[0]).toMatchObject({ isError: true, errorKind: 'permission' })
    expect(h.handler).not.toHaveBeenCalled()
  })

  it.each(['null', '[]', '{broken'])('rejects malformed deferred arguments %s without dispatch', async arguments_json => {
    const h = harness()
    const results = await h.internal.executeToolCalls([{ id: 'invalid', name: 'call_tool', arguments: { name: 'catalog__tool07', arguments_json } }])
    expect(results[0]).toMatchObject({ isError: true, errorKind: 'validation' })
    expect(h.handler).not.toHaveBeenCalled()
  })

  it('validates target schema and prevents recursive discovery, disabled invocation and unknown names', async () => {
    const h = harness()
    for (const [name, args] of [['catalog__tool07', { query: 42 }], ['tool_search', { query: 'git' }], ['call_tool', {}], ['unknown_tool', {}]] as const) {
      expect((await h.invoke(name, args))[0]).toMatchObject({ isError: true, errorKind: 'validation' })
    }
    h.engine.setDisabledTools(['call_tool'])
    expect((await h.invoke('catalog__tool07'))[0]).toMatchObject({ isError: true, errorKind: 'permission' })
    expect(h.handler).not.toHaveBeenCalled()
  })

  it('removes disconnected and unselected tools without changing the resident prefix', async () => {
    const h = harness()
    const before = await h.wire()
    h.client.setLocalServerEnabledForRun('unselected', true)
    expect((await h.search('secret')).output).toContain('unselected__secret')
    h.client.setLocalServerEnabledForRun('unselected', false)
    expect((await h.search('secret')).output).not.toContain('unselected__secret')
    expect((await h.invoke('unselected__secret', {}))[0].isError).toBe(true)
    await h.client.disconnect('catalog')
    expect((await h.search('unique7')).output).not.toContain('catalog__tool07')
    expect((await h.invoke('catalog__tool07'))[0].isError).toBe(true)
    expect((await h.wire()).tools).toEqual(before.tools)
    expect(h.handler).not.toHaveBeenCalled()
  })
})
