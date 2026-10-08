import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { AgentTurn, ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import { toResponsesInput } from '@fluxos/models/modelProtocol'
import { NodeToolExecutor } from '@fluxos/tools/nodeToolExecutor'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'
import { AgentSessionRehydrator } from './runtime/agentSessionRehydrator'
import { TaskManager } from './taskManager'

describe('patch commit receipts', () => {
  let root: string
  let executor: NodeToolExecutor
  let engine: AgentEngine
  let execute: (call: ToolCall, signal?: AbortSignal) => Promise<ToolResult>
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fluxagent-patch-receipt-')))
    executor = new NodeToolExecutor(root)
    engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', gitEnabled: false, workspacePath: root }, executor,
      new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'fixture', baseUrl: 'http://example.test', model: 'fixture', contextWindow: 100_000, maxTokens: 4096 }, root))
    execute = (engine as unknown as { executeSingleTool: typeof execute }).executeSingleTool.bind(engine)
  })
  afterEach(() => { vi.restoreAllMocks(); engine.destroy(); rmSync(root, { recursive: true, force: true }) })
  const addThree = '*** Add File: first\n+one\n*** Add File: second\n+two\n*** Add File: third\n+three'
  const apply = (body: string, signal?: AbortSignal) => execute({ id: 'patch', name: 'apply_patch', arguments: { patch: `*** Begin Patch\n${body}\n*** End Patch` } }, signal)
  const effect = (path: string, action = 'write') => expect.objectContaining({ path: join(root, path), action })

  it('records all successful effects without inventing a transaction', async () => {
    const result = await apply(addThree)
    expect(result.isError).toBe(false)
    expect(result.data).toMatchObject({ kind: 'patch', status: 'completed', committed: [effect('first'), effect('second'), effect('third')], pending: [], unknown: [] })
    expect(result.output).toContain('Patch status: completed')
  })

  it('retains the first commit and unattempted files when the second write is rejected', async () => {
    const write = executor.writeFile.bind(executor)
    vi.spyOn(executor, 'writeFile').mockImplementation(async (path, text, metadata) => basename(path) === 'second'
      ? { success: false, mutation: 'not_committed', error: 'fixture rejection' } : write(path, text, metadata))
    const result = await apply(addThree)
    expect(result).toMatchObject({ isError: true, data: { kind: 'patch', status: 'partial', committed: [effect('first')], pending: [effect('second'), effect('third')], unknown: [], failure: { stage: 'write', operationIndex: 1 } } })
    expect(readFileSync(join(root, 'first'), 'utf8')).toBe('one\n')
    expect(existsSync(join(root, 'second'))).toBe(false)
    expect(existsSync(join(root, 'third'))).toBe(false)
    expect(result.output).toContain('Patch status: partial')
  })

  it('does not guess or roll back a write whose acknowledgement was lost', async () => {
    const write = executor.writeFile.bind(executor)
    vi.spyOn(executor, 'writeFile').mockImplementation(async (path, text, metadata) => {
      if (basename(path) !== 'second') return write(path, text, metadata)
      await write(path, text, metadata)
      writeFileSync(join(root, 'first'), 'concurrent user edit')
      throw new Error('fixture acknowledgement lost')
    })
    const result = await apply(addThree)
    expect(result.data).toMatchObject({ status: 'partial', committed: [effect('first')], unknown: [effect('second')], pending: [effect('third')], failure: { stage: 'write' } })
    expect(readFileSync(join(root, 'first'), 'utf8')).toBe('concurrent user edit')
    expect(readFileSync(join(root, 'second'), 'utf8')).toBe('two\n')
    expect(existsSync(join(root, 'third'))).toBe(false)
    expect(result.output).toContain('Do not blindly retry or roll back')
  })

  it('retains acknowledged publication when a later durability step fails', async () => {
    const write = executor.writeFile.bind(executor)
    vi.spyOn(executor, 'writeFile').mockImplementation(async (path, text, metadata) => {
      const result = await write(path, text, metadata)
      return basename(path) === 'second' ? { success: false, mutation: 'committed', error: 'fixture sync failed' } : result
    })
    const result = await apply(addThree)
    expect(result.data).toMatchObject({ status: 'partial', committed: [effect('first'), effect('second')], unknown: [], pending: [effect('third')] })
  })

  it('records target publication separately from a failed move source cleanup', async () => {
    writeFileSync(join(root, 'source'), 'old\n')
    vi.spyOn(executor, 'deleteFile').mockResolvedValue({ success: false, mutation: 'not_committed', error: 'fixture source locked' })
    const result = await apply('*** Update File: source\n*** Move to: target\n@@\n-old\n+new\n*** Add File: later\n+skip')
    expect(result.data).toMatchObject({ status: 'partial', committed: [effect('target')], pending: [effect('source', 'delete'), effect('later')], unknown: [], failure: { stage: 'move_cleanup', operationIndex: 0 } })
    expect(readFileSync(join(root, 'source'), 'utf8')).toBe('old\n')
    expect(readFileSync(join(root, 'target'), 'utf8')).toBe('new\n')
    expect(existsSync(join(root, 'later'))).toBe(false)
  })

  it('records source cleanup as unknown when its acknowledgement is lost', async () => {
    writeFileSync(join(root, 'source'), 'same\n')
    vi.spyOn(executor, 'deleteFile').mockRejectedValue(new Error('fixture deletion acknowledgement lost'))
    const result = await apply('*** Update File: source\n*** Move to: target\n@@\n-same\n+same')
    expect(result.data).toMatchObject({ status: 'partial', committed: [effect('target')], pending: [], unknown: [effect('source', 'delete')], failure: { stage: 'move_cleanup' } })
  })

  it('protects a destination that appears after preflight, including unchanged-content moves', async () => {
    writeFileSync(join(root, 'source'), 'same\n')
    const write = executor.writeFile.bind(executor)
    vi.spyOn(executor, 'writeFile').mockImplementation(async (...args) => {
      writeFileSync(join(root, 'target'), 'concurrent user file')
      return write(...args)
    })
    const result = await apply('*** Update File: source\n*** Move to: target\n@@\n-same\n+same')
    expect(result.data).toMatchObject({ status: 'failed', committed: [], unknown: [], pending: [effect('target'), effect('source', 'delete')], failure: { stage: 'move_target' } })
    expect(readFileSync(join(root, 'source'), 'utf8')).toBe('same\n')
    expect(readFileSync(join(root, 'target'), 'utf8')).toBe('concurrent user file')
  })

  it('stops after cancellation while retaining the completed first write', async () => {
    const abort = new AbortController()
    const write = executor.writeFile.bind(executor)
    vi.spyOn(executor, 'writeFile').mockImplementation(async (...args) => {
      const result = await write(...args)
      abort.abort(new Error('fixture stop'))
      return result
    })
    const result = await apply(addThree, abort.signal)
    expect(result.data).toMatchObject({ status: 'partial', committed: [effect('first')], pending: [effect('second'), effect('third')], unknown: [], failure: { stage: 'cancelled' } })
    expect(existsSync(join(root, 'second'))).toBe(false)
  })

  it('retains planned effects when preflight rejects a later hunk', async () => {
    writeFileSync(join(root, 'source'), 'real\n')
    const result = await apply('*** Add File: first\n+one\n*** Update File: source\n@@\n-missing\n+new')
    expect(result.data).toMatchObject({ status: 'failed', committed: [], unknown: [], pending: [effect('first'), effect('source')], failure: { stage: 'preflight' } })
    expect(existsSync(join(root, 'first'))).toBe(false)
  })

  it('preserves real partial facts in rehydration and all model message formats', async () => {
    const write = executor.writeFile.bind(executor)
    vi.spyOn(executor, 'writeFile').mockImplementation(async (path, text, metadata) => basename(path) === 'second'
      ? { success: false, mutation: 'unknown', error: 'fixture write acknowledgement missing' } : write(path, text, metadata))
    const result = await apply(addThree)
    const call: ToolCall = { id: 'patch', name: 'apply_patch', arguments: { patch: `*** Begin Patch\n${addThree}\n*** End Patch` } }
    const turns: AgentTurn[] = [
      { id: 'user', role: 'user', content: 'Apply files', timestamp: 1 },
      { id: 'assistant', role: 'assistant', content: '', toolCalls: [call], timestamp: 2 },
      { id: 'result', role: 'tool_result', content: '', toolResults: [result], timestamp: 3 },
    ]
    const rehydrator = new AgentSessionRehydrator()
    const restored = rehydrator.rehydrateMessages(JSON.parse(JSON.stringify(rehydrator.messagesFromTurns(turns))), {
      systemTurns: [], taskManager: new TaskManager(),
    })
    expect(restored.flatMap(turn => turn.toolResults ?? [])[0]?.data).toEqual(result.data)
    const internal = engine as unknown as { buildApiMessages(system: string, provider: 'openai' | 'anthropic', turns: AgentTurn[]): Array<Record<string, unknown>> }
    const chat = internal.buildApiMessages('Fixture system', 'openai', restored)
    const anthropic = internal.buildApiMessages('Fixture system', 'anthropic', restored)
    for (const payload of [chat, anthropic, toResponsesInput(chat), toResponsesInput(chat, { apply_patch: 'patch' })]) {
      const serialized = JSON.stringify(payload)
      expect(serialized).toContain('Patch status: partial')
      expect(serialized).toContain('committed=1; pending=1; unknown=1')
      expect(serialized).toContain('Do not blindly retry or roll back')
    }
  })

  it('reports unknown with no confirmed commit when the first executor call throws', async () => {
    vi.spyOn(executor, 'writeFile').mockRejectedValue(new Error('fixture transport vanished'))
    const result = await apply(addThree)
    expect(result.data).toMatchObject({ status: 'unknown', committed: [], unknown: [effect('first')], pending: [effect('second'), effect('third')] })
  })

  it('does not delete a concurrently edited move source after writing the target', async () => {
    writeFileSync(join(root, 'source'), 'old\n')
    const write = executor.writeFile.bind(executor)
    vi.spyOn(executor, 'writeFile').mockImplementation(async (...args) => {
      const result = await write(...args)
      writeFileSync(join(root, 'source'), 'concurrent source edit')
      return result
    })
    const result = await apply('*** Update File: source\n*** Move to: target\n@@\n-old\n+new')
    expect(result.data).toMatchObject({ status: 'partial', committed: [effect('target')], pending: [effect('source', 'delete')], unknown: [], failure: { stage: 'move_cleanup' } })
    expect(readFileSync(join(root, 'source'), 'utf8')).toBe('concurrent source edit')
    expect(readFileSync(join(root, 'target'), 'utf8')).toBe('new\n')
  })

  it('preserves full typed receipts and complete status counts when model text is capped', async () => {
    const names = Array.from({ length: 200 }, (_, index) => `file-${index}-${'x'.repeat(150)}`)
    vi.spyOn(executor, 'resolvePatchPaths').mockImplementation(async paths => ({ success: true, data: paths.map(name => ({ path: join(root, name), relativePath: name, identity: name })) }))
    vi.spyOn(executor, 'readFile').mockResolvedValue({ success: false, error: 'File not found' })
    vi.spyOn(executor, 'writeFile').mockImplementation(async path => path.endsWith(names[199])
      ? { success: false, mutation: 'unknown', error: 'fixture final acknowledgement lost' }
      : { success: true, mutation: 'committed' })
    const result = await apply(names.map(name => `*** Add File: ${name}\n+content`).join('\n'))
    expect(result.output.length).toBeLessThanOrEqual(20_000)
    expect(result.output).toContain('Patch status: partial\ncommitted=199; pending=0; unknown=1')
    expect(result.output).toContain('patch path listing truncated')
    expect(result.data).toMatchObject({ status: 'partial', unknown: [effect(names[199])], pending: [] })
    expect(result.data?.kind === 'patch' && result.data.committed).toHaveLength(199)
  })
})
