import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import { NodeToolExecutor } from '@fluxos/tools/nodeToolExecutor'
import { McpClient } from '@fluxos/extensions/mcp/client'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'

const roots: string[] = []; const engines: AgentEngine[] = []
afterEach(() => { vi.restoreAllMocks(); engines.splice(0).forEach(engine => engine.destroy()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'fluxos-result-read-')); roots.push(root)
  const executor = new NodeToolExecutor(root, { memoryRoot: join(root, 'memory'), runtimeLogsRoot: join(root, 'logs') })
  const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', workspacePath: root }, executor,
    new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'fixture', baseUrl: 'http://fixture.invalid', model: 'fixture', contextWindow: 100_000, maxTokens: 4096 }, root))
  engines.push(engine)
  const internal = engine as unknown as { executeSingleTool(call: ToolCall): Promise<ToolResult> }
  let index = 0
  return { root, executor, engine, call: (name: string, args: Record<string, unknown>) => internal.executeSingleTool({ id: `call-${++index}`, name, arguments: args }) }
}

describe('model-visible result continuation', () => {
  it('bounds thrown failures and retains their original output for inspection', async () => {
    const h = harness(); const message = 'failure evidence🙂'.repeat(6000)
    vi.spyOn(h.executor, 'readFileRange').mockRejectedValue(new Error(message))
    const result = await h.call('read_file', { path: 'fixture.txt' })
    expect(result).toMatchObject({ isError: true, errorKind: 'execution' })
    expect(result.output.length).toBeLessThanOrEqual(64_000)
    expect(result.outputSource).toBeDefined()
    let offset = 0; let restored = ''
    do {
      const page = await h.call('read_tool_result', { source_id: result.outputSource!.id, offset })
      expect(page.isError).toBe(false); restored += page.output; offset = page.outputSource!.nextOffset ?? -1
    } while (offset >= 0)
    expect(restored).toBe(`Tool execution error: ${message}`)
    expect(h.executor.readFileRange).toHaveBeenCalledTimes(1)
  })

  it('exposes expiry through the actual tool boundary without rerunning the source', async () => {
    const h = harness(); const client = new McpClient(); const handler = vi.fn(async () => 'snapshot'.repeat(10000))
    client.registerLocalServer({ name: 'fixture', tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }], handler })
    h.engine.setMcpClient(client)
    const source = (await h.call('fixture__read', {})).outputSource!
    vi.spyOn(Date, 'now').mockReturnValue(source.expiresAt)
    expect(await h.call('read_tool_result', { source_id: source.id })).toMatchObject({ isError: true, errorKind: 'environment', output: expect.stringContaining('expired') })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('does not retain computer evidence in the generic output reader', async () => {
    const h = harness(); const client = new McpClient()
    client.registerLocalServer({ name: 'computer', tools: [{ name: 'observe', description: 'Computer fixture', inputSchema: { type: 'object' } }], handler: async () => 'private evidence'.repeat(5000) })
    h.engine.setMcpClient(client)
    const result = await h.call('computer__observe', {})
    expect(result.isError).toBe(false)
    expect(result.outputSource).toBeUndefined()
    expect(result.output).toContain('Computer evidence is ephemeral')
  })

  it('does not turn a current source into another session or tool execution', async () => {
    const h = harness(); const other = harness(); const handler = vi.fn(async () => 'large output'.repeat(10000)); const client = new McpClient()
    client.registerLocalServer({ name: 'fixture', tools: [{ name: 'read', description: 'Read fixture', inputSchema: { type: 'object' } }], handler })
    h.engine.setMcpClient(client); other.engine.setMcpClient(client)
    const first = await h.call('fixture__read', {}); const id = first.outputSource!.id
    expect(await other.call('read_tool_result', { source_id: id })).toMatchObject({ isError: true, errorKind: 'environment' })
    const page = await h.call('read_tool_result', { source_id: id })
    expect(page.isError).toBe(false); expect(handler).toHaveBeenCalledTimes(1)
    h.engine.setAllowedTools(['read_tool_result'])
    expect(await h.call('read_tool_result', { source_id: id })).toMatchObject({ isError: true, errorKind: 'permission' })
    h.engine.setAllowedTools(undefined)
    await client.disconnect('fixture')
    expect(await h.call('read_tool_result', { source_id: id })).toMatchObject({ isError: true, errorKind: 'permission' })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('offers a real byte reader for giant file lines and keeps each result bounded', async () => {
    const h = harness(); const text = '长🙂'.repeat(34_000); writeFileSync(join(h.root, 'long.txt'), text)
    const preview = await h.call('read_file', { path: 'long.txt' })
    expect(preview.output).toContain('byte_offset=0')
    let offset = 0; let version: string | undefined; let restored = ''
    do {
      const page = await h.call('read_file', { path: 'long.txt', byte_offset: offset, byte_limit: 4097, ...(version ? { source_version: version } : {}) })
      expect(page.isError, page.output).toBe(false)
      expect(page.output.length).toBeLessThan(64_000)
      restored += page.retrieval!.resources[0]!.preview!
      const range = page.retrieval!.byteRange!
      version = range.version; offset = range.nextOffset ?? -1
    } while (offset >= 0)
    expect(restored).toBe(text)
  })

  it('recovers truncated external output and rejects handles after revocation or session reset', async () => {
    const h = harness(); const text = 'Error: normal log🙂\n'.repeat(6000)
    const client = new McpClient(); client.registerLocalServer({ name: 'fixture', tools: [{ name: 'read', description: 'Read fixture', inputSchema: { type: 'object' } }], handler: async () => text })
    h.engine.setMcpClient(client)
    const preview = await h.call('fixture__read', {})
    expect(preview.isError).toBe(false); expect(preview.output.length).toBeLessThanOrEqual(20_000)
    expect(preview.outputSource).toBeDefined()
    const id = preview.outputSource!.id; let offset = 0; let restored = ''
    do {
      const page = await h.call('read_tool_result', { source_id: id, offset, limit: 4097 })
      expect(page.isError, page.output).toBe(false); expect(page.output.length).toBeLessThanOrEqual(4097)
      restored += page.output; offset = page.outputSource!.nextOffset ?? -1
    } while (offset >= 0)
    expect(restored).toBe(text)
    h.engine.setDisabledTools(['fixture__read'])
    expect(await h.call('read_tool_result', { source_id: id })).toMatchObject({ isError: true, errorKind: 'permission' })
    h.engine.setDisabledTools([]); h.engine.resetSession()
    expect(await h.call('read_tool_result', { source_id: id })).toMatchObject({ isError: true, errorKind: 'environment' })
  })
})
