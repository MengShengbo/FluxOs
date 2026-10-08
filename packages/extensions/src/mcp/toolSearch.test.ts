import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { McpToolInfo } from './types'
import { McpClient } from './client'
import { searchMcpTools } from './toolSearch'

const corpus = JSON.parse(readFileSync(new URL('./__fixtures__/toolSearch.json', import.meta.url), 'utf8')) as {
  tools: McpToolInfo[]
  queries: Array<{ query: string; expected: string | null; kind: string }>
}

describe('MCP lexical discovery corpus', () => {
  it.each(corpus.queries.filter(q => q.expected))('finds $kind candidate for $query', sample => {
    expect(searchMcpTools(corpus.tools, sample.query, 3)[0]?.name).toBe(sample.expected)
  })

  it.each(corpus.queries.filter(q => !q.expected && q.kind !== 'unsupported_intent_with_lexical_overlap'))('returns no substitute for $query', sample => {
    expect(searchMcpTools(corpus.tools, sample.query)).toEqual([])
  })

  it('records lexical overlap as an unresolved semantic limitation', () => {
    // The catalog has create_event, not a cost calculator. Retrieval returns a
    // candidate; Engine output must instruct the model to verify its semantics.
    expect(searchMcpTools(corpus.tools, 'calculate calendar cost')[0]?.name).toBe('calendar__create_event')
    expect(searchMcpTools(corpus.tools, '请查一下我的日程')[0]?.name).toBe('calendar__create_event')
  })

  it('is stable under registration reorder and bounds finite or invalid top-k', () => {
    const reversed = [...corpus.tools].reverse()
    const expected = searchMcpTools(corpus.tools, 'search', 3).map(t => t.name)
    expect(searchMcpTools(reversed, 'search', 3).map(t => t.name)).toEqual(expected)
    expect(searchMcpTools(corpus.tools, 'search', -1)).toHaveLength(1)
    expect(searchMcpTools(corpus.tools, 'search', Number.NaN)).toEqual(searchMcpTools(corpus.tools, 'search', 8))
    expect(searchMcpTools(corpus.tools, 'please you my me')).toEqual([])
  })

  it('filters policy before top-k so denied tools cannot hide an allowed match', () => {
    const client = new McpClient()
    for (const tool of corpus.tools) {
      client.registerLocalServer({ name: tool.name.replaceAll('__', '-'), tools: [{ ...tool, name: 'match' }], handler: async () => 'fixture' })
    }
    const allowed = 'repo-search_code__match'
    expect(client.searchTools('search', 1, { allowedNames: new Set([allowed]) }).map(t => t.name)).toEqual([allowed])
    expect(client.searchTools('search', 20, { allowedNames: new Set() })).toEqual([])
  })
})
