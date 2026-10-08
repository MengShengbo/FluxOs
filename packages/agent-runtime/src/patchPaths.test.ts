import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import type { ToolExecutor } from '@fluxos/contracts/toolExecutor'
import { NodeToolExecutor } from '@fluxos/tools/nodeToolExecutor'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'

describe('native patch path identity', () => {
  let root: string
  let executor: NodeToolExecutor
  let engine: AgentEngine
  let execute: (call: ToolCall) => Promise<ToolResult>
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fluxagent-patch-paths-')))
    executor = new NodeToolExecutor(root)
    engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', gitEnabled: false, workspacePath: root }, executor,
      new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'fixture', baseUrl: 'http://example.test', model: 'test', contextWindow: 100_000, maxTokens: 4096 }, root))
    execute = (engine as unknown as { executeSingleTool(call: ToolCall): Promise<ToolResult> }).executeSingleTool.bind(engine)
  })
  afterEach(() => { engine.destroy(); rmSync(root, { recursive: true, force: true }) })

  async function apply(body: string) {
    return execute({ id: 'patch-paths', name: 'apply_patch', arguments: { patch: `*** Begin Patch\n${body}\n*** End Patch` } })
  }
  function detectNativeCaseSensitivity() {
    writeFileSync(join(root, 'CaseProbe'), '')
    const sensitive = !existsSync(join(root, 'caseprobe'))
    rmSync(join(root, 'CaseProbe'))
    return sensitive
  }
  it('follows measured filesystem rules for two new case spellings before writing either target', async () => {
    const sensitive = detectNativeCaseSensitivity()
    const result = await apply('*** Add File: A.ts\n+UPPER\n*** Add File: a.ts\n+lower')
    expect(result.isError).toBe(!sensitive)
    if (sensitive) {
      expect(readFileSync(join(root, 'A.ts'), 'utf8')).toBe('UPPER\n')
      expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('lower\n')
    } else expect(existsSync(join(root, 'A.ts'))).toBe(false)
    expect(readdirSync(root).some(name => name.startsWith('.fluxagent-patch-'))).toBe(false)
  })
  it('uses native rules for nested directories that do not exist yet', async () => {
    const sensitive = detectNativeCaseSensitivity()
    const result = await apply('*** Add File: Dir/A.ts\n+UPPER\n*** Add File: dir/a.ts\n+lower')
    expect(result.isError).toBe(!sensitive)
    if (sensitive) expect(readFileSync(join(root, 'Dir', 'A.ts'), 'utf8')).toBe('UPPER\n')
    else expect(existsSync(join(root, 'Dir'))).toBe(false)
  })
  it('rejects duplicate normalized paths and move conflicts during preflight', async () => {
    const duplicate = await apply('*** Add File: a.ts\n+one\n*** Add File: ./a.ts\n+two')
    expect(duplicate.isError).toBe(true)
    expect(existsSync(join(root, 'a.ts'))).toBe(false)
    writeFileSync(join(root, 'a.ts'), 'old\r\n')
    const move = await apply('*** Update File: a.ts\n*** Move to: b.ts\n@@\n-old\n+new\n*** Add File: ./b.ts\n+clobber')
    expect(move.isError).toBe(true)
    expect(existsSync(join(root, 'b.ts'))).toBe(false)
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('old\r\n')
  })
  it('preserves two distinct case identities provided by a case-sensitive executor', async () => {
    // Adapter fixture: this proves Engine does not re-fold native identities;
    // it is not a claim that the host volume or another OS was case-sensitive.
    const files = new Map([['A.ts', 'UPPER\n'], ['a.ts', 'lower\n']])
    const virtualExecutor = {
      resolvePatchPaths: async (paths: string[]) => ({ success: true, data: paths.map(path => ({ path, relativePath: path, identity: path })) }),
      readFile: async (path: string) => files.has(path) ? { success: true, data: files.get(path)! } : { success: false, error: 'File not found' },
      writeFile: async (path: string, content: string) => { files.set(path, content); return { success: true, mutation: 'committed' } },
    } as unknown as ToolExecutor
    engine.destroy()
    engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', gitEnabled: false, workspacePath: root }, virtualExecutor,
      new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'fixture', baseUrl: 'http://example.test', model: 'test', contextWindow: 100_000, maxTokens: 4096 }, root))
    execute = (engine as unknown as { executeSingleTool(call: ToolCall): Promise<ToolResult> }).executeSingleTool.bind(engine)
    const result = await apply('*** Update File: A.ts\n@@\n-UPPER\n+changed upper\n*** Update File: a.ts\n@@\n-lower\n+changed lower')
    expect(result.isError).toBe(false)
    expect(files.get('A.ts')).toBe('changed upper\n')
    expect(files.get('a.ts')).toBe('changed lower\n')
  })
  it('rejects multiple writes to existing symlink and hardlink aliases', async () => {
    writeFileSync(join(root, 'target'), 'old\r\n')
    for (const kind of ['symlink', 'hardlink']) {
      const alias = join(root, kind)
      if (kind === 'symlink') symlinkSync(join(root, 'target'), alias)
      else linkSync(join(root, 'target'), alias)
      const result = await apply(`*** Update File: target\n@@\n-old\n+one\n*** Update File: ${kind}\n@@\n-old\n+two`)
      expect(result.isError).toBe(true)
      expect(readFileSync(join(root, 'target'), 'utf8')).toBe('old\r\n')
    }
  })
  it.each([false, true])('rejects a missing-file/parent-directory collision, reversed=%s', async reversed => {
    const operations = ['*** Add File: parent\n+file', '*** Add File: parent/child\n+child']
    const result = await apply((reversed ? operations.reverse() : operations).join('\n'))
    expect(result.isError).toBe(true)
    expect(existsSync(join(root, 'parent'))).toBe(false)
  })
  it('does not create the valid first file when a later EOF match is invalid', async () => {
    writeFileSync(join(root, 'source'), 'same\ntail')
    const result = await apply('*** Add File: first\n+must not appear\n*** Update File: source\n@@\n-same\n+changed\n*** End of File')
    expect(result.isError).toBe(true)
    expect(existsSync(join(root, 'first'))).toBe(false)
    expect(readFileSync(join(root, 'source'), 'utf8')).toBe('same\ntail')
  })
  it('writes the exact requested filename and preserves unrelated CRLF bytes', async () => {
    writeFileSync(join(root, ' spaced '), 'a\r\nold\r\nz')
    const result = await apply('*** Update File:  spaced \n@@\n-old\n+new')
    expect(result.isError).toBe(false)
    expect(readFileSync(join(root, ' spaced '), 'utf8')).toBe('a\r\nnew\r\nz')
    expect(existsSync(join(root, 'spaced'))).toBe(false)
  })
})
