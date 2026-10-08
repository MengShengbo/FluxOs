import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { McpClient } from '@fluxos/extensions/mcp/client'
import { executeMcpTool, mcpToolToAgentTool } from '@fluxos/extensions/mcp/toolBridge'
import { ToolCallLifecycle } from './runtime/toolCallLifecycle'
import { AgentRunControl } from './runtime/runControl'

it('keeps remote effects unknown when the real MCP peer acknowledges cancellation but continues work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flux-mcp-cancel-'))
  const client = new McpClient()
  try {
    const connection = await client.connect('fixture', { command: process.execPath,
      args: [fileURLToPath(new URL('../../extensions/src/mcp/__fixtures__/cancellation-server.mjs', import.meta.url))],
      env: { FLUX_CANCELLATION_FIXTURE: root }, enabled: true })
    expect(connection.status).toBe('connected')
    const runControl = new AgentRunControl(); runControl.start()
    const lifecycle = new ToolCallLifecycle({ runControl,
      resolveTool: () => mcpToolToAgentTool(connection.tools[0]), validate: () => undefined, authorize: async () => null,
      execute: async (call, _tool, signal) => ({ ...await executeMcpTool(client, call.name, call.arguments, { signal }), toolCallId: call.id, name: call.name }),
    })
    const pending = lifecycle.execute({ id: 'remote-write', name: 'fixture__write_later', arguments: {} })
    const deadline = Date.now() + 3000
    while (!existsSync(join(root, 'started')) && Date.now() < deadline) await delay(10)
    expect(existsSync(join(root, 'started'))).toBe(true)
    runControl.stop()
    const result = await pending
    expect(result).toMatchObject({ isError: true, errorKind: 'abort', recovery: { effects: 'unknown', retry: 'after_inspection' } })
    while (!existsSync(join(root, 'effect')) && Date.now() < deadline) await delay(10)
    expect(readFileSync(join(root, 'calls'), 'utf8')).toBe('1\n')
    expect(readFileSync(join(root, 'effect'), 'utf8')).toBe('effect after cancellation')
    expect(existsSync(join(root, 'cancelled'))).toBe(true)
  } finally { await client.disconnectAll(); rmSync(root, { recursive: true, force: true }) }
}, 10_000)
