import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WebSourceStore, formatWebSources } from './webSourceStore'

describe('model-visible source coverage', () => {
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
