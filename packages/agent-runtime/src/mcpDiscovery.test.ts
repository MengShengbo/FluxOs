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
interface WireRequest { tools: WireTool[]; prompt_cache_key?: string }
const roots: AgentEngine[] = []
afterEach(() => { roots.splice(0).forEach(engine => engine.destroy()) })
function harness(protocol = 'chat/completions', mode: 'plan' | 'vibe' = 'vibe') {
  const bodies: WireRequest[] = []
  const streamMessage = vi.fn<NonNullable<ToolExecutor['streamMessage']>>(async (_url, _headers, body, onLine) => {
    bodies.push(JSON.parse(body))
    const event = (value: unknown) => onLine(`data: ${JSON.stringify(value)}`)
    if (protocol === 'messages') {
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture' } })
      event({ type: 'message_stop' })
    } else if (protocol === 'responses') {
      event({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'fixture' }] }] } })
    } else {
      event({ choices: [{ delta: { content: 'fixture' }, finish_reason: 'stop' }] })
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
  const internal = engine as unknown as { callModel(): Promise<AgentTurn>; executeSingleTool(call: ToolCall): Promise<ToolResult>; abortController: AbortController }
  internal.abortController = new AbortController()
  engine.restoreFromTurns([{ id: 'user', role: 'user', content: 'Use a relevant tool.', timestamp: 1 }])
  const search = (query: string, limit = 1) => internal.executeSingleTool({ id: `search-${bodies.length}`, name: 'tool_search', arguments: { query, limit } })
  const wire = async () => { await internal.callModel(); return bodies.at(-1)! }
  const mcp = (request: WireRequest) => request.tools.map(tool => tool.function?.name ?? tool.name!).filter(name => name.includes('__'))
  return { engine, client, handler, internal, search, wire, mcp }
}

describe('MCP discovery and loaded wire schemas', () => {
  it.each(['chat/completions', 'responses', 'messages'])('loads only searched schemas on %s with stable repeat requests', async protocol => {
    const h = harness(protocol)
    const before = await h.wire()
    expect(h.mcp(before)).toEqual([])
    const result = await h.search('unique7')
    expect(result.isError).toBe(false)
    expect(result.output).toContain('catalog__tool07')
    expect(result.output).not.toContain('unselected__secret')
    const after = await h.wire()
    expect(h.mcp(after)).toEqual(['catalog__tool07'])
    const repeated = await h.wire()
    expect(repeated.tools).toEqual(after.tools)
    expect(repeated.prompt_cache_key).toBe(after.prompt_cache_key)
    if (protocol !== 'messages') {
      expect(after.prompt_cache_key).toBeTruthy()
      expect(after.prompt_cache_key).not.toBe(before.prompt_cache_key)
    }
    expect(JSON.stringify(after.tools).length - JSON.stringify(before.tools).length).toBeGreaterThan(1_000)
    expect(h.engine.enableMcpServerTools('catalog')).toBe(50)
    const eager = await h.wire()
    expect(h.mcp(eager)).toHaveLength(50)
    expect(JSON.stringify(after.tools).length - JSON.stringify(before.tools).length).toBeLessThan((JSON.stringify(eager.tools).length - JSON.stringify(before.tools).length) / 20)
    const metricsDirectory = process.env.FLUXAGENT_DISCOVERY_METRICS_DIR
    if (metricsDirectory) {
      const metric = (request: WireRequest) => ({ mcpNames: h.mcp(request), schemaChars: JSON.stringify(request.tools).length,
        utf8Bytes: Buffer.byteLength(JSON.stringify(request.tools)), sha256: createHash('sha256').update(JSON.stringify(request.tools)).digest('hex') })
      writeFileSync(join(metricsDirectory, `T019-wire-${protocol.replace('/', '-')}.json`), `${JSON.stringify({ protocol, before: metric(before), loaded: metric(after), eager: metric(eager), limit: 'Serialized schema size only; no tokenizer, real-model usage, latency or upstream cache hit measured.' }, null, 2)}\n`)
    }
    if (after.prompt_cache_key) expect((await h.wire()).prompt_cache_key).toBe(eager.prompt_cache_key)
  })

  it('filters policy before ranking/limiting and does not equate loaded schemas with authorization', async () => {
    const h = harness()
    h.engine.setAllowedTools(['tool_search', 'catalog__tool08'])
    h.engine.setDisabledTools(['catalog__tool07'])
    expect(h.engine.enableMcpServerTools('unselected')).toBe(0)
    const found = await h.search('catalog', 1)
    expect(found.output).toContain('not semantic confidence or authorization')
    expect(found.output).toContain('catalog__tool08')
    expect(found.output).not.toContain('catalog__tool00')
    expect(h.mcp(await h.wire())).toEqual(['catalog__tool08'])
    h.engine.setDisabledTools(['catalog__tool08'])
    expect(h.mcp(await h.wire())).toEqual([])
    const denied = await h.internal.executeSingleTool({ id: 'revoked', name: 'catalog__tool08', arguments: { query: 'fixture' } })
    expect(denied.isError).toBe(true)
    expect(h.handler).not.toHaveBeenCalled()
  })

  it('does not leak write schemas in plan mode through search or eager server activation', async () => {
    const h = harness('messages', 'plan')
    expect((await h.search('unique49')).output).not.toContain('catalog__tool49')
    expect(h.engine.enableMcpServerTools('catalog')).toBe(49)
    expect(h.mcp(await h.wire())).not.toContain('catalog__tool49')
  })

  it('uses stable schema order after different search orders and removes disconnected catalogs', async () => {
    const h = harness()
    await h.search('unique8'); await h.search('unique7')
    expect(h.mcp(await h.wire())).toEqual(['catalog__tool07', 'catalog__tool08'])
    await h.client.disconnect('catalog')
    expect(h.mcp(await h.wire())).toEqual([])
    expect((await h.search('unique7')).output).not.toContain('catalog__tool07')
    const replacement = new McpClient()
    replacement.registerLocalServer({ name: 'catalog', tools: [{ name: 'tool07', description: 'unique7', inputSchema: { type: 'object' } }], handler: h.handler })
    h.engine.setMcpClient(replacement)
    expect(h.mcp(await h.wire())).toEqual([])
  })

  it('removes a previously loaded server after run selection is revoked', async () => {
    const h = harness()
    h.client.setLocalServerEnabledForRun('unselected', true)
    await h.search('secret')
    expect(h.mcp(await h.wire())).toEqual(['unselected__secret'])
    h.client.setLocalServerEnabledForRun('unselected', false)
    expect(h.mcp(await h.wire())).toEqual([])
    expect((await h.search('secret')).output).not.toContain('unselected__secret')
    const result = await h.internal.executeSingleTool({ id: 'unselected-call', name: 'unselected__secret', arguments: {} })
    expect(result.isError).toBe(true)
    expect(h.handler).not.toHaveBeenCalled()
  })
})
