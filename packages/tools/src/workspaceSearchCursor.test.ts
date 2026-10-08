import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSearch } from './workspaceSearch'
import { createSearchCapture } from './workspaceSearchCapture'
import { SearchSnapshotStore } from './searchSnapshotStore'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fluxos-search-cursor-')); roots.push(root)
  for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) writeFileSync(join(root, name), 'needle one\nneedle two\n')
  const backend = vi.fn(createSearchCapture())
  return { root, backend }
}

describe('bounded capture pagination', () => {
  it.each(['files', 'count', 'content'] as const)('scans exactly once across all %s pages and permits page-size changes', async outputMode => {
    const { root, backend } = fixture(); const service = new WorkspaceSearch(backend)
    let page = (await service.content('needle', root, undefined, false, { outputMode, limit: 1 })).data!
    const items = [...(outputMode === 'content' ? page.hits : page.files!)]
    const id = page.snapshot!.id
    while (page.nextCursor) {
      page = (await service.content('needle', root, undefined, false, { outputMode, cursor: page.nextCursor, limit: 2 })).data!
      expect(page.snapshot!.id).toBe(id)
      items.push(...(outputMode === 'content' ? page.hits : page.files!))
    }
    expect(items).toHaveLength(outputMode === 'content' ? 8 : 4)
    expect(new Set(items.map(item => JSON.stringify(item))).size).toBe(items.length)
    expect(backend).toHaveBeenCalledTimes(1)
    await service.content('needle', root, undefined, false, { outputMode })
    expect(backend).toHaveBeenCalledTimes(2)
  })

  it('rejects changed bound options before scanning and rejects tampered cursors', async () => {
    const { root, backend } = fixture(); const service = new WorkspaceSearch(backend)
    const first = (await service.content('needle', root, undefined, false, { limit: 1 })).data!
    for (const change of [{ contextBefore: 1 }, { contextAfter: 1 }, { maxColumns: 120 }, { multiline: true }, { fixedStrings: true }, { fileType: 'ts' }, { outputMode: 'files' as const }, { includeIgnored: true }]) {
      expect(await service.content('needle', root, undefined, false, { cursor: first.nextCursor, ...change })).toMatchObject({ success: false, errorKind: 'validation' })
    }
    for (const args of [
      ['needle', root, '*.ts', false], ['needle', root, undefined, true], ['other', root, undefined, false], ['needle', join(root, 'a.ts'), undefined, false],
    ] as const) expect(await service.content(...args, { cursor: first.nextCursor })).toMatchObject({ success: false, errorKind: 'validation' })
    expect(await service.files('*.ts', root, { cursor: first.nextCursor })).toMatchObject({ success: false, errorKind: 'validation' })
    const tampered = first.nextCursor!.replace('.1.', '.2.')
    expect(await service.content('needle', root, undefined, false, { cursor: tampered })).toMatchObject({ success: false, errorKind: 'validation' })
    expect(backend).toHaveBeenCalledTimes(1)
  })

  it('expires and evicts captures without silently rescanning', async () => {
    const { root, backend } = fixture(); let now = Date.now()
    const service = new WorkspaceSearch(backend, { now: () => now, ttlMs: 1000, maxEntries: 1 })
    const first = (await service.files('*.ts', root, { limit: 1 })).data!
    now += 1000
    expect(await service.files('*.ts', root, { cursor: first.nextCursor })).toMatchObject({ success: false, errorKind: 'environment' })
    const second = (await service.files('*.ts', root, { limit: 1 })).data!
    await service.files('*', root, { limit: 1 })
    expect(await service.files('*.ts', root, { cursor: second.nextCursor })).toMatchObject({ success: false, errorKind: 'environment' })
    expect(backend).toHaveBeenCalledTimes(3)
  })

  it('bounds retained records, reports incomplete reasons and never mutates saved pages', () => {
    const store = new SearchSnapshotStore({ maxEntryBytes: 1000 })
    const page = store.start('key', Array.from({ length: 100 }, (_, index) => ({ text: `item ${index}` })), value => value, [], Date.now(), { limit: 1 })
    expect(page).toMatchObject({ totalMatches: 100, totalIsExact: false, truncated: true, incompleteReasons: ['result_budget'] })
    const cursor = page.nextCursor!
    const next = store.continue<{ text: string }>('key', { cursor })
    const original = structuredClone(next)
    expect(original.selected[0]).toEqual({ text: 'item 1' })
    expect(original.selected.length).toBeGreaterThan(0)
    next.selected[0].text = 'changed by caller'; next.snapshot.id = 'changed'; next.incompleteReasons.length = 0
    expect(store.continue<{ text: string }>('key', { cursor })).toEqual(original)
    expect(store.continue('key', { cursor }).nextCursor).toBeUndefined()
  })

  it('enforces aggregate storage independently of the entry count', () => {
    const store = new SearchSnapshotStore({ maxTotalBytes: 1400, maxEntries: 8 })
    const first = store.start('first', ['a', 'b'], value => value, [], Date.now(), { limit: 1 })
    store.start('second', ['a', 'b'], value => value, [], Date.now(), { limit: 1 })
    store.start('third', ['a', 'b'], value => value, [], Date.now(), { limit: 1 })
    expect(() => store.continue('first', { cursor: first.nextCursor })).toThrow('evicted')
  })

  it('returns typed cancellation for fresh and saved requests without another capture', async () => {
    const { root, backend } = fixture(); const service = new WorkspaceSearch(backend)
    const first = (await service.files('*.ts', root, { limit: 1 })).data!
    const controller = new AbortController(); controller.abort()
    for (const cursor of [undefined, first.nextCursor]) {
      expect(await service.files('*.ts', root, { signal: controller.signal, cursor })).toMatchObject({ success: false, errorKind: 'abort' })
    }
    expect(backend).toHaveBeenCalledTimes(1)
  })

  it('reports corrupt records without treating partial capture as no matches', async () => {
    const { root } = fixture()
    const service = new WorkspaceSearch(async () => ({ output: '{invalid}\n', reasons: ['path_error'] }))
    expect(await service.content('needle', root)).toMatchObject({ success: true, data: { hits: [], totalIsExact: false, truncated: true, incompleteReasons: ['path_error', 'decode_error'] } })
  })

  it('does not claim completeness when the final record is unterminated', async () => {
    const { root } = fixture()
    const files = new WorkspaceSearch(async () => ({ output: 'a.ts\0partial-path', reasons: [] }))
    expect(await files.files('*', root)).toMatchObject({ success: true, data: { matches: [join(root, 'a.ts')], totalIsExact: false, incompleteReasons: ['decode_error'] } })
    const content = new WorkspaceSearch(async () => ({ output: '{"type":"match"', reasons: [] }))
    expect(await content.content('needle', root)).toMatchObject({ success: true, data: { totalIsExact: false, truncated: true, incompleteReasons: ['decode_error'] } })
  })
})
