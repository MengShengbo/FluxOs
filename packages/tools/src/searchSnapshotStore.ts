import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Result, SearchIncompleteReason, SearchSnapshot } from '@fluxos/contracts/toolExecutor'

export class SearchError extends Error {
  constructor(message: string, readonly kind: 'validation' | 'environment' | 'abort' | 'execution') { super(message) }
}

export function searchFailure(error: unknown): Result<never> {
  return { success: false, error: error instanceof Error ? error.message : String(error),
    errorKind: error instanceof SearchError ? error.kind : 'execution' }
}

interface StoredCapture {
  key: string
  records: string[]
  displaySizes: number[]
  bytes: number
  total: number
  reasons: SearchIncompleteReason[]
  snapshot: SearchSnapshot
}
type PageOptions = { cursor?: string; offset?: number; limit?: number; signal?: AbortSignal }

export interface SearchCacheLimits {
  maxEntries?: number
  maxEntryBytes?: number
  maxTotalBytes?: number
  ttlMs?: number
  now?: () => number
}

/** Per-executor, bounded, immutable records. Returned objects never alias the cache. */
export class SearchSnapshotStore {
  private readonly secret = randomBytes(32)
  private readonly captures = new Map<string, StoredCapture>()
  private bytes = 0
  private readonly now: () => number
  private readonly maxEntries: number
  private readonly maxEntryBytes: number
  private readonly maxTotalBytes: number
  private readonly ttlMs: number

  constructor(limits: SearchCacheLimits = {}) {
    this.now = limits.now ?? Date.now
    const bound = (value: number | undefined, cap: number) => Number.isFinite(value) ? Math.max(1, Math.min(cap, Math.floor(value!))) : cap
    this.maxEntries = bound(limits.maxEntries, 8)
    this.maxTotalBytes = bound(limits.maxTotalBytes, 32 * 1024 * 1024)
    this.maxEntryBytes = Math.min(bound(limits.maxEntryBytes, 8 * 1024 * 1024), this.maxTotalBytes)
    this.ttlMs = bound(limits.ttlMs, 5 * 60_000)
  }

  private remove(id: string): void {
    const capture = this.captures.get(id)
    if (capture) { this.bytes -= capture.bytes; this.captures.delete(id) }
  }

  private expire(): void {
    for (const [id, capture] of this.captures) if (Date.parse(capture.snapshot.expiresAt) <= this.now()) this.remove(id)
  }

  private signature(payload: string): string { return createHmac('sha256', this.secret).update(payload).digest('hex') }
  private cursor(id: string, offset: number): string { const payload = `${id}.${offset}`; return `${payload}.${this.signature(payload)}` }

  private validate(options: PageOptions): void {
    if (options.signal?.aborted) throw new SearchError('Search cancelled', 'abort')
    if (options.cursor !== undefined && options.offset !== undefined) throw new SearchError('cursor and offset are mutually exclusive; omit offset when continuing', 'validation')
    if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) throw new SearchError('offset must be a nonnegative safe integer', 'validation')
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 500)) throw new SearchError('limit must be an integer from 1 to 500', 'validation')
  }

  /** Validate before spawning, even for a fresh query. */
  validateRequest(options: PageOptions): void { this.validate(options) }

  continue<T>(key: string, options: PageOptions) {
    this.validate(options)
    this.expire()
    if (typeof options.cursor !== 'string' || options.cursor.length > 200) throw new SearchError('Invalid search cursor', 'validation')
    const match = /^([\da-f-]{36})\.(\d+)\.([\da-f]{64})$/.exec(options.cursor)
    if (!match) throw new SearchError('Invalid search cursor', 'validation')
    const [, id, rawOffset, signature] = match
    const expected = this.signature(`${id}.${rawOffset}`)
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) throw new SearchError('Search cursor is invalid or belongs to another executor', 'validation')
    const capture = this.captures.get(id)
    if (!capture) throw new SearchError('Search capture expired or was evicted; start a new search without cursor', 'environment')
    if (capture.key !== key) throw new SearchError('Search cursor query, scope or options do not match the capture', 'validation')
    const offset = Number(rawOffset)
    if (!Number.isSafeInteger(offset) || offset >= capture.records.length) throw new SearchError('Invalid search cursor offset', 'validation')
    return this.page<T>(capture, offset, options.limit)
  }

  start<T, U>(key: string, items: T[], project: (item: T) => U, reasons: SearchIncompleteReason[], capturedAt: number, options: PageOptions, displaySize?: (item: U) => number) {
    this.validate(options)
    this.expire()
    const records: string[] = []
    const displaySizes: number[] = []
    // Budget includes UTF-16 storage and conservative per-record/key bookkeeping.
    let bytes = key.length * 2 + 512
    const incomplete = [...reasons]
    for (const item of items) {
      const projected = project(item)
      const record = JSON.stringify(projected)
      const cost = record.length * 2 + 64
      if (bytes + cost > this.maxEntryBytes) { incomplete.push('result_budget'); break }
      records.push(record); displaySizes.push(displaySize ? displaySize(projected) : record.length); bytes += cost
    }
    if (bytes > this.maxEntryBytes) throw new SearchError('Search query exceeds the capture cache budget; narrow the query', 'validation')
    const createdAt = this.now()
    const snapshot: SearchSnapshot = { id: randomUUID(), capturedAt: new Date(capturedAt).toISOString(),
      expiresAt: new Date(createdAt + this.ttlMs).toISOString(), consistency: 'captured_results' }
    const capture: StoredCapture = { key, records, displaySizes, bytes, total: items.length, reasons: [...new Set(incomplete)], snapshot }
    while (this.captures.size >= this.maxEntries || this.bytes + bytes > this.maxTotalBytes) this.remove(this.captures.keys().next().value!)
    this.captures.set(snapshot.id, capture); this.bytes += bytes
    return this.page<U>(capture, options.offset ?? 0, options.limit)
  }

  private page<T>(capture: StoredCapture, offset: number, requestedLimit?: number) {
    const limit = requestedLimit ?? 50
    const selected: T[] = []
    let chars = 0
    for (let index = offset; index < Math.min(capture.records.length, offset + limit); index++) {
      // Cache storage includes duplicated UI context; page budgets measure rendered evidence.
      const size = capture.displaySizes[index]
      if (selected.length && chars + size > 24_000) break
      selected.push(JSON.parse(capture.records[index]) as T); chars += size
    }
    const next = offset + selected.length
    const more = next < capture.records.length
    const complete = capture.reasons.length === 0
    return { selected, offset, limit, totalMatches: capture.total, totalIsExact: complete,
      truncated: more || !complete,
      ...(more ? { nextOffset: next, nextCursor: this.cursor(capture.snapshot.id, next) } : {}),
      snapshot: { ...capture.snapshot }, incompleteReasons: [...capture.reasons],
      warning: `Captured results: changes after capture are not included. Start a new search without cursor to refresh.${complete ? '' : ` Search incomplete (${capture.reasons.join(', ')}); narrow the scope or query before drawing conclusions.`}` }
  }
}
