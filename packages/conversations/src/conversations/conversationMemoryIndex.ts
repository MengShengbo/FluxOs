import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from '@fluxos/platform/fileIO'
import type { MemoryHistoryHit, MemoryHistorySource } from '@fluxos/contracts/memoryTypes'
import { ConversationRepositoryV2 } from './conversationRepositoryV2'
import { conversationJournalVersion } from './conversationJournalIndex'
import { redactRecoveryValue } from './recoveryExport'
import type { ConversationRecordV2 } from './conversationV2Types'

const CHUNK = 1600
const STRIDE = 1400
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function terms(text: string): string[] {
  const canonical = text.normalize('NFKC')
  const normalized = canonical.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  const fullIdentifiers = [...canonical.toLowerCase().matchAll(/[a-z0-9_]+/g)].map(([word]) => word)
  return [...new Set([...fullIdentifiers, ...[...normalized.matchAll(/[a-z0-9_]+|[\u4e00-\u9fff]+/g)].flatMap(([word]) =>
    /[\u4e00-\u9fff]/.test(word) && word.length > 1
      ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word])])]
}

/** Rebuildable message-level index. Journals and their current projections remain authoritative. */
export class ConversationMemoryIndex implements MemoryHistorySource {
  private shards = new Map<string, { version: string; hits: MemoryHistoryHit[] }>()
  private postings = new Map<string, Set<string>>()
  private documents = new Map<string, MemoryHistoryHit>()
  private signature = ''
  constructor(private readonly repository: ConversationRepositoryV2, private readonly root: string, private readonly workspaceId: string) {}

