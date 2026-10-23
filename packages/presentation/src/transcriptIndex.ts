import type { AgentTurn, ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import { toolInvocationKey } from '@fluxos/contracts/toolResultData'
import type { WorkProjectionSnapshot } from './workProjection'

/** Index once when data arrives, never scan the full transcript for each rendered node. */
export class TranscriptIndex {
  readonly turns = new Map<string, AgentTurn>()
  readonly calls = new Map<string, ToolCall>()
  readonly results = new Map<string, ToolResult>()
  private readonly versions = new Map<string, { value: unknown; revision: number }>()
  private revision = 0

  setTurn(turn: AgentTurn): void {
    this.turns.set(turn.id, turn)
    this.record(`turn:${turn.id}`, turn)
    for (const call of turn.toolCalls || []) this.setCall(call)
    for (const result of turn.toolResults || []) this.setResult(result)
  }

  setCall(call: ToolCall): void {
    const key = toolInvocationKey(call.id, call.operationIdentity)
    this.calls.set(key, call)
    this.record(`call:${key}`, call)
  }

  setResult(result: ToolResult): void {
    const key = toolInvocationKey(result.toolCallId, result.operationIdentity)
    this.results.set(key, result)
    this.record(`result:${key}`, result)
  }

  setWorkProjection(projection: Pick<WorkProjectionSnapshot, 'nodes'>): void {
    // Tool facts can belong to a run without belonging to an assistant turn.
    for (const node of Object.values(projection.nodes)) {
      if (node.toolCall) this.setCall(node.toolCall)
      if (node.toolResult) this.setResult(node.toolResult)
    }
  }

  turnVersion(id: string): number { return this.versions.get(`turn:${id}`)?.revision || 0 }

  toolVersion(id: string): number {
    return Math.max(this.versions.get(`call:${id}`)?.revision || 0, this.versions.get(`result:${id}`)?.revision || 0)
  }

  reset(turns: readonly AgentTurn[] = []): void {
    this.turns.clear()
    this.calls.clear()
    this.results.clear()
    this.versions.clear()
    for (const turn of turns) this.setTurn(turn)
  }

  private record(key: string, value: unknown): void {
    const previous = this.versions.get(key)
    const snapshot = captureValue(value, previous?.value)
    if (previous && snapshot === previous.value) return
    this.versions.set(key, { value: snapshot, revision: ++this.revision })
  }
}

/** Capture mutable event payloads without duplicating their potentially multi-MB
 * strings into serialized version keys. Equal subtrees reuse their prior value;
 * comparing a new IPC object and detecting an in-place correction both work.
 */
function captureValue(value: unknown, previous: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const before = Array.isArray(previous) ? previous : undefined
    let equal = before?.length === value.length
    const copy = value.map((item, index) => {
      const captured = captureValue(item, before?.[index])
      if (!Object.is(captured, before?.[index])) equal = false
      return captured
    })
    return equal ? before : copy
  }
  const current = value as Record<string, unknown>
  const before = previous && typeof previous === 'object' && !Array.isArray(previous)
    ? previous as Record<string, unknown> : undefined
  const keys = Object.keys(current)
  let equal = Boolean(before && Object.keys(before).length === keys.length)
  const copy: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    copy[key] = captureValue(current[key], before?.[key])
    if (!before || !Object.hasOwn(before, key) || !Object.is(copy[key], before[key])) equal = false
  }
  return equal ? before : copy
}
