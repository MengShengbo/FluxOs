import { randomUUID } from 'node:crypto'
import type { ToolCall, ToolOutputSource, ToolResult } from '@fluxos/contracts/agentTypes'

type StoredOutput = { text: string; call: ToolCall; scope: string; weight: number; source: ToolOutputSource }
export class ToolOutputReadError extends Error {
  constructor(readonly errorKind: NonNullable<ToolResult['errorKind']>, message: string) { super(message) }
}

/** Bounded in-memory evidence only; never re-executes or persists a source call. */
export class ToolOutputStore {
  private readonly entries = new Map<string, StoredOutput>()
  private chars = 0
  constructor(private readonly limits = { entries: 32, sourceChars: 1_000_000, totalChars: 4_000_000, ttlMs: 10 * 60_000 }) {
    if (!Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Output source budgets must be positive safe integers')
  }

  clear(): void { this.entries.clear(); this.chars = 0 }

  private remove(id: string): void {
    const entry = this.entries.get(id)
    if (entry) this.chars -= entry.weight
    this.entries.delete(id)
  }

  private expire(): void {
    const now = Date.now()
    for (const [id, entry] of this.entries) if (entry.source.expiresAt <= now) this.remove(id)
  }

  save(text: string, call: ToolCall, scope: string): ToolOutputSource | undefined {
    this.expire()
    const weight = text.length + JSON.stringify(call).length
    if (weight > this.limits.sourceChars || weight > this.limits.totalChars) return undefined
    while (this.entries.size >= this.limits.entries || this.chars + weight > this.limits.totalChars) this.remove(this.entries.keys().next().value!)
    const id = `output-${randomUUID()}`
    const source: ToolOutputSource = { id, toolName: call.name, totalChars: text.length, expiresAt: Date.now() + this.limits.ttlMs,
      unit: 'utf16', offset: 0, endOffset: 0, ...(text.length ? { nextOffset: 0 } : {}) }
    this.entries.set(id, { text, call: structuredClone(call), scope, weight, source }); this.chars += weight
    return { ...source }
  }

  read(id: string, offset: number, limit: number, scope: string, authorize: (call: ToolCall) => void): { output: string; outputSource: ToolOutputSource } {
    this.expire()
    const entry = this.entries.get(id)
    if (!entry || entry.scope !== scope) throw new ToolOutputReadError('environment', 'Output source expired, evicted or unavailable in this session; inspect current state before rerunning the source tool')
    authorize(structuredClone(entry.call))
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.text.length || !Number.isSafeInteger(limit) || limit < 2 || limit > 16_000) {
      throw new ToolOutputReadError('validation', 'Invalid source range: offset must be within the text and limit must be 2..16000 UTF-16 code units')
    }
    const isHigh = (index: number) => entry.text.charCodeAt(index) >= 0xd800 && entry.text.charCodeAt(index) <= 0xdbff
    const isLow = (index: number) => entry.text.charCodeAt(index) >= 0xdc00 && entry.text.charCodeAt(index) <= 0xdfff
    if (offset > 0 && isHigh(offset - 1) && isLow(offset)) throw new ToolOutputReadError('validation', 'Offset splits a character; use the returned nextOffset')
    let endOffset = Math.min(entry.text.length, offset + limit)
    if (isHigh(endOffset - 1) && isLow(endOffset)) endOffset -= 1
    return { output: entry.text.slice(offset, endOffset), outputSource: {
      ...entry.source, offset, endOffset, nextOffset: endOffset < entry.text.length ? endOffset : undefined,
    } }
  }
}
