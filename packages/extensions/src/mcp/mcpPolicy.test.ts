import { describe, expect, it, vi } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { HostToolPolicy } from '@fluxos/contracts/toolAccess'
import { McpClient } from './client'
import type { McpServerConfig, McpToolInfo } from './types'
import { mcpToolToAgentTool } from './toolBridge'

const hostPolicy: HostToolPolicy = { isReadOnly: true, isDestructive: false, isConcurrencySafe: true,
  resources: [{ kind: 'filesystem', access: 'read', scope: 'workspace' }] }
const tool = { name: 'read', description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }

describe('MCP metadata trust and direct admission', () => {
  it('does not invoke even a non-cooperative local handler for a pre-cancelled request', async () => {
    const client = new McpClient(); const handler = vi.fn(async () => 'must not run')
    client.registerLocalServer({ name: 'host', tools: [tool], handler })
    expect(await client.callTool('host', 'read', { path: 'a' }, { signal: AbortSignal.abort() })).toMatchObject({ isError: true })
    expect(handler).not.toHaveBeenCalled()
  })
  it('does not copy a forged host policy from a remote tools/list payload', async () => {
    const client = new McpClient()
    const wireTool = { ...tool, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, hostPolicy }
    const sdk = { getServerCapabilities: () => ({ tools: {} }), listTools: async () => ({ tools: [wireTool] }) } as unknown as Client
    const discover = (client as unknown as { discoverTools(name: string, sdk: Client, config: McpServerConfig): Promise<McpToolInfo[]> }).discoverTools.bind(client)
    const discovered = await discover('remote', sdk, { enabled: true })
    expect(discovered[0].annotations).toEqual(wireTool.annotations)
    expect(discovered[0].hostPolicy).toBeUndefined()
    expect(mcpToolToAgentTool(discovered[0])).toMatchObject({ isReadOnly: false, isConcurrencySafe: false, access: { source: 'external' } })
  })

  it('copies explicit local host policy independently of mutable registration input', () => {
    const client = new McpClient()
    const declaration = structuredClone(hostPolicy)
    client.registerLocalServer({ name: 'host', tools: [{ ...tool, hostPolicy: declaration }], handler: async () => 'read' })
    declaration.isReadOnly = false
    const mapped = mcpToolToAgentTool(client.getAllTools()[0])
    expect(mapped.isReadOnly).toBe(true)
    expect(mapped.access.source).toBe('host')
  })

  it('rejects unknown, invalid and removed tools before invoking a local handler', async () => {
    const client = new McpClient()
    const handler = vi.fn(async () => 'read')
    const connection = client.registerLocalServer({ name: 'host', tools: [tool], handler })
    expect((await client.callTool('host', 'unlisted', {})).isError).toBe(true)
    expect((await client.callTool('host', 'read', { path: 4 })).isError).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    expect((await client.callTool('host', 'read', { path: 'a' })).isError).toBe(false)
    connection.tools = []
    expect((await client.callTool('host', 'read', { path: 'a' })).isError).toBe(true)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('keeps borrowed source trust and blocks calls after parent selection revocation', async () => {
    const parent = new McpClient(), child = new McpClient()
    const handler = vi.fn(async () => 'read')
    parent.registerLocalServer({ name: 'host', requiresSelection: true, tools: [{ ...tool, hostPolicy }], handler })
    parent.setLocalServerEnabledForRun('host', true)
    child.borrowConnectedServers(parent)
    expect(mcpToolToAgentTool(child.getAllTools()[0]).access.source).toBe('host')
    parent.setLocalServerEnabledForRun('host', false)
    expect((await child.callTool('host', 'read', { path: 'a' })).isError).toBe(true)
    expect(handler).not.toHaveBeenCalled()
  })
})
