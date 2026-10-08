import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEngine } from '@fluxos/agent-runtime/agentEngine'
import { SessionRegistry } from '@fluxos/agent-runtime/runtime/sessionRegistry'
import type { AgentTurn } from '@fluxos/contracts/agentTypes'
import type { AnyConversationEvent } from '@fluxos/contracts/conversationEvent'
import type { FluxAgentConfig } from '@fluxos/models/config'
import { ConversationEventStoreV2 } from './conversationEventStoreV2'
import { ConversationManager } from './manager'
import { ConversationRuntimeRepositoryV2 } from './conversationRuntimeRepositoryV2'

const roots: string[] = []
const managers: ConversationManager[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const manager of managers.splice(0)) manager.destroy()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fluxagent-canonical-commit-'))
  roots.push(root)
  const conversationId = 'canonical-commit'
  const turns: AgentTurn[] = []
  const session = { id: conversationId, mode: 'vibe' as const, turns, createdAt: 100, updatedAt: 101 }
  const status = vi.fn()
  const options = {
    conversationsRoot: root,
    conversationV2Root: join(root, 'v2'),
    interactionRoot: join(root, 'interactions'),
    profileId: 'profile-1',
    workspaceId: 'workspace-12345678',
    now: () => 1234,
  }
  const create = () => {
    const manager = new ConversationManager({
      getSession: () => session,
      getFullConversationTurns: () => turns,
      getContextSegments: () => [],
      getContextReservoir: () => [],
      getContextCompactionState: () => null,
      getWorkExecutionSnapshot: () => undefined,
      getModelSurfaceState: () => undefined,
    } as unknown as AgentEngine, { model: 'fixture', provider: 'custom' } as FluxAgentConfig,
    root, status, new SessionRegistry(conversationId), options)
    managers.push(manager)
    return manager
  }
  const event = (seq: number): AnyConversationEvent => ({
    schemaVersion: 1,
    eventId: `canonical-${seq}`,
    conversationId,
    threadId: conversationId,
    runId: 'run-1',
    seq,
    at: 100 + seq,
    source: 'workbench',
    provenance: 'live',
    type: 'run.started',
    payload: { objective: 'First durable goal' },
  })
  const store = () => new ConversationEventStoreV2(join(options.conversationV2Root, 'events'))
  const repository = () => new ConversationRuntimeRepositoryV2(
    options.conversationV2Root, options.profileId, options.workspaceId, root,
  )
  return { root, create, event, store, repository, turns, status, conversationId, manager: create() }
}

