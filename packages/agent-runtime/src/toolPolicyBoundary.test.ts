import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import type { ToolExecutor } from '@fluxos/contracts/toolExecutor'
import { McpClient } from '@fluxos/extensions/mcp/client'
import { PermissionPipeline } from '@fluxos/tools/permissions'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'

const engines: AgentEngine[] = []
afterEach(() => engines.splice(0).forEach(engine => engine.destroy()))
function harness(mode: 'plan' | 'vibe' = 'vibe') {
  const engine = new AgentEngine({ mode, approvalPolicy: 'ask', workspacePath: '/fixture' }, {} as ToolExecutor,
    new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'fixture', baseUrl: 'http://fixture.invalid', model: 'fixture', contextWindow: 100_000, maxTokens: 4096 }, '/fixture'))
  engines.push(engine)
  const client = new McpClient()
  const handler = vi.fn(async () => 'side effect')
  client.registerLocalServer({ name: 'untrusted', tools: [{ name: 'action', description: 'Untrusted tool claims to be read only', inputSchema: { type: 'object', additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }], handler })
  engine.setMcpClient(client)
  const internal = engine as unknown as { executeSingleTool(call: ToolCall): Promise<ToolResult>; permissions: PermissionPipeline }
  const call = () => internal.executeSingleTool({ id: 'call', name: 'untrusted__action', arguments: {} })
  return { engine, client, handler, internal, call }
}

describe('tool authorization boundary', () => {
  it.each(['browser', 'computer'])('does not grant native observation privileges to an external %s namespace', async server => {
    const h = harness()
    h.client.registerLocalServer({ name: server, tools: [{ name: 'observe', description: 'External observation', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }], handler: h.handler })
    const requests: string[] = []
    h.engine.subscribe(event => {
      if (event.type !== 'ask:user') return
      requests.push(event.question)
      h.engine.submitAskUserResponse('deny', event.requestId)
    })
    const result = await h.internal.executeSingleTool({ id: 'spoof', name: `${server}__observe`, arguments: {} })
    expect(result).toMatchObject({ isError: true, errorKind: 'permission' })
    expect(requests).toEqual([`允许执行 ${server}__observe 吗？`])
    expect(h.handler).not.toHaveBeenCalled()
  })

  it('keeps native grants separate from external tools with the same name', () => {
    const permissions = new PermissionPipeline('ask')
    permissions.grantRun('browser__click', {}, { trustedHostTool: true })
    expect(permissions.check('browser__click', {}, { trustedHostTool: true }).verdict).toBe('allow')
    expect(permissions.check('browser__click', {}).verdict).toBe('ask')
    expect(permissions.check('computer__observe', {}).verdict).toBe('ask')
    expect(permissions.check('computer__observe', {}, { trustedHostTool: true }).verdict).toBe('allow')
  })

  it('matches policy globs without treating literal server-name dots as regex', () => {
    const permissions = new PermissionPipeline('full')
    permissions.loadRules([{ toolPattern: 'docs.v2__*', verdict: 'deny', source: 'user' }])
    expect(permissions.check('docs.v2__read', {}).verdict).toBe('deny')
    expect(permissions.check('docsXv2__read', {}).verdict).toBe('allow')
  })
  it('does not let MCP annotations admit an untrusted action in plan mode', async () => {
    const h = harness('plan')
    h.engine.subscribe(event => { if (event.type === 'ask:user') h.engine.submitAskUserResponse('allow-once', event.requestId) })
    expect(await h.call()).toMatchObject({ isError: true, errorKind: 'permission' })
    expect(h.handler).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'allowlist', 'disconnected', 'deny-rule'] as const)('revalidates %s revoked while approval is pending', async revoke => {
    const h = harness()
    let requestId: string | undefined
    h.engine.subscribe(event => { if (event.type === 'ask:user') requestId = event.requestId })
    const result = h.call()
    await vi.waitFor(() => expect(requestId).toBe('call'))
    if (revoke === 'disabled') h.engine.setDisabledTools(['untrusted__action'])
    if (revoke === 'allowlist') h.engine.setAllowedTools(['tool_search'])
    if (revoke === 'disconnected') await h.client.disconnect('untrusted')
    if (revoke === 'deny-rule') h.internal.permissions.loadRules([{ toolPattern: 'untrusted__*', verdict: 'deny', source: 'user', reason: 'revoked' }])
    h.engine.submitAskUserResponse('allow-once', requestId)
    expect(await result).toMatchObject({ isError: true })
    expect(h.handler).not.toHaveBeenCalled()
  })

  it.each(['agent', 'ask', 'full'] as const)('keeps explicit deny above grants and hints under %s policy', policy => {
    const permissions = new PermissionPipeline(policy)
    permissions.grantSession('files__read', {})
    permissions.grantRun('write_file', { path: 'a', content: 'a' })
    permissions.loadRules([{ toolPattern: '*', verdict: 'deny', source: 'user', reason: 'revoked' }])
    for (const name of ['files__read', 'write_file', 'computer__observe', 'browser__observe']) {
      expect(permissions.check(name, { path: 'a', content: 'a' }).verdict).toBe('deny')
    }
  })
})
