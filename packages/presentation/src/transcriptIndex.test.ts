import { describe, expect, it } from 'vitest'
import type { AgentTurn, ToolResult } from '@fluxos/contracts/agentTypes'
import { TranscriptIndex } from './transcriptIndex'
import { WorkProjectionEngine } from './workProjection'
import type { AnyConversationEvent } from '@fluxos/contracts/conversationEvent'
import { toolInvocationKey } from '@fluxos/contracts/toolResultData'

describe('transcript content revisions', () => {
  it('restores run-scoped tool facts without assistant turns and keeps repeated call IDs separate', () => {
    const projection = new WorkProjectionEngine('conversation', 'conversation')
    let seq = 0
    for (const turnId of ['first', 'second']) {
      const operationIdentity = { sessionId: 'conversation', turnId, callId: 'repeated' }
      const call = { id: 'repeated', name: 'read_file', arguments: { path: `${turnId}.ts` }, operationIdentity }
      const result = { toolCallId: 'repeated', name: 'read_file', output: `contents of ${turnId}`, isError: false, operationIdentity }
      for (const event of [
        { type: 'tool.proposed', payload: { toolCall: call } },
        { type: 'tool.completed', payload: { toolResult: result } },
      ]) {
        projection.apply({ ...event, schemaVersion: 1, eventId: `event-${++seq}`, conversationId: 'conversation', threadId: 'conversation',
          runId: 'run', seq, at: seq, source: 'runtime', provenance: 'restored' } as AnyConversationEvent)
      }
    }
    const restored = structuredClone(projection.getSnapshot())
    const index = new TranscriptIndex()
    index.setWorkProjection(restored)
    expect(index.turns.size).toBe(0)
    expect(index.calls.size).toBe(2)
    expect(index.results.size).toBe(2)
    for (const turnId of ['first', 'second']) {
      const key = toolInvocationKey('repeated', { sessionId: 'conversation', turnId, callId: 'repeated' })
      expect(index.calls.get(key)?.arguments.path).toBe(`${turnId}.ts`)
      expect(index.results.get(key)?.output).toBe(`contents of ${turnId}`)
      expect(restored.nodes[`tool:${key}`]?.toolResult).toEqual(index.results.get(key))
    }
    const key = [...index.results.keys()][0]!
    const revision = index.toolVersion(key)
    index.setWorkProjection(restored)
    expect(index.toolVersion(key)).toBe(revision)
    index.reset()
    expect(index.calls.size + index.results.size).toBe(0)
  })
  it('detects same-length corrections, metadata changes and in-place mutations', () => {
    const index = new TranscriptIndex()
    const turn: AgentTurn = { id: 'turn', role: 'assistant', content: 'old', timestamp: 1 }
    index.setTurn(turn); const first = index.turnVersion(turn.id)
    index.setTurn({ ...turn }); expect(index.turnVersion(turn.id)).toBe(first)
    turn.content = 'new'; index.setTurn(turn); expect(index.turnVersion(turn.id)).toBeGreaterThan(first)
    const result: ToolResult = { toolCallId: 'call', output: 'old', isError: false }
    index.setResult(result); const tool = index.toolVersion('call')
    result.output = 'new'; index.setResult(result); expect(index.toolVersion('call')).toBeGreaterThan(tool)
  })
  it('indexes historical and live tools together and discards them on navigation', () => {
    const index = new TranscriptIndex()
    index.setTurn({ id: 'turn', role: 'assistant', content: '', timestamp: 1, toolCalls: [{ id: 'call', name: 'search', arguments: { query: 'first' } }] })
    index.setResult({ toolCallId: 'call', output: 'found', isError: false })
    expect(index.calls.get('call')?.name).toBe('search'); expect(index.results.get('call')?.output).toBe('found')
    index.reset(); expect(index.turns.size + index.calls.size + index.results.size).toBe(0)
  })

  it('separates repeated provider IDs by host operation identity and versions each result independently', () => {
    const index = new TranscriptIndex()
    for (const turnId of ['one', 'two']) {
      const operationIdentity = { sessionId: 'session', turnId, callId: 'provider-repeat' }
      index.setCall({ id: 'provider-repeat', name: 'write_file', arguments: { path: turnId }, operationIdentity })
      index.setResult({ toolCallId: 'provider-repeat', name: 'write_file', output: turnId, isError: false, operationIdentity })
    }
    expect(index.calls.size).toBe(2)
    expect(index.results.size).toBe(2)
    const [firstKey, secondKey] = [...index.results.keys()]
    const firstRevision = index.toolVersion(firstKey!)
    const secondRevision = index.toolVersion(secondKey!)
    index.setResult({ ...index.results.get(firstKey!)!, output: 'updated first' })
    expect(index.toolVersion(firstKey!)).toBeGreaterThan(firstRevision)
    expect(index.toolVersion(secondKey!)).toBe(secondRevision)
  })
})
