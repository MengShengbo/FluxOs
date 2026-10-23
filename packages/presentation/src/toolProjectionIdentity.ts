import { toolInvocationKey } from '@fluxos/contracts/toolResultData'
import type { ToolCall } from '@fluxos/contracts/agentTypes'

export interface ToolProjectionNode {
  kind: string
  callId?: string
  invocationId?: string
  runId?: string
  responseId?: string
  turnId?: string
  settled: boolean
}

type NodeBucket<Node> = Map<string, Node>

/** Explicitly owned by one mutable projection; never attached to public snapshots. */
export class ToolProjectionIndex<Node extends ToolProjectionNode> {
  private readonly nodes = new Map<string, Node>()
  private readonly invocations = new Map<string, NodeBucket<Node>>()
  private readonly provisional = new Map<string, NodeBucket<Node>>()
  private readonly provisionalRuns = new Map<string, NodeBucket<Node>>()
  private readonly provisionalResponses = new Map<string, NodeBucket<Node>>()
  private readonly provisionalScopes = new Map<string, NodeBucket<Node>>()
  private readonly boundScopes = new Map<string, NodeBucket<Node>>()

  upsert(key: string, node: Node): void {
    const previous = this.nodes.get(key)
    if (node.kind !== 'tool' || !node.callId) return
    this.nodes.set(key, node)
    this.update(this.invocations, previous?.invocationId ? JSON.stringify([previous.callId, previous.invocationId]) : undefined,
      node.invocationId ? JSON.stringify([node.callId, node.invocationId]) : undefined, key, node)
    const raw = !node.invocationId || node.invocationId === node.callId
    const previousRaw = previous && (!previous.invocationId || previous.invocationId === previous.callId)
    this.update(this.provisional, previousRaw ? previous.callId : undefined, raw ? node.callId : undefined, key, node)
    this.update(this.provisionalRuns, previousRaw ? JSON.stringify([previous.callId, previous.runId]) : undefined,
      raw ? JSON.stringify([node.callId, node.runId]) : undefined, key, node)
    this.update(this.provisionalResponses, previousRaw ? JSON.stringify([previous.callId, previous.responseId]) : undefined,
      raw ? JSON.stringify([node.callId, node.responseId]) : undefined, key, node)
    const scope = JSON.stringify([node.callId, node.runId, node.responseId])
    const previousScope = previous ? JSON.stringify([previous.callId, previous.runId, previous.responseId]) : undefined
    this.update(this.provisionalScopes, previousRaw ? previousScope : undefined, raw ? scope : undefined, key, node)
    this.update(this.boundScopes, previous && !previousRaw ? previousScope : undefined, !raw ? scope : undefined, key, node)
  }

  matching(callId: string, identity: ToolCall['operationIdentity'], runId?: string, responseId?: string): [string, Node] | undefined {
    if (identity) {
      const exact = this.invocations.get(JSON.stringify([callId, toolInvocationKey(callId, identity)]))?.entries().next().value
      if (exact) return exact
    }
    const candidates = identity || runId !== undefined && responseId !== undefined
      ? this.provisionalScopes.get(JSON.stringify([callId, runId, responseId]))
      : runId !== undefined ? this.provisionalRuns.get(JSON.stringify([callId, runId]))
        : responseId !== undefined ? this.provisionalResponses.get(JSON.stringify([callId, responseId]))
          : this.provisional.get(callId)
    let match: [string, Node] | undefined
    if (candidates) for (const entry of candidates) {
      const node = entry[1]
      if (identity && (node.settled || node.turnId && node.turnId !== identity.turnId)) continue
      if (match) return undefined
      match = entry
    }
    return match
  }

  hasBound(callId: string, runId?: string, responseId?: string): boolean {
    return Boolean(this.boundScopes.get(JSON.stringify([callId, runId, responseId]))?.size)
  }

  clear(): void {
    this.nodes.clear()
    this.invocations.clear()
    this.provisional.clear()
    this.provisionalRuns.clear()
    this.provisionalResponses.clear()
    this.provisionalScopes.clear()
    this.boundScopes.clear()
  }

  private update(buckets: Map<string, NodeBucket<Node>>, previous: string | undefined, next: string | undefined, key: string, node: Node): void {
    if (previous !== undefined && previous !== next) {
      const bucket = buckets.get(previous)
      bucket?.delete(key)
      if (bucket?.size === 0) buckets.delete(previous)
    }
    if (next !== undefined) {
      let bucket = buckets.get(next)
      if (!bucket) buckets.set(next, bucket = new Map())
      bucket.set(key, node)
    }
  }
}

/** Execution identity may become known after a display slot has already streamed. */
export function matchingToolProjectionNode<Node extends ToolProjectionNode>(
  nodes: Readonly<Record<string, Node>>,
  callId: string,
  identity: ToolCall['operationIdentity'],
  runId?: string,
  responseId?: string,
): [string, Node] | undefined {
  const entries = Object.entries(nodes).filter(([, node]) => node.kind === 'tool' && node.callId === callId)
  if (identity) {
    const invocation = toolInvocationKey(callId, identity)
    const exact = entries.find(([, node]) => node.invocationId === invocation)
    if (exact) return exact
  }
  // A result with only a raw ID can attach only to one unbound candidate;
  // scoped operations never fall back to another turn's bound invocation.
  const candidates = entries.filter(([, node]) => (
    (!node.invocationId || node.invocationId === callId)
    && (identity || runId !== undefined ? node.runId === runId : true)
    && (identity || responseId !== undefined ? node.responseId === responseId : true)
    && (!identity || !node.settled && (!node.turnId || node.turnId === identity.turnId))
  ))
  return candidates.length === 1 ? candidates[0] : undefined
}

/** Reused raw provider IDs must not overwrite an earlier invocation's display slot. */
export function newToolProjectionKey(
  nodes: Readonly<Record<string, unknown>>,
  callId: string,
  identity: ToolCall['operationIdentity'],
  runId: string | undefined,
  responseId: string | undefined,
  seq: number,
): string {
  const key = `tool:${toolInvocationKey(callId, identity)}`
  return nodes[key] ? `tool:stream:${JSON.stringify([runId, responseId, callId, seq])}` : key
}
