import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryHistoryHit, MemoryHistorySource, MemoryPolicy } from '@fluxos/contracts/memoryTypes'
import { ContinuumMaintenance, ContinuumStore } from './continuum'
import { routeRecall } from './continuumRecall'
import { DEFAULT_MEMORY_POLICY } from './longTerm'
import { getToolByName, validateToolArgs } from '../toolRegistry'
import { builtInToolAccess } from '../toolAccess'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

const DAY = 86_400_000
/** Production digests are 64-hex sha256; the strict ref parser requires the same shape. */
function digestFor(id: string): string {
  return id.replace(/[^a-f0-9]/gi, '').padEnd(64, '0').slice(0, 64)
}
function hit(id: string, conversationId: string, messageId: string, text: string, at: number, digest = digestFor(id)): MemoryHistoryHit {
  return { id, conversationId, messageId, workspaceId: 'a', title: `会话 ${conversationId}`, kind: 'user', text, offset: 0, digest, updatedAt: at, score: 1 }
}

function setup(options?: { policy?: Partial<MemoryPolicy> }) {
  const root = mkdtempSync(join(tmpdir(), 'flux-continuum-')); roots.push(root)
  let now = Date.parse('2026-10-24T12:00:00Z')
  const base = now - 3 * DAY
  const hits: MemoryHistoryHit[] = [
    hit('h1', 'c1', 'm1', '和阿澄确定了展示会的分工', base + 3_600_000),
    hit('h2', 'c1', 'm2', '预算上限 5000 元', base + 7_200_000),
    hit('h3', 'c2', 'm1', 'FluxOs 内核拆分完成', now - 3_600_000),
  ]
  const history: MemoryHistorySource = {
    search: vi.fn(request => hits.filter(hit => (request.acrossProjects || hit.workspaceId === 'a') && hit.text.includes(request.query))),
    read: request => hits.find(h => h.conversationId === request.conversationId && h.messageId === request.messageId && h.offset === request.offset),
    pending: checkpoints => hits.filter(h => checkpoints[h.id] !== h.digest),
  }
  const store = new ContinuumStore(join(root, 'memory'), () => now)
  const policy: MemoryPolicy = { ...DEFAULT_MEMORY_POLICY, ...options?.policy }
  const summaries = vi.fn(() => [{ conversationId: 'c1', title: '会话 c1', text: '与阿澄推进展示会筹备', updatedAt: base + 7_200_000, evidence: [] }])
  let suppressed: string[] = []
  const maintenance = new ContinuumMaintenance(store, history, () => policy, summaries, () => suppressed, () => now)
  const signal = new AbortController().signal
  const generate = vi.fn(async () => JSON.stringify({ entities: [{ name: '阿澄', kind: 'person', aliases: ['澄'], summary: '展示会合作者', events: [{ date: '2026-10-21', text: '确定分工与预算', sourceIds: ['S1'] }] }] }))
  return { root, store, maintenance, history, hits, policy, summaries, generate, signal, clock: () => now, advance: (ms: number) => { now += ms }, suppress: (keys: string[]) => { suppressed = keys } }
}