  private records(): ConversationRecordV2[] {
    const records: ConversationRecordV2[] = []
    let cursor: string | undefined
    do {
      const page = this.repository.list({ limit: 200, cursor })
      records.push(...page.conversations.filter(record => record.status !== 'archived'))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return records
  }

  private materialize(record: ConversationRecordV2): MemoryHistoryHit[] {
    const projection = this.repository.projection(record.id)
    const result: MemoryHistoryHit[] = []
    for (const item of projection.items) {
      if (item.status === 'redacted' || item.status === 'running' || item.status === 'pending') continue
      const original = item.kind === 'user_message' || item.kind === 'assistant_message' ? item.payload.text
        : item.kind === 'tool_result' ? `${item.payload.toolName}\n${item.payload.output}` : ''
      if (!original) continue
      const text = String(redactRecoveryValue(original))
      const digest = hash(original)
      for (let offset = 0; offset < text.length; offset += STRIDE) {
        result.push({ id: hash(`${record.id}:${item.id}:${offset}`), conversationId: record.id,
          messageId: item.id, workspaceId: record.workspaceId, title: String(redactRecoveryValue(record.title)),
          kind: item.kind === 'user_message' ? 'user' : item.kind === 'assistant_message' ? 'assistant' : 'tool',
          text: text.slice(offset, offset + CHUNK), offset, digest, updatedAt: item.updatedAt, score: 0 })
        if (offset + CHUNK >= text.length) break
      }
    }
    return result
  }

  private removeShard(id: string): void {
    for (const hit of this.shards.get(id)?.hits ?? []) {
      this.documents.delete(hit.id)
      for (const term of new Set(terms(`${hit.title} ${hit.text}`))) {
        const posting = this.postings.get(term)
        posting?.delete(hit.id)
        if (!posting?.size) this.postings.delete(term)
      }
    }
    this.shards.delete(id)
  }
  private addShard(id: string, version: string, hits: MemoryHistoryHit[]): void {
    this.removeShard(id)
    this.shards.set(id, { version, hits })
    for (const hit of hits) {
      this.documents.set(hit.id, hit)
      for (const term of new Set(terms(`${hit.title} ${hit.text}`))) {
        const posting = this.postings.get(term) ?? new Set<string>()
        posting.add(hit.id)
        this.postings.set(term, posting)
      }
    }
  }

  private refresh(): void {
    const records = this.records()
    const signature = hash(JSON.stringify(records.map(r => [r.id, r.lastEventSeq, r.updatedAt, r.status, conversationJournalVersion(join(this.repository.eventsRoot, `${r.id}.jsonl`))])))
    if (signature === this.signature) return
    mkdirSync(this.root, { recursive: true })
    const present = new Set(records.map(record => record.id))
    const allowedFiles = new Set(records.map(record => `${hash(record.id)}.json`))
    for (const file of readdirSync(this.root)) if (/^[a-f0-9]{64}\.json$/.test(file) && !allowedFiles.has(file)) rmSync(join(this.root, file))
    for (const id of this.shards.keys()) if (!present.has(id)) this.removeShard(id)
    for (const record of records) {
      const version = `${record.lastEventSeq}:${record.updatedAt}:${record.title}:${conversationJournalVersion(join(this.repository.eventsRoot, `${record.id}.jsonl`))}`
      if (this.shards.get(record.id)?.version === version) continue
      const file = join(this.root, `${hash(record.id)}.json`)
      let hits: MemoryHistoryHit[] | undefined
      try {
        const cached = JSON.parse(readFileSync(file, 'utf8'))
        if (cached.schemaVersion === 1 && cached.version === version && Array.isArray(cached.hits)
          && cached.checksum === hash(JSON.stringify(cached.hits))) hits = cached.hits
      } catch { /* A missing or damaged derived shard is rebuilt from its journal. */ }
      if (!hits) {
        hits = this.materialize(record)
        writeFileAtomicSync(file, JSON.stringify({ schemaVersion: 1, version, hits, checksum: hash(JSON.stringify(hits)) }), 0o600)
      }
      this.addShard(record.id, version, hits)
    }
    this.signature = signature
  }

  search(request: Parameters<MemoryHistorySource['search']>[0]): MemoryHistoryHit[] {
    this.refresh()
    const query = request.query.trim().normalize('NFKC').toLowerCase()
    if (!query) return []
    if ((request.from !== undefined && !Number.isFinite(request.from)) || (request.to !== undefined && !Number.isFinite(request.to))
      || (request.from !== undefined && request.to !== undefined && request.from > request.to)) throw new Error('Invalid history time range')
    const queryTerms = [...new Set(terms(request.query))].slice(0, 500)
    const candidates = new Set<string>()
    for (const term of queryTerms) for (const id of this.postings.get(term) ?? []) candidates.add(id)
    if (/^[\u4e00-\u9fff]$/.test(query)) for (const [id, doc] of this.documents) if (`${doc.title} ${doc.text}`.normalize('NFKC').includes(query)) candidates.add(id)
    const scored = [...candidates].map(id => this.documents.get(id)!).filter(hit =>
      (request.acrossProjects || hit.workspaceId === this.workspaceId)
      && (request.from === undefined || hit.updatedAt >= request.from) && (request.to === undefined || hit.updatedAt <= request.to))
      .map(hit => {
        const tokens = new Set(terms(`${hit.title} ${hit.text}`))
        const matched = queryTerms.filter(term => tokens.has(term))
        const coverage = matched.length / Math.max(1, queryTerms.length)
        const idf = matched.reduce((sum, term) => sum + Math.log(1 + this.documents.size / (1 + (this.postings.get(term)?.size ?? 0))), 0)
        const exact = hit.text.normalize('NFKC').toLowerCase().includes(query) ? 3 : 0
        return { ...hit, score: exact + coverage * 4 + idf / Math.sqrt(Math.max(1, tokens.size)) }
      })
    return scored.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .slice(0, Math.min(100, Math.max(1, request.limit || 10)))
  }

  validate(refs: Parameters<NonNullable<MemoryHistorySource['validate']>>[0]): boolean[] {
    this.refresh()
    return refs.map(ref => {
      if (!ref.conversationId || !ref.messageId || !ref.digest) return false
      const hit = this.documents.get(hash(`${ref.conversationId}:${ref.messageId}:${ref.offset ?? 0}`))
      return Boolean(hit && hit.digest === ref.digest)
    })
  }

  read(request: Parameters<MemoryHistorySource['read']>[0]): MemoryHistoryHit | undefined {
    const projection = this.repository.projection(request.conversationId)
    const record = projection.conversation
    if (!record || record.status === 'archived' || (!request.acrossProjects && record.workspaceId !== this.workspaceId)) return undefined
    return this.materialize(record).find(hit => hit.messageId === request.messageId && hit.offset === request.offset)
  }

  pending(checkpoints: Record<string, string>, maxCharacters: number, excludedMessages: string[] = []): MemoryHistoryHit[] {
    this.refresh()
    const pending = [...this.documents.values()].filter(hit => hit.workspaceId === this.workspaceId && hit.kind !== 'tool'
      && !excludedMessages.includes(`${hit.conversationId}:${hit.messageId}`) && checkpoints[hit.id] !== hit.digest).sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
    const batch: MemoryHistoryHit[] = []
    let size = 0
    for (const hit of pending) {
      // Account for metadata and JSON escaping too, rather than just message lengths.
      const cost = JSON.stringify(hit).length + 2
      if (size + cost > maxCharacters) break
      batch.push({ ...hit })
      size += cost
    }
    return batch
  }
}
