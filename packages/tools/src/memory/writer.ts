/**
 * Append-only persistent store for agent-written workspace memories.
 *
 * Storage format: one JSON object per line in `.fluxagent/memory/facts.jsonl`.
 * Later lines with the same id override earlier ones when loaded.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import type {
  Memory,
  MemoryEvidence,
  MemoryWriteRequest,
  MemoryWriteResponse,
  MemoryForgetRequest,
  MemoryForgetResponse,
  MemoryUpdateRequest,
  MemoryUpdateResponse,
} from '@fluxos/contracts/memoryTypes'
import { sanitizeMemoryText } from './sanitizer'
import { withFileLockSync } from '@fluxos/platform/fileIO'

const DYNAMIC_STORE_SOFT_CAP = 500

export class MemoryWriter {
  private readonly workspaceIndex = new Map<string, Map<string, Memory>>()

  constructor(private readonly memoryRoot?: string) {}

  private factsPath(workspacePath: string): string {
    return path.join(this.memoryRoot ?? path.join(workspacePath, '.fluxagent', 'memory'), 'facts.jsonl')
  }

  private ensureDirForWrite(workspacePath: string): void {
    fs.mkdirSync(this.memoryRoot ?? path.join(workspacePath, '.fluxagent', 'memory'), { recursive: true })
  }

  private getIndex(workspacePath: string): Map<string, Memory> {
    let index = this.workspaceIndex.get(workspacePath)
    if (!index) {
      index = new Map()
      this.workspaceIndex.set(workspacePath, index)
    }
    return index
  }

  private loadIndex(workspacePath: string): void {
    const index = this.getIndex(workspacePath)
    index.clear()
    try {
      const content = fs.readFileSync(this.factsPath(workspacePath), 'utf-8')
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue
        try {
          const parsed = JSON.parse(trimmed) as Memory
          if (parsed.id && parsed.text) {
            index.set(parsed.id, parsed)
          }
        } catch {
          // Skip malformed lines; one bad append should not hide valid memories.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private withLatestIndex<T>(workspacePath: string, action: () => T): T {
    this.ensureDirForWrite(workspacePath)
    const directory = fs.realpathSync.native(path.dirname(this.factsPath(workspacePath)))
    return withFileLockSync(path.join(directory, 'facts.jsonl.lock'), () => {
      this.loadIndex(workspacePath)
      return action()
    })
  }

  private findDuplicate(text: string, workspacePath: string, kind: Memory['kind'], scope: Memory['scope']): string | null {
    const index = this.getIndex(workspacePath)
    for (const [id, existing] of index) {
      if (existing.status === 'active' && existing.text === text && existing.kind === kind && existing.scope === scope) return id
    }
    return null
  }

  private appendLine(workspacePath: string, memory: Memory): void {
    this.ensureDirForWrite(workspacePath)
    const factsPath = this.factsPath(workspacePath)
    let separator = ''
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(factsPath, 'r')
      const size = fs.fstatSync(descriptor).size
      if (size > 0) {
        const last = Buffer.alloc(1)
        fs.readSync(descriptor, last, 0, 1, size - 1)
        if (last[0] !== 10) separator = '\n'
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
    // A partial append must stay on its own line so later durable writes survive.
    fs.appendFileSync(factsPath, `${separator}${JSON.stringify(memory)}\n`, 'utf-8')

    this.getIndex(workspacePath).set(memory.id, memory)
  }

  async remember(request: MemoryWriteRequest): Promise<MemoryWriteResponse> {
    return this.withLatestIndex(request.workspacePath, () => this.rememberCurrent(request))
  }

  private rememberCurrent(request: MemoryWriteRequest): MemoryWriteResponse {
    const { workspacePath, text, kind, scope, tags, evidence, confidence, conversationId, messageId } = request
    const sanitized = sanitizeMemoryText(text)
    if (!sanitized) {
      return { success: false, error: 'Memory text is empty after sanitization' }
    }

    const index = this.getIndex(workspacePath)
    const duplicateId = this.findDuplicate(sanitized, workspacePath, kind ?? 'fact', scope ?? 'workspace_private')
    if (duplicateId) {
      const existing = index.get(duplicateId)!
      const updated: Memory = {
        ...existing,
        text: sanitized,
        updatedAt: Date.now(),
        tags: Array.from(new Set([...(existing.tags || []), ...(tags || [])])).slice(0, 12),
      }
      this.appendLine(workspacePath, updated)
      return { success: true, id: duplicateId, deduplicated: true }
    }

    const activeCount = Array.from(index.values()).filter(m => m.status === 'active').length
    if (activeCount >= DYNAMIC_STORE_SOFT_CAP) {
      return { success: false, error: `Memory store has reached ${DYNAMIC_STORE_SOFT_CAP} active entries` }
    }

    const memEvidence: MemoryEvidence[] = evidence ? [...evidence] : []
    if (conversationId) memEvidence.push({ kind: 'conversation', conversationId, messageId })
    if (memEvidence.length === 0) memEvidence.push({ kind: 'tool_result', quote: 'agent:remember tool' })

    const now = Date.now()
    const memory: Memory = {
      id: `dyn_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      scope: scope ?? 'workspace_private',
      kind: kind ?? 'fact',
      text: sanitized,
      source: conversationId ? `conversation:${conversationId}` : 'agent:remember',
      evidence: memEvidence,
      confidence: confidence ?? 'observed',
      createdAt: now,
      updatedAt: now,
      pinned: false,
      tags: (tags ?? []).slice(0, 8),
      reviewState: 'auto',
      status: 'active',
    }

    this.appendLine(workspacePath, memory)
    return { success: true, id: memory.id }
  }

  async forget(request: MemoryForgetRequest): Promise<MemoryForgetResponse> {
    return this.withLatestIndex(request.workspacePath, () => this.forgetCurrent(request))
  }

  private forgetCurrent(request: MemoryForgetRequest): MemoryForgetResponse {
    const { workspacePath, id, reason } = request

    const existing = this.getIndex(workspacePath).get(id)
    if (!existing) return { success: false, error: `Memory not found: ${id}` }
    if (existing.status !== 'active') return { success: false, error: `Memory already ${existing.status}: ${id}` }

    const updated: Memory = {
      ...existing,
      status: 'rejected',
      updatedAt: Date.now(),
      tags: [...(existing.tags || []), reason ? `forget:${reason.slice(0, 30)}` : 'forget:manual'],
    }
    this.appendLine(workspacePath, updated)
    return { success: true }
  }

  async update(request: MemoryUpdateRequest): Promise<MemoryUpdateResponse> {
    return this.withLatestIndex(request.workspacePath, () => this.updateCurrent(request))
  }

  private updateCurrent(request: MemoryUpdateRequest): MemoryUpdateResponse {
    const { workspacePath, id, text, scope, kind, confidence, tags, pinned, reviewState, status } = request

    const existing = this.getIndex(workspacePath).get(id)
    if (!existing) return { success: false, error: `Memory not found: ${id}` }

    const updated: Memory = { ...existing, updatedAt: Date.now() }
    if (text !== undefined) {
      const sanitized = sanitizeMemoryText(text)
      if (!sanitized) return { success: false, error: 'Updated text is empty after sanitization' }
      updated.text = sanitized
    }
    if (scope !== undefined) updated.scope = scope
    if (kind !== undefined) updated.kind = kind
    if (confidence !== undefined) updated.confidence = confidence
    if (tags !== undefined) updated.tags = tags.slice(0, 12)
    if (pinned !== undefined) updated.pinned = pinned
    if (reviewState !== undefined) updated.reviewState = reviewState
    if (status !== undefined) updated.status = status

    this.appendLine(workspacePath, updated)
    return { success: true }
  }

  invalidate(workspacePath: string): void {
    this.workspaceIndex.delete(workspacePath)
  }
}
