import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import { AgentEngine } from './agentEngine'
import { NodeToolExecutor } from '@fluxos/tools/nodeToolExecutor'
import { DefaultAgentStateProvider } from './runtime/stateProvider'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function harness() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'fluxagent-retrieval-')))
  const state = new DefaultAgentStateProvider({
    provider: 'custom', apiKey: 'test', baseUrl: 'http://example.test', model: 'test-model', contextWindow: 100_000, maxTokens: 4096,
  }, workspace)
  const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', workspacePath: workspace }, new NodeToolExecutor(workspace, {
    memoryRoot: join(workspace, '.fluxagent', 'memory'), runtimeLogsRoot: join(workspace, '.fluxagent', 'logs'),
  }), state)
  cleanups.push(() => { engine.destroy(); rmSync(workspace, { recursive: true, force: true }) })
  const execute = (engine as unknown as { executeToolCalls(calls: ToolCall[]): Promise<ToolResult[]> }).executeToolCalls.bind(engine)
  return { workspace, execute }
}

describe('engine retrieval contract', () => {
  it('keeps every returned path in model and user evidence and refreshes a new query', async () => {
    const { workspace, execute } = harness()
    for (let index = 0; index < 90; index++) writeFileSync(join(workspace, `owner-${String(index).padStart(3, '0')}.ts`), '')
    const call = { id: 'files', name: 'search_files', arguments: { pattern: '*.ts', head_limit: 100 } }
    const [result] = await execute([call])
    expect(result.isError).toBe(false)
    expect(result.retrieval).toMatchObject({ total: 90, totalIsExact: true, truncated: false })
    expect(result.retrieval?.resources).toHaveLength(90)
    for (const resource of result.retrieval!.resources) expect(result.output).toContain(resource.path)
    const [reused] = await execute([{ ...call, id: 'files-again' }])
    expect(reused.retrieval!.resources).toEqual(result.retrieval!.resources)
    expect(reused.retrieval!.snapshot!.id).not.toBe(result.retrieval!.snapshot!.id)
    expect(reused.retrieval).not.toBe(result.retrieval)
    writeFileSync(join(workspace, 'new.ts'), '')
    const [fresh] = await execute([{ ...call, id: 'files-after-change' }])
    expect(fresh.retrieval!.resources).toHaveLength(91)
    expect(fresh.output).toContain('new.ts')
  })

  it('keeps the complete bounded page and its continuation through the model output budget', async () => {
    const { workspace, execute } = harness()
    writeFileSync(join(workspace, 'source.ts'), Array.from({ length: 160 }, (_, index) => `needle-${index} ${'x'.repeat(475)}`).join('\n'))
    const query = { pattern: 'needle-', path: 'source.ts', head_limit: 100, fixed_strings: true, context_after: 8 }
    const [first] = await execute([{ id: 'first', name: 'search_content', arguments: query }])
    expect(first.isError).toBe(false)
    expect(first.output.length).toBeGreaterThan(20_000)
    expect(first.output).not.toContain('<output truncated:')
    expect(first.retrieval?.total).toBe(160)
    const resources = first.retrieval!.resources
    expect(first.output).toContain(resources.at(-1)!.preview)
    expect(first.output).toContain(`cursor=${JSON.stringify(first.retrieval!.nextCursor)}`)
    const [second] = await execute([{ id: 'second', name: 'search_content', arguments: { ...query, cursor: first.retrieval!.nextCursor } }])
    expect(second.retrieval?.resources[0].line).toBe(resources.at(-1)!.line! + 1)
    expect(second.output).toContain(second.retrieval!.resources.at(-1)!.preview)
    const [samePage] = await execute([{ id: 'same-page', name: 'search_content', arguments: { ...query, cursor: first.retrieval!.nextCursor } }])
    expect(samePage.retrieval).toEqual(second.retrieval)
    expect(samePage.retrieval).not.toBe(second.retrieval)
  })
})
