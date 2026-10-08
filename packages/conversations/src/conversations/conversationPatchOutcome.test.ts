import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnyConversationEvent } from '@fluxos/contracts/conversationEvent'
import type { ToolResult } from '@fluxos/contracts/agentTypes'
import type { PatchReceipt } from '@fluxos/contracts/toolResultData'
import { ConversationRuntimeRepositoryV2 } from './conversationRuntimeRepositoryV2'

describe('canonical patch effect receipts', () => {
  it.each(['partial', 'unknown'] as const)('reopens %s and retains every effect and the failure stage', status => {
    const root = mkdtempSync(join(tmpdir(), 'fluxagent-patch-journal-'))
    const repository = () => new ConversationRuntimeRepositoryV2(root, 'profile', 'workspace', root)
    const context = { id: 'conversation', title: 'Patch', createdAt: 1, updatedAt: 10, mode: 'vibe' as const, provider: 'custom', model: 'fixture' }
    const repo = repository()
    let seq = 0
    const append = (type: AnyConversationEvent['type'], payload: unknown) => repo.appendCanonical({
      schemaVersion: 1, eventId: `event-${++seq}`, conversationId: context.id, threadId: context.id,
      runId: 'run', turnId: 'turn', seq, at: seq, source: 'agent', provenance: 'live', type, payload,
    } as AnyConversationEvent, context)
    const effect = (name: string, operationIndex: number) => ({ operationIndex, path: join(root, name), displayPath: name, action: 'write' as const })
    const data: PatchReceipt = { kind: 'patch', status, committed: status === 'partial' ? [effect('first', 0)] : [], pending: [effect('third', 2)], unknown: [effect('second', 1)], failure: { stage: 'write', operationIndex: 1, path: join(root, 'second'), message: 'fixture acknowledgement lost' } }
    const result: ToolResult = { toolCallId: 'patch', name: 'apply_patch', output: `Patch status: ${status}`, isError: true, errorKind: 'execution', data }
    try {
      append('run.started', { objective: 'Apply changes' })
      append('turn.started', { turn: { id: 'turn', role: 'assistant', content: '', timestamp: 1 } })
      append('tool.proposed', { toolCall: { id: 'patch', name: 'apply_patch', arguments: { patch: 'fixture' } } })
      append('tool.completed', { toolResult: result })
      const loaded = repository().load(context.id)!
      const restored = loaded.turns.flatMap(turn => turn.toolResults ?? [])
      expect(restored).toHaveLength(1)
      const restoredCall = loaded.turns.flatMap(turn => turn.toolCalls ?? [])[0]!
      // Canonical replay normalizes external call ids; the result must bind to
      // that same restored call while retaining the complete receipt.
      expect(restored[0]).toMatchObject({ ...result, toolCallId: restoredCall.id })
      const activities = Object.values(loaded.workExecution!.runs[0]!.activities)
      expect(activities.find(activity => activity.kind === 'tool')?.status).toBe('failed')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
