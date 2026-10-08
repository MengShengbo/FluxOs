import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import { NodeToolExecutor } from '@fluxos/tools/nodeToolExecutor'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'

const roots: string[] = []; const engines: AgentEngine[] = []
afterEach(() => { engines.splice(0).forEach(engine => engine.destroy()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function harness() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fluxos-search-engine-'))); roots.push(root)
  const executor = new NodeToolExecutor(root, { memoryRoot: join(root, '.fluxagent', 'memory'), runtimeLogsRoot: join(root, '.fluxagent', 'logs') })
  const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', workspacePath: root }, executor,
    new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'fixture', baseUrl: 'http://fixture.invalid', model: 'fixture', contextWindow: 100_000, maxTokens: 4096 }, root))
  engines.push(engine)
  const internal = engine as unknown as { executeSingleTool(call: ToolCall): Promise<ToolResult> }
  let index = 0
  return { root, executor, engine, call: (name: string, args: Record<string, unknown>) => internal.executeSingleTool({ id: `call-${++index}`, name, arguments: args }) }
}

describe('search continuation at the actual tool boundary', () => {
  it.each(['search_files', 'search_content'])('preserves capture identity and current policy on %s', async name => {
    const h = harness()
    for (const file of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(h.root, file), 'needle original')
    const args = { pattern: name === 'search_files' ? '*.ts' : 'needle', path: '.', head_limit: 1 }
    const first = await h.call(name, { ...args, cursor: null, offset: null })
    expect(first.isError, first.output).toBe(false)
    const cursor = first.retrieval!.nextCursor!
    expect(cursor).toBeTypeOf('string')
    writeFileSync(join(h.root, '0.ts'), 'needle new'); writeFileSync(join(h.root, 'b.ts'), 'changed')
    const second = await h.call(name, { ...args, cursor, offset: null })
    expect(second.isError, second.output).toBe(false)
    expect(second.retrieval!.resources[0].path).toBe('b.ts')
    expect(second.retrieval!.snapshot).toEqual(first.retrieval!.snapshot)
    expect(second.output).toContain('changes after capture are not included')
    expect(second.output).toContain('cursor=')
    expect(second.output).not.toContain('continue with offset=')
    if (name === 'search_content') expect(second.retrieval!.resources[0].preview).toBe('needle original')
    expect(await h.call(name, { ...args, cursor, offset: 0 })).toMatchObject({ isError: true, errorKind: 'validation' })
    h.engine.setAllowedTools(['read_file'])
    expect(await h.call(name, { ...args, cursor })).toMatchObject({ isError: true, errorKind: 'permission' })
  })

  it('rechecks the current path capability before returning saved content', async () => {
    const h = harness(); const external = harness()
    writeFileSync(join(external.root, 'a.ts'), 'needle'); writeFileSync(join(external.root, 'b.ts'), 'needle')
    h.executor.setCapabilityProfile('danger-full-access')
    const args = { pattern: 'needle', path: external.root, head_limit: 1 }
    const first = await h.call('search_content', args)
    expect(first.isError, first.output).toBe(false)
    h.executor.setCapabilityProfile('workspace-write')
    expect(await h.call('search_content', { ...args, cursor: first.retrieval!.nextCursor })).toMatchObject({ isError: true, errorKind: 'permission' })
  })
})
