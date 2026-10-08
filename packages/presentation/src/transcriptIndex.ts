import type { AgentTurn, ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import { toolInvocationKey } from '@fluxos/contracts/toolResultData'
import type { WorkProjectionSnapshot } from './workProjection'

/** Index once when data arrives, never scan the full transcript for each rendered node. */
export class TranscriptIndex {
  readonly turns = new Map<string, AgentTurn>()
  readonly calls = new Map<string, ToolCall>()
  readonly results = new Map<string, ToolResult>()
  private readonly versions = new Map<string, { content: string; revision: number }>()
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
    const content = JSON.stringify(value)
    if (this.versions.get(key)?.content === content) return
    this.versions.set(key, { content, revision: ++this.revision })
  }
}
