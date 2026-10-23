import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WebSourceStore, formatWebSources } from './webSourceStore'

describe('model-visible source coverage', () => {
  it('includes the located phrase even when the requested excerpt is shorter than leading context', () => {
    const store = new WebSourceStore()
    const saved = store.save({ url: 'https://example.test', title: 'Page', retrievedAt: '2026-10-21', text: 'x'.repeat(800) + 'needle' + 'z'.repeat(800), truncated: false })
    const excerpt = store.read(saved.id, 0, 200, 'needle')
    expect(excerpt.matchFound).toBe(true)
    expect(excerpt.text).toContain('needle')
    expect(excerpt.text.length).toBeLessThanOrEqual(200)
  })

  it('reports offsets in the original source when Unicode lowercasing changes string length', () => {
    const store = new WebSourceStore()
    const saved = store.save({ url: 'https://example.test', title: 'Page', retrievedAt: '2026-10-21', text: 'İ'.repeat(800) + 'NEEDLE' + 'z'.repeat(800), truncated: false })
    const excerpt = store.read(saved.id, 0, 200, 'needle')
    expect(excerpt.text).toContain('NEEDLE')
    expect(saved.text.slice(excerpt.offset, excerpt.endOffset)).toBe(excerpt.text)
  })

  it('keeps literal search syntax and does not split surrogate pairs between pages', () => {
    const store = new WebSourceStore()
    const saved = store.save({ url: 'https://example.test', title: 'Page', retrievedAt: '2026-10-21', text: 'x'.repeat(199) + '🙂' + 'literal [a]+(b)?' + 'z'.repeat(400), truncated: false })
    const first = store.read(saved.id, 0, 200)
    expect(first.endOffset).toBe(199)
    expect(first.text).toBe('x'.repeat(199))
    const second = store.read(saved.id, first.nextOffset, 200)
    expect(second.text.startsWith('🙂')).toBe(true)
    expect(store.read(saved.id, 0, 200, '[a]+(b)?').text).toContain('[a]+(b)?')
  })

  it.each(['url', 'text', 'id'] as const)('rejects a persisted source with corrupted %s instead of presenting it as fetched evidence', field => {
    const folder = mkdtempSync(join(tmpdir(), 'tf-web-sources-'))
    try {
      const source = new WebSourceStore(folder).save({ url: 'https://official.test/page', title: 'Official', retrievedAt: '2026-10-07', text: 'Fetched evidence', truncated: false })
      writeFileSync(join(folder, source.id + '.json'), JSON.stringify({ ...source, [field]: 'forged' }))
      expect(() => new WebSourceStore(folder).read(source.id)).toThrow('Invalid stored web source')
    } finally { rmSync(folder, { recursive: true, force: true }) }
  })

  it('preserves each source and locates omitted middle evidence in the same durable version', () => {
    const folder = mkdtempSync(join(tmpdir(), 'tf-web-sources-'))
    try {
      const store = new WebSourceStore(folder)
      const first = store.save({ url: 'https://official.test/models', title: 'Model catalog', retrievedAt: '2026-09-24', text: 'intro '.repeat(1800) + 'NEW_ENTRY verified in middle' + ' footer'.repeat(1500), truncated: false })
      const second = store.save({ url: 'https://official.test/pricing', title: 'Pricing', retrievedAt: '2026-09-24', text: 'Second source contains pricing.', truncated: false })
      const response = { pages: [first, second].map(source => ({ id: 'W', sourceId: source.id, totalChars: source.text.length, url: source.url, finalUrl: source.url, domain: 'official.test', title: source.title, text: source.text, excerpt: '', contentType: 'text/plain', retrievedAt: source.retrievedAt, wordCount: 10, truncated: false, untrusted: true as const })), failures: [], retrievedAt: '2026-09-24', partial: false, warnings: [] }
      const visible = formatWebSources(response, 7800)
      expect(visible.length).toBeLessThan(7800)
      expect(visible).toContain(first.id); expect(visible).toContain(second.id)
      expect(visible).toContain('Second source contains pricing.')
      expect(visible).toContain('nextOffset')
      const restored = new WebSourceStore(folder)
      const match = restored.read(first.id, 0, 2000, 'NEW_ENTRY')
      expect(match.matchFound).toBe(true); expect(match.text).toContain('NEW_ENTRY verified in middle')
      expect(() => restored.read('../../private')).toThrow('Invalid')
    } finally { rmSync(folder, { recursive: true, force: true }) }
  })
})
