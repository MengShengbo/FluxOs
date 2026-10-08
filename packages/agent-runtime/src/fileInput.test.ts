import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import { NodeToolExecutor } from '@fluxos/tools/nodeToolExecutor'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'

describe('file input admission through the real executor', () => {
  let root: string
  let engine: AgentEngine
  let execute: (call: ToolCall) => Promise<ToolResult>
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fluxagent-file-input-')))
    engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', gitEnabled: false, workspacePath: root },
      new NodeToolExecutor(root, { capabilityProfile: 'danger-full-access' }),
      new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'fixture', baseUrl: 'http://example.test', model: 'test', contextWindow: 100_000, maxTokens: 4096 }, root))
    execute = (engine as unknown as { executeSingleTool(call: ToolCall): Promise<ToolResult> }).executeSingleTool.bind(engine)
  })
  afterEach(() => { engine.destroy(); rmSync(root, { recursive: true, force: true }) })

  it('rejects empty, missing and null required paths through the actual batch preprocessing', async () => {
    const batch = (engine as unknown as { executeToolCalls(calls: ToolCall[]): Promise<ToolResult[]> }).executeToolCalls.bind(engine)
    const argsList = [{ path: '' }, {}, { path: null }]
    const results = await batch(argsList.map((args, i) => ({ id: `bad-path-${i}`, name: 'list_directory', arguments: args })))
    expect(results).toHaveLength(argsList.length)
    for (const result of results) expect(result).toMatchObject({ isError: true, errorKind: 'validation' })
  })

  it.each(['write_file', 'replace_file'])('%s writes exactly zero bytes', async name => {
    if (name === 'replace_file') writeFileSync(join(root, 'target.txt'), 'previous content\r\n')
    const result = await execute({ id: name, name, arguments: { path: 'target.txt', content: '' } })
    expect(result.isError).toBe(false)
    expect(existsSync(join(root, 'target.txt'))).toBe(true)
    expect(readFileSync(join(root, 'target.txt'))).toEqual(Buffer.alloc(0))
  })

  it.each(['edit_file', 'multi_edit'])('%s deletes with explicit empty replacement and preserves surrounding bytes', async name => {
    writeFileSync(join(root, 'target.txt'), 'before\r\nremove\r\n末尾')
    const args = name === 'edit_file' ? { old_content: 'remove\r\n', new_content: '' }
      : { edits: [{ old_string: 'remove\r\n', new_string: '', replace_all: null }] }
    const result = await execute({ id: name, name, arguments: { path: 'target.txt', ...args } })
    expect(result.isError).toBe(false)
    expect(readFileSync(join(root, 'target.txt'))).toEqual(Buffer.from('before\r\n末尾'))
  })

  it.each([
    ['edit_file', { old_content: 'remove' }],
    ['edit_file', { old_content: 'remove', new_content: null }],
    ['multi_edit', { edits: [{ old_string: 'remove' }] }],
    ['multi_edit', { edits: [{ old_string: 'remove', new_string: null }] }],
    ['multi_edit', { edits: [] }],
    ['write_file', {}],
    ['replace_file', { content: null }],
  ])('%s rejects invalid input without changing the file: %j', async (name, args) => {
    writeFileSync(join(root, 'target.txt'), 'remove\r\nkeep')
    const result = await execute({ id: 'invalid', name: name as string, arguments: { path: 'target.txt', ...args as object } })
    expect(result).toMatchObject({ isError: true, errorKind: 'validation' })
    expect(readFileSync(join(root, 'target.txt'))).toEqual(Buffer.from('remove\r\nkeep'))
  })

  it('keeps all edits unwritten when a later match fails', async () => {
    writeFileSync(join(root, 'target.txt'), 'remove\nkeep')
    const result = await execute({ id: 'atomic', name: 'multi_edit', arguments: { path: 'target.txt', edits: [
      { old_string: 'remove\n', new_string: '' }, { old_string: 'absent', new_string: 'new' },
    ] } })
    expect(result.isError).toBe(true)
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('remove\nkeep')
  })
})
