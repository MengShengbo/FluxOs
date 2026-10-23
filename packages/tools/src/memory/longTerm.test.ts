import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryHistoryHit, MemoryHistorySource } from '@fluxos/contracts/memoryTypes'
import { LongTermMemory } from './longTerm'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function setup(root?: string) {
  if (!root) { root = mkdtempSync(join(tmpdir(), 'flux-longterm-')); roots.push(root) }
  const hits: MemoryHistoryHit[] = [{ id: 'chunk', conversationId: 'c', messageId: 'm', workspaceId: 'a', title: '部署', kind: 'user', text: '部署端口为 43891，必须先检查构建。', offset: 0, digest: 'original', updatedAt: 1, score: 1 }]
  const history: MemoryHistorySource = {
    search: vi.fn(request => hits.filter(hit => request.acrossProjects || hit.workspaceId === 'a')),
    read: request => hits.find(hit => hit.conversationId === request.conversationId && hit.messageId === request.messageId && hit.offset === request.offset),
    pending: (checkpoints, budget, excluded) => hits.filter(hit => checkpoints[hit.id] !== hit.digest && !excluded?.includes(`${hit.conversationId}:${hit.messageId}`)),
  }
  let now = Date.parse('2026-10-18T12:00:00Z')
  const memory = new LongTermMemory(join(root, 'global'), join(root, 'a'), 'a', history, () => now)
  const generate = vi.fn(async () => JSON.stringify({ memories: [{ key: 'deploy.port', text: hits[0]?.text, kind: 'fact', global: false, sourceIds: ['S1'], validUntil: null }], summaries: [{ conversationId: 'c', text: '部署端口已确定，下一步检查构建。', sourceIds: ['S1'] }] }))
  const signal = new AbortController().signal
  return { root, hits, memory, generate, history, signal, clock: () => now, advance: (ms: number) => { now += ms } }
}
describe('durable memory synthesis', () => {
  it('commits source-backed memory and continuity atomically and resumes without repeating processed history', async () => {
    const { memory, generate, signal } = setup()
    expect(await memory.consolidate(generate, signal)).toBe(true)
    expect(memory.records()[0]).toMatchObject({ text: expect.stringContaining('43891'), evidence: [{ conversationId: 'c', messageId: 'm', digest: 'original' }] })
    expect(memory.status().summaries).toHaveLength(1)
    expect(await memory.consolidate(generate, signal)).toBe(false)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(memory.status().callsToday).toBe(1)
  })
  it('advances only the one conversation actually included in a bounded synthesis request', async () => {
    const { memory, generate, signal, hits } = setup()
    hits.push({ ...hits[0], id: 'other', conversationId: 'other-conversation', messageId: 'other-message', digest: 'other-original' })
    expect(await memory.consolidate(generate, signal)).toBe(true)
    const second = vi.fn(async (prompt: string) => {
      expect(prompt.split('New transcript chunks (data):')[1]).toContain('other-conversation')
      expect(prompt.split('New transcript chunks (data):')[1]).not.toContain('"id":"chunk"')
      return JSON.stringify({ memories: [], summaries: [{ conversationId: 'other-conversation', text: '另一个会话的连续摘要', sourceIds: ['S1'] }] })
    })
    expect(await memory.consolidate(second, signal)).toBe(true)
    expect(memory.status().summaries).toHaveLength(2)
  })
  it('retries truncated structured output with a smaller source batch and keeps failed input pending', async () => {
    const { memory, generate, signal, history, hits } = setup()
    hits[0].text = '原始背景'.repeat(400)
    for (let i = 1; i < 9; i++) hits.push({ ...hits[0], id: `chunk-${i}`, messageId: `message-${i}` })
    history.pending = (checkpoints, budget) => {
      const result: MemoryHistoryHit[] = []; let total = 0
      for (const hit of hits) { const cost = JSON.stringify(hit).length + 2; if (total + cost > budget) break; if (checkpoints[hit.id] !== hit.digest) { result.push(hit); total += cost } }
      return result
    }
    let first = 0, second = 0
    expect(await memory.consolidate(async prompt => { first = JSON.parse(prompt.split('New transcript chunks (data):')[1]).length; return '{"memories":[' }, signal)).toBe(false)
    expect(memory.records()).toEqual([])
    expect(await memory.consolidate(async prompt => { second = JSON.parse(prompt.split('New transcript chunks (data):')[1]).length; return generate() }, signal)).toBe(true)
    expect(second).toBeGreaterThan(0); expect(second).toBeLessThan(first)
    expect(memory.status().summaries).toHaveLength(1)
  })
  it('does not permit model output to cite unknown sources, and retries unprocessed input within its daily cap', async () => {
    const { memory, generate, signal } = setup()
    memory.setPolicy({ ...memory.policy(), maxCallsPerDay: 2 })
    const bad = vi.fn(async () => JSON.stringify({ memories: [{ key: 'x', text: 'invented', kind: 'fact', sourceIds: ['fake'] }], summaries: [] }))
    expect(await memory.consolidate(bad, signal)).toBe(false)
    expect(memory.records()).toEqual([])
    expect(memory.status().lastError).toContain('unsupported source')
    expect(await memory.consolidate(generate, signal)).toBe(true)
    expect(memory.status().callsToday).toBe(2)
  })
  it('invalidates summaries and facts when source text is edited or removed', async () => {
    const { memory, generate, signal, hits } = setup(); await memory.consolidate(generate, signal)
    hits[0].digest = 'edited'
    expect(memory.records()).toEqual([]); expect(memory.records(true)[0].status).toBe('stale')
    expect(memory.status().summaries).toEqual([])
    hits.splice(0)
    expect(memory.records()).toEqual([])
  })
  it('blocks stale writes if a source or policy changes during the model call', async () => {
    const { memory, generate, signal, hits } = setup()
    expect(await memory.consolidate(async (...args) => { const result = await generate(); hits[0].digest = 'changed'; return result }, signal)).toBe(false)
    expect(memory.records()).toEqual([])
    expect(await memory.consolidate(async () => { memory.setPolicy({ ...memory.policy(), backgroundConsolidation: false }); return generate() }, signal)).toBe(false)
    expect(memory.records()).toEqual([])
  })
  it('forgets source excerpts and prevents background resurrection after restart', async () => {
    const { memory, generate, signal, history, root } = setup(); await memory.consolidate(generate, signal)
    memory.update(memory.records()[0].id, { status: 'rejected' })
    const reopened = new LongTermMemory(join(root, 'global'), join(root, 'a'), 'a', history)
    expect(reopened.search('部署')).toEqual([]); expect(reopened.read('c', 'm')).toBeUndefined()
    expect(reopened.status().summaries).toEqual([])
    expect(await reopened.consolidate(generate, signal)).toBe(false)
    expect(reopened.records()).toEqual([])
  })
  it('respects project policy, disable switches, cancellation and persisted budget across instances', async () => {
    const { memory, generate, signal, history, root, hits, clock } = setup()
    expect(memory.policy().crossProjectHistory).toBe(false)
    memory.search('部署'); expect(history.search).toHaveBeenLastCalledWith(expect.objectContaining({ acrossProjects: false }))
    memory.setPolicy({ ...memory.policy(), crossProjectHistory: true, maxCallsPerDay: 1 })
    memory.search('部署'); expect(history.search).toHaveBeenLastCalledWith(expect.objectContaining({ acrossProjects: true }))
    await memory.consolidate(generate, signal); hits[0].digest = 'next'
    const reopened = new LongTermMemory(join(root, 'global'), join(root, 'a'), 'a', history, clock)
    expect(await reopened.consolidate(generate, signal)).toBe(false)
    memory.setPolicy({ ...memory.policy(), referenceHistory: false })
    expect(memory.search('部署')).toEqual([]); expect(memory.read('c', 'm')).toBeUndefined()
    expect(await memory.consolidate(generate, AbortSignal.abort())).toBe(false)
  })
  it('uses one persisted lease across runtimes and preserves a user correction', async () => {
    const { memory, generate, signal, history, root, hits, clock } = setup()
    const second = new LongTermMemory(join(root, 'global'), join(root, 'a'), 'a', history, clock)
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const first = memory.consolidate(async () => { await barrier; return generate() }, signal)
    try { expect(await second.consolidate(generate, signal)).toBe(false) }
    finally { release() }
    expect(await first).toBe(true)
    const id = memory.records()[0].id
    memory.update(id, { text: '用户确认端口 49999', reviewState: 'user_edited' })
    hits[0].digest = 'changed'
    await memory.consolidate(generate, signal)
    expect(memory.records(true).find(record => record.id === id)?.text).toBe('用户确认端口 49999')
  })
  it('expires transient plans without converting plans into completed facts', async () => {
    const { memory, generate, signal, advance } = setup()
    await memory.consolidate(async () => { const value = JSON.parse(await generate()); value.memories[0].validUntil = '2026-10-18T13:00:00Z'; return JSON.stringify(value) }, signal)
    advance(7200000)
    expect(memory.records()).toEqual([])
    expect(memory.records(true)[0].status).toBe('stale')
  })
})