describe('canonical durable commit boundary', () => {
  it('does not commit ids or sequence on append failure and retries the same event exactly once', () => {
    const f = fixture()
    const failure = new Error('injected append failure')
    const append = vi.spyOn(ConversationRuntimeRepositoryV2.prototype, 'appendCanonical')
      .mockImplementationOnce(() => { throw failure })
    const first = f.event(1)

    expect(() => f.manager.recordCanonicalEvent(first)).toThrow(failure)
    expect(f.manager.getCanonicalEvents()).toEqual([])
    expect(f.manager.getPersistenceHealth()).toMatchObject({
      status: 'degraded', error: failure.message, degradedAt: 1234, pendingRecoveryEntries: 1,
    })
    expect(f.store().readAll(f.conversationId)).toEqual([])
    const { eventId, ...envelope } = first
    expect(f.manager.recordCanonicalEvent({ ...envelope, eventId })).toBe(true)
    expect(f.manager.recordCanonicalEvent(first)).toBe(false)
    expect(append).toHaveBeenCalledTimes(2)
    expect(f.manager.getCanonicalEvents()).toEqual([first])
    expect(f.manager.getPersistenceHealth()).toMatchObject({ status: 'healthy', pendingRecoveryEntries: 0 })
    expect(f.status.mock.calls.map(([error]) => error?.message ?? null)).toEqual([failure.message, null])
    expect(f.store().readAll(f.conversationId).filter(e => e.type === 'run.started')).toHaveLength(1)
    expect(f.repository().load(f.conversationId)).toMatchObject({ title: 'First durable goal' })
  })

  it('keeps the failed sequence pending and rejects a later event until it has been retried', () => {
    const f = fixture()
    f.manager.recordCanonicalEvent(f.event(1))
    f.turns.push({ id: 'user-1', role: 'user', content: 'First durable goal', timestamp: 102 })
    const second: AnyConversationEvent = {
      ...f.event(2), type: 'turn.started', turnId: 'user-1', payload: { turn: f.turns[0]! },
    }
    vi.spyOn(ConversationRuntimeRepositoryV2.prototype, 'appendCanonical')
      .mockImplementationOnce(() => { throw new Error('disk unavailable') })

    expect(() => f.manager.recordCanonicalEvent(second)).toThrow('disk unavailable')
    expect(f.manager.getCanonicalEvents().map(e => e.seq)).toEqual([1])
    expect(() => f.manager.recordCanonicalEvent(f.event(3))).toThrow(/pending|expected seq 2/i)
    expect(f.manager.recordCanonicalEvent(second)).toBe(true)
    expect(f.manager.getCanonicalEvents().map(e => e.seq)).toEqual([1, 2])
    expect(() => f.manager.recordCanonicalEvent(f.event(4))).toThrow(/expected seq 3/)
    expect(f.repository().load(f.conversationId)?.turns.map(t => t.content)).toContain('First durable goal')
  })

  it('retryPersistence retries the pending fact before reporting recovery, including after an unrelated save', () => {
    const f = fixture()
    const first = f.event(1)
    vi.spyOn(ConversationRuntimeRepositoryV2.prototype, 'appendCanonical')
      .mockImplementationOnce(() => { throw new Error('disk unavailable') })
    expect(() => f.manager.recordCanonicalEvent(first)).toThrow('disk unavailable')

    expect(f.manager.recordDraftState({ text: 'Separately saved draft' })).toBe(true)
    f.manager.persist(true)
    expect(f.manager.getPersistenceHealth().status).toBe('degraded')
    expect(f.status).toHaveBeenCalledTimes(1)
    expect(f.manager.retryPersistence().status).toBe('healthy')
    expect(f.manager.getCanonicalEvents()).toEqual([first])
    expect(f.store().readAll(f.conversationId).filter(e => e.type === 'run.started')).toHaveLength(1)
  })

  it('does not let the first failed event be bypassed even when no sequence has committed', () => {
    const f = fixture()
    vi.spyOn(ConversationRuntimeRepositoryV2.prototype, 'appendCanonical')
      .mockImplementationOnce(() => { throw new Error('disk unavailable') })
    expect(() => f.manager.recordCanonicalEvent(f.event(7))).toThrow('disk unavailable')
    expect(() => f.manager.recordCanonicalEvent(f.event(8))).toThrow(/pending/i)
    expect(f.manager.getCanonicalEvents()).toEqual([])
    expect(f.manager.retryPersistence().status).toBe('healthy')
    expect(f.manager.getCanonicalEvents().map(e => e.seq)).toEqual([7])
  })

  it('retains degradation on repeated retry failure and does not allow mutation of the pending fact', () => {
    const f = fixture()
    const first = f.event(1)
    const append = vi.spyOn(ConversationRuntimeRepositoryV2.prototype, 'appendCanonical')
      .mockImplementationOnce(() => { throw new Error('disk unavailable') })
      .mockImplementationOnce(() => { throw new Error('disk still unavailable') })
    expect(() => f.manager.recordCanonicalEvent(first)).toThrow('disk unavailable')
    expect(f.manager.retryPersistence()).toMatchObject({ status: 'degraded', error: 'disk still unavailable', degradedAt: 1234 })
    expect(f.manager.getCanonicalEvents()).toEqual([])
    expect(() => f.manager.recordCanonicalEvent({ ...first, at: 999 })).toThrow(/pending/i)
    expect(append).toHaveBeenCalledTimes(2)
    expect(f.manager.retryPersistence().status).toBe('healthy')
    expect(f.manager.getCanonicalEvents()).toEqual([first])
  })

  it('reconciles a post-write exception idempotently and replays the committed fact after restart', () => {
    const f = fixture()
    const original = ConversationRuntimeRepositoryV2.prototype.appendCanonical
    vi.spyOn(ConversationRuntimeRepositoryV2.prototype, 'appendCanonical')
      .mockImplementationOnce(function (event, context) {
        original.call(this, event, context)
        throw new Error('receipt unavailable after durable write')
      })
    expect(() => f.manager.recordCanonicalEvent(f.event(1))).toThrow('receipt unavailable')
    expect(f.manager.getCanonicalEvents()).toEqual([])
    expect(f.store().readAll(f.conversationId).filter(e => e.type === 'run.started')).toHaveLength(1)
    expect(f.manager.retryPersistence().status).toBe('healthy')
    expect(f.store().readAll(f.conversationId).filter(e => e.type === 'run.started')).toHaveLength(1)

    const loaded = f.repository().load(f.conversationId)!
    const restarted = f.create()
    restarted.replaceCanonicalEvents(loaded.canonicalEvents ?? [])
    const restoredEvents = restarted.getCanonicalEvents()
    expect(restoredEvents.some(e => e.type === 'run.started' && e.payload.objective === 'First durable goal')).toBe(true)
    const nextSeq = (restoredEvents.at(-1)?.seq ?? 0) + 1
    f.turns.push({ id: 'user-after-restart', role: 'user', content: 'Continue', timestamp: 300 })
    const next: AnyConversationEvent = {
      ...f.event(nextSeq), eventId: 'after-restart', type: 'turn.started',
      turnId: 'user-after-restart', payload: { turn: f.turns[0]! },
    }
    expect(restarted.recordCanonicalEvent(next)).toBe(true)
    expect(restarted.recordCanonicalEvent(next)).toBe(false)
    expect(restarted.getPersistenceHealth().status).toBe('healthy')
    expect(f.repository().load(f.conversationId)?.turns.some(t => t.content === 'Continue')).toBe(true)
  })

  it('does not publish usage from a failed fact and keeps that fact separately in the recovery export', () => {
    const f = fixture()
    f.manager.recordCanonicalEvent(f.event(1))
    f.turns.push({ id: 'user-1', role: 'user', content: 'Goal', timestamp: 102 })
    const usageEvent: AnyConversationEvent = {
      ...f.event(2), type: 'model.request_updated', payload: { request: {
        id: 'attempt-1', requestId: 'request-1', runId: 'run-1',
        purpose: 'turn', status: 'completed', startedAt: 101, updatedAt: 102,
        usage: { input: 20, output: 5, source: 'provider' }, usageFinal: true,
      } },
    }
    vi.spyOn(ConversationRuntimeRepositoryV2.prototype, 'appendCanonical')
      .mockImplementationOnce(() => { throw new Error('disk unavailable') })
    expect(() => f.manager.recordCanonicalEvent(usageEvent)).toThrow('disk unavailable')
    expect(f.manager.getModelUsageSummary()).toBeUndefined()
    const path = f.manager.exportRecoveryBundle(join(f.root, 'recovery.json'))
    const recovery = JSON.parse(readFileSync(path, 'utf8'))
    expect(recovery.pendingCanonicalEvents).toEqual([usageEvent])
    expect(recovery.conversation.canonicalEvents).toEqual([f.event(1)])
    expect(recovery.persistence).toMatchObject({ status: 'degraded', pendingRecoveryEntries: 1 })
    expect(f.manager.retryPersistence().status).toBe('healthy')
    expect(f.manager.getModelUsageSummary()).toMatchObject({ attempts: 1, totals: { input: 20, output: 5 } })
    expect(f.manager.recordCanonicalEvent(usageEvent)).toBe(false)
    expect(f.manager.getModelUsageSummary()?.attempts).toBe(1)
  })
})
