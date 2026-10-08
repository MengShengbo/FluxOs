import { afterEach, describe, expect, it } from 'vitest'
import type { ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import type { ToolExecutor } from '@fluxos/contracts/toolExecutor'
import { toolResultExecutionStatus } from '@fluxos/contracts/toolResultData'
import { McpClient } from '@fluxos/extensions/mcp/client'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'
import { createInterruptedToolResult } from './runtime/toolExecutionResult'
import { interruptionMetadata } from './runtime/runControl'

const engines: AgentEngine[] = []
afterEach(() => engines.splice(0).forEach(engine => engine.destroy()))
function harness(executor: Partial<ToolExecutor> = {}) {
  const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', workspacePath: '/fixture' }, executor as ToolExecutor,
    new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'fixture', baseUrl: 'http://fixture.invalid', model: 'fixture', contextWindow: 100_000, maxTokens: 4096 }, '/fixture'))
  engines.push(engine)
  const internal = engine as unknown as { executeSingleTool(call: ToolCall): Promise<ToolResult>; currentRunSuccessfulReadFiles: Set<string> }
  return { engine, internal, call: (name: string, args: Record<string, unknown> = {}) => internal.executeSingleTool({ id: 'call', name, arguments: args }) }
}

describe('tool result status independent of text', () => {
  it.each(['', 'Error: literal committed output'])('keeps the settled payload intact when interrupted: %j', output => {
    const call = { id: 'call', name: 'write_file', arguments: {} }
    const attachment = { id: 'evidence', type: 'image' as const, path: '/fixture/evidence.png', mime: 'image/png' }
    const result = createInterruptedToolResult(call, interruptionMetadata('stop'), {
      toolCallId: call.id, name: call.name, output, isError: false, attachments: [attachment],
      recovery: { effects: 'committed', retry: 'after_inspection' },
    })
    expect(result).toMatchObject({ output, isError: true, errorKind: 'abort', attachments: [attachment],
      recovery: { effects: 'committed', retry: 'after_inspection' } })
    expect(toolResultExecutionStatus(result)).toBe('cancelled')
  })

  it.each(['Error: this is a documented example', 'Tool execution error: quoted log line', 'Unknown tool: a literal heading'])('reads literal content without failing: %s', async content => {
    const h = harness({ readFileRange: async () => ({ success: true, data: { content, truncated: false } }) })
    const result = await h.call('read_file_full', { path: 'example.txt' })
    expect(result.output).toBe(content)
    expect(result.isError).toBe(false)
    expect(toolResultExecutionStatus(result)).toBe('completed')
    expect(h.internal.currentRunSuccessfulReadFiles.has('example.txt')).toBe(true)
  })

  it('preserves an explicitly successful MCP payload beginning with Error', async () => {
    const h = harness()
    const client = new McpClient()
    client.registerLocalServer({ name: 'fixture', tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }],
      handler: async () => ({ kind: 'local_tool_result', isError: false, content: 'Error: an example from documentation' }) })
    h.engine.setMcpClient(client)
    expect(await h.call('fixture__read')).toMatchObject({ isError: false, output: 'Error: an example from documentation' })
  })

  it('preserves explicit failure text and evidence without inserting a prefix', async () => {
    const h = harness()
    const client = new McpClient()
    const attachment = { id: 'evidence', type: 'image' as const, path: '/fixture/evidence.png', mime: 'image/png' }
    client.registerLocalServer({ name: 'fixture', tools: [{ name: 'verify', description: 'Verify', inputSchema: { type: 'object' } }],
      handler: async () => ({ kind: 'local_tool_result', isError: true, content: '断言未满足', attachments: [attachment] }) })
    h.engine.setMcpClient(client)
    expect(await h.call('fixture__verify')).toMatchObject({ isError: true, errorKind: 'execution', output: '断言未满足', attachments: [attachment] })
  })

  it.each(['not_committed', 'committed', 'unknown'] as const)('retains a failed file publication acknowledgement: %s', async mutation => {
    const h = harness({ readFile: async () => ({ success: true, data: 'before' }),
      writeFile: async () => ({ success: false, mutation, error: 'permission is a quoted document word, not the error category' }) })
    const result = await h.call('write_file', { path: 'example.txt', content: 'after' })
    expect(result).toMatchObject({ isError: true, errorKind: 'execution', recovery: {
      effects: mutation === 'not_committed' ? 'none' : mutation,
      retry: mutation === 'not_committed' ? 'after_environment' : 'after_inspection',
    } })
  })

  it('treats a dependency failure as partial creation and keeps the created node', async () => {
    const h = harness()
    const result = await h.call('create_task', { title: 'Created', description: 'Keep this node', priority: 'major', dependencies: ['missing'] })
    expect(result).toMatchObject({ isError: true, errorKind: 'validation', recovery: { effects: 'partial', retry: 'after_inspection' },
      data: { kind: 'tasks', status: 'partial', tasks: [expect.objectContaining({ title: 'Created', dependencies: [] })],
        failures: [expect.objectContaining({ stage: 'dependency' })] } })
  })

  it('reports missing runtime support as environment, without inferring from its text', async () => {
    const result = await harness().call('web_search', { query: 'fixture' })
    expect(result).toMatchObject({ isError: true, errorKind: 'environment', recovery: { effects: 'none', retry: 'after_environment' } })
  })
})