describe('continuum store', () => {
  it('assembles daily rollups mechanically with message-level references, then resumes without repeats', async () => {
    const { maintenance, generate, signal, store } = setup()
    const outcome = await maintenance.run(generate, signal)
    expect(outcome.dailyAppended).toBeGreaterThan(0)
    expect(store.listDailyDates()).toEqual(['2026-10-21', '2026-10-24'])
    const rollup = store.readDaily('2026-10-21')!
    expect(rollup.entries).toHaveLength(1)
    expect(rollup.entries[0].keyDetails).toHaveLength(2)
    expect(rollup.entries[0].keyDetails[0].refs[0]).toMatchObject({ conversationId: 'c1', messageId: 'm1', digest: digestFor('h1') })
    const second = await maintenance.run(generate, signal)
    expect(second.dailyAppended).toBe(0)
  })

  it('keeps hand edits when appending new material', () => {
    const { root, store } = setup()
    store.appendDaily('2026-10-24', [{ conversationId: 'c2', title: '会话 c2', workspaceId: 'a', summary: '内核拆分', keyDetails: [{ text: 'FluxOs 内核拆分完成', refs: [{ conversationId: 'c2', messageId: 'm1', offset: 0, digest: digestFor('h3') }] }] }])
    const file = join(root, 'memory', 'continuum', 'daily', '2026-10-24.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('# Daily rollup 2026-10-24', '# Daily rollup 2026-10-24\n\n用户手写备注：今天状态不错'), 'utf8')
    store.appendDaily('2026-10-24', [{ conversationId: 'c3', title: '会话 c3', workspaceId: 'a', summary: '', keyDetails: [{ text: '新对话内容', refs: [] }] }])
    const rollup = store.readDaily('2026-10-24')!
    expect(rollup.entries.map(entry => entry.conversationId)).toEqual(['c2', 'c3'])
    expect(readFileSync(file, 'utf8')).toContain('用户手写备注：今天状态不错')
  })

  it('merges entity dossiers by name or alias and appends timeline events only once', () => {
    const { store } = setup()
    const first = store.upsertEntity({ name: '阿澄', kind: 'person', aliases: ['澄'], summary: '展示会合作者', events: [{ date: '2026-10-21', at: Date.parse('2026-10-21T00:00:00Z'), text: '确定分工', refs: [] }] })
    const second = store.upsertEntity({ name: '澄', kind: 'person', summary: '展示会合作者，负责物料', events: [{ date: '2026-10-21', at: Date.parse('2026-10-21T00:00:00Z'), text: '确定分工', refs: [] }, { date: '2026-10-23', at: Date.parse('2026-10-23T00:00:00Z'), text: '负责物料', refs: [] }] })
    expect(second.created).toBe(false)
    expect(second.slug).toBe(first.slug)
    const dossier = store.readEntity(first.slug)!
    expect(dossier.aliases).toContain('澄')
    expect(dossier.timeline).toHaveLength(2)
    expect(dossier.timeline.map(event => event.text)).toEqual(['确定分工', '负责物料'])
  })

  it('propagates forgets by dropping timeline events with suppressed evidence', () => {
    const { store } = setup()
    const { slug } = store.upsertEntity({ name: '阿澄', kind: 'person', summary: '合作者', events: [
      { date: '2026-10-21', at: 0, text: '保留事件', refs: [{ conversationId: 'c1', messageId: 'm1', offset: 0, digest: digestFor('keep') }] },
      { date: '2026-10-22', at: 0, text: '被遗忘事件', refs: [{ conversationId: 'c1', messageId: 'm2', offset: 0, digest: digestFor('drop') }] },
    ] })
    const touched = store.dropSuppressedRefs(['c1:m2'])
    expect(touched).toEqual([slug])
    expect(store.readEntity(slug)!.timeline.map(event => event.text)).toEqual(['保留事件'])
  })

  it('rejects fabricated source references from extraction and records the failure', async () => {
    const { root, maintenance, signal, store } = setup()
    const bad = async () => JSON.stringify({ entities: [{ name: '幽灵', kind: 'topic', summary: '捏造', events: [{ date: '2026-10-21', text: '无来源事件', sourceIds: ['S99'] }] }] })
    const outcome = await maintenance.run(bad, signal)
    expect(outcome.entitiesTouched).toBe(0)
    expect(store.status().lastError).toContain('unsupported source')
    expect(existsSync(join(root, 'memory', 'continuum', 'entities'))).toBe(false)
  })

  it('gates entity extraction behind the daily continuum budget while dailies stay mechanical', async () => {
    const { maintenance, generate, signal, advance, hits, store } = setup({ policy: { maxContinuumCallsPerDay: 1 } })
    await maintenance.run(generate, signal)
    expect(store.status().callsToday).toBe(1)
    expect(generate).toHaveBeenCalledTimes(1)
    advance(DAY)
    hits.push(hit('h4', 'c3', 'm1', '新的对话内容', Date.parse('2026-10-25T10:00:00Z')))
    const nextDay = await maintenance.run(async () => { throw new Error('extraction exploded') }, signal)
    expect(nextDay.dailyAppended).toBeGreaterThan(0)
    expect(nextDay.entityCalls).toBe(1)
    expect(store.status().lastError).toContain('extraction exploded')
  })
})

describe('continuum recall routing', () => {
  it('routes recent to summaries plus the latest rollups', () => {
    const { store } = setup()
    store.appendDaily('2026-10-24', [{ conversationId: 'c2', title: '会话 c2', workspaceId: 'a', summary: '', keyDetails: [{ text: 'FluxOs 内核拆分完成', refs: [] }] }])
    const result = routeRecall({ depth: 'recent' }, { store, now: () => Date.parse('2026-10-24T12:00:00Z'), summaries: () => [{ conversationId: 'c1', title: '会话 c1', text: '与阿澄推进展示会筹备', updatedAt: 1, evidence: [] }] })
    expect(result.sections.map(section => section.kind)).toEqual(['summary', 'rollup'])
  })

  it('routes topic through entity dossiers and matched rollups', () => {
    const { store } = setup()
    store.upsertEntity({ name: '阿澄', kind: 'person', aliases: [], summary: '展示会合作者', events: [{ date: '2026-10-21', at: 0, text: '确定分工与预算上限 5000 元', refs: [] }] })
    const result = routeRecall({ depth: 'topic', query: '阿澄' }, { store })
    expect(result.sections[0]).toMatchObject({ kind: 'entity', title: expect.stringContaining('阿澄') })
    expect(result.sections[0].text).toContain('5000')
  })

  it('routes deep across rollups and message history with provenance next reads', () => {
    const { store, hits } = setup()
    store.appendDaily('2026-10-21', [{ conversationId: 'c1', title: '会话 c1', workspaceId: 'a', summary: '', keyDetails: [{ text: '和阿澄确定了展示会的分工', refs: [{ conversationId: 'c1', messageId: 'm1', offset: 0, digest: digestFor('h1') }] }] }])
    const result = routeRecall({ depth: 'deep', query: '阿澄' }, { store, searchMessages: (query, limit) => hits.filter(hit => hit.text.includes(query)).slice(0, limit) })
    const kinds = result.sections.map(section => section.kind)
    expect(kinds).toContain('rollup')
    const message = result.sections.find(section => section.kind === 'message')
    expect(message?.nextReads).toEqual([{ conversationId: 'c1', messageId: 'm1', offset: 0 }])
  })

  it('routes exact to message chunks and reports misses honestly', () => {
    const { store, hits } = setup()
    const found = routeRecall({ depth: 'exact', query: '预算' }, { store, searchMessages: (query, limit) => hits.filter(hit => hit.text.includes(query)).slice(0, limit) })
    expect(found.sections[0].text).toContain('5000')
    const miss = routeRecall({ depth: 'exact', query: '不存在' }, { store, searchMessages: () => [] })
    expect(miss.sections[0].kind).toBe('hint')
  })
})

describe('recall tool surface', () => {
  it('registers a read-only recall tool with declared access', () => {
    const tool = getToolByName('recall')
    expect(tool).toMatchObject({ isReadOnly: true, isConcurrencySafe: true })
    expect(() => builtInToolAccess('recall')).not.toThrow()
  })
  it('enforces depth-scoped argument rules', () => {
    expect(validateToolArgs('recall', { depth: 'recent' })).toEqual({ valid: true })
    expect(validateToolArgs('recall', { depth: 'exact', query: 'x' })).toEqual({ valid: true })
    expect(validateToolArgs('recall', { depth: 'exact' }).valid).toBe(false)
    expect(validateToolArgs('recall', { depth: 'recent', query: 'x', entity: 'y' }).valid).toBe(false)
    expect(validateToolArgs('recall', { depth: 'topic', query: 'x', date: '2026-10-24' }).valid).toBe(false)
    expect(validateToolArgs('recall', { depth: 'deep', date: '2026-10-24' })).toEqual({ valid: true })
    expect(validateToolArgs('recall', { depth: 'deep', date: '昨天' }).valid).toBe(false)
  })
})
