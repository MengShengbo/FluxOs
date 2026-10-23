import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationMemoryIndex } from './conversationMemoryIndex'
import { ConversationRepositoryV2 } from './conversationRepositoryV2'
import type { AnyAppendConversationEventV2Input, ConversationRecordV2 } from './conversationV2Types'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'flux-memory-index-')); roots.push(root)
  const repo = new ConversationRepositoryV2(join(root, 'conversations'))
  return { repo, root, index: new ConversationMemoryIndex(repo, join(root, 'index'), 'a') }
}
function add(repo: ConversationRepositoryV2, id: string, workspaceId: string, text: string, title = `Task ${id}`) {
  const record: ConversationRecordV2 = { schemaVersion: 2, id, profileId: 'p', workspaceId, title, titleSource: 'custom', mode: 'vibe', provider: 'openai', model: 'test', status: 'idle', createdAt: 1, updatedAt: 1, lastEventSeq: 0, turnCount: 0, runCount: 0, tags: [] }
  repo.append([{ eventId: `${id}-created`, conversationId: id, profileId: 'p', workspaceId, source: 'user', provenance: 'live', at: 1, type: 'conversation.created', payload: { record } },
    { eventId: `${id}-message`, conversationId: id, profileId: 'p', workspaceId, source: 'user', provenance: 'live', at: 2, itemId: `${id}-item`, type: 'item.created', payload: { item: { schemaVersion: 1, id: `${id}-item`, conversationId: id, kind: 'user_message', status: 'completed', createdAt: 2, updatedAt: 2, payload: { text, attachmentIds: [] } } } }])
}
function redact(repo: ConversationRepositoryV2, id: string): void {
  repo.append([{ eventId: `${id}-redact`, conversationId: id, profileId: 'p', workspaceId: 'a', source: 'user', provenance: 'live', at: 3, itemId: `${id}-item`, type: 'item.redacted', payload: { reason: 'forgotten', redactedAt: 3 } }])
}
describe('conversation memory index', () => {
  it.each(['readProjectTaskHistory', 'readprojecttaskhistory', 'READPROJECTTASKHISTORY'])('finds full identifiers independently of query casing: %s', query => {
    const { repo, index } = setup()
    add(repo, 'identifier', 'a', 'The failing entry point is readProjectTaskHistory.')
    expect(index.search({ query, acrossProjects: false, limit: 5 }).map(hit => hit.conversationId)).toEqual(['identifier'])
  })

  it('finds a single Chinese character present only in a conversation title', () => {
    const { repo, index } = setup()
    add(repo, 'login', 'a', 'Authentication work details', '修复登录')
    expect(index.search({ query: '登', acrossProjects: false, limit: 5 }).map(hit => hit.conversationId)).toEqual(['login'])
  })

  it('finds late exact details, Chinese and identifiers without indexing a truncated preview', () => {
    const { repo, index } = setup()
    add(repo, 'long', 'a', '普通背景文字'.repeat(2000) + '\n最终部署端口为 43891，服务入口 runtimeHost。')
    const hit = index.search({ query: '部署 43891', acrossProjects: false, limit: 5 })[0]
    expect(hit.text).toContain('43891'); expect(hit.offset).toBeGreaterThan(1000)
    expect(index.read({ conversationId: hit.conversationId, messageId: hit.messageId, offset: hit.offset, acrossProjects: false })).toEqual({ ...hit, score: 0 })
    expect(index.search({ query: 'Host', acrossProjects: false, limit: 1 })[0].text).toContain('runtimeHost')
  })
  it('does not copy common credential forms into recall shards or model input', () => {
    const { repo, index, root } = setup()
    add(repo, 'secret', 'a', '部署使用 API_KEY=sk-testabcdefghijklmnopqrst；端口 43891')
    const hits = index.search({ query: '43891', acrossProjects: false, limit: 5 })
    expect(hits[0].text).toContain('[REDACTED]')
    expect(JSON.stringify(index.pending({}, 24000))).not.toContain('sk-testabcdefghijklmnopqrst')
    for (const file of readdirSync(join(root, 'index'))) expect(readFileSync(join(root, 'index', file), 'utf8')).not.toContain('sk-testabcdefghijklmnopqrst')
  })
  it('enforces project boundaries for search, read and background batches', () => {
    const { repo, index } = setup(); add(repo, 'one', 'a', '隔离部署 5000'); add(repo, 'two', 'b', '隔离部署 6000')
    expect(index.search({ query: '隔离部署', acrossProjects: false, limit: 10 }).map(h => h.conversationId)).toEqual(['one'])
    expect(index.search({ query: '隔离部署', acrossProjects: true, limit: 10 })).toHaveLength(2)
    expect(index.read({ conversationId: 'two', messageId: 'two-item', offset: 0, acrossProjects: false })).toBeUndefined()
    expect(index.pending({}, 24000).map(h => h.conversationId)).toEqual(['one'])
  })
  it('invalidates deleted or edited evidence and replaces stale derived shards', () => {
    const { repo, index, root } = setup(); add(repo, 'one', 'a', '保密细节 48765')
    const [hit] = index.search({ query: '48765', acrossProjects: false, limit: 1 })
    redact(repo, 'one')
    expect(index.search({ query: '48765', acrossProjects: true, limit: 1 })).toEqual([])
    expect(index.read({ conversationId: 'one', messageId: hit.messageId, offset: 0, acrossProjects: true })).toBeUndefined()
    for (const file of readdirSync(join(root, 'index'))) expect(readFileSync(join(root, 'index', file), 'utf8')).not.toContain('48765')
  })
  it('detects physical journal privacy rewrites even when sequence and timestamps are unchanged', () => {
    const { repo, index } = setup(); add(repo, 'one', 'a', '隐私信息 old-43891')
    const [hit] = index.search({ query: 'old-43891', acrossProjects: false, limit: 1 })
    const file = join(repo.eventsRoot, 'one.jsonl')
    writeFileSync(file, readFileSync(file, 'utf8').replace('old-43891', 'redacted!'))
    expect(index.search({ query: 'old-43891', acrossProjects: false, limit: 1 })).toEqual([])
    expect(index.validate([{ kind: 'conversation', conversationId: hit.conversationId, messageId: hit.messageId, offset: hit.offset, digest: hit.digest }])).toEqual([false])
  })
  it('recovers corrupt derived shards and skips suppressed messages before budgeting', () => {
    const { repo, index, root } = setup(); add(repo, 'one', 'a', '大段历史'.repeat(1800)); add(repo, 'two', 'a', '后来的关键点')
    index.search({ query: '关键点', acrossProjects: false, limit: 5 })
    for (const file of readdirSync(join(root, 'index'))) writeFileSync(join(root, 'index', file), '{broken')
    const reopened = new ConversationMemoryIndex(repo, join(root, 'index'), 'a')
    expect(reopened.search({ query: '关键点', acrossProjects: false, limit: 5 })[0].conversationId).toBe('two')
    expect(reopened.pending({}, 2500, ['one:one-item']).map(hit => hit.conversationId)).toEqual(['two'])
  })
  it('paginates beyond 200 conversations and reuses unchanged shard projections', () => {
    const { repo, index } = setup()
    for (let i = 0; i < 205; i++) add(repo, `conv-${i}`, 'a', `历史特征编号${i}`)
    const projection = vi.spyOn(repo, 'projection')
    expect(index.search({ query: '历史特征编号0', acrossProjects: false, limit: 1 })[0].text).toBe('历史特征编号0')
    const count = projection.mock.calls.length
    index.search({ query: '历史特征编号204', acrossProjects: false, limit: 1 })
    expect(projection).toHaveBeenCalledTimes(count)
  }, 15000)
})
