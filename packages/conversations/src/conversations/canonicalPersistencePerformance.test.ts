import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEngine } from '@fluxos/agent-runtime/agentEngine'
import type { FluxAgentConfig } from '@fluxos/models/config'
import type { AnyConversationEvent } from '@fluxos/contracts/conversationEvent'
import { SessionRegistry } from '@fluxos/agent-runtime/runtime/sessionRegistry'
import { ConversationManager } from './manager'
import { ConversationRuntimeRepositoryV2 } from './conversationRuntimeRepositoryV2'
import { ConversationRepositoryV2 } from './conversationRepositoryV2'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}) })
function root() { const path = mkdtempSync(join(tmpdir(), 'fluxagent-canonical-hot-path-')); roots.push(path); return path }
function event(seq: number): Extract<AnyConversationEvent, {type: 'stream.delta'}> {
  return {schemaVersion: 1, eventId: `delta-${seq}`, conversationId: 'conversation-performance', threadId: 'conversation-performance', runId: 'run-1', seq, at: seq + 100, source: 'agent', provenance: 'live', type: 'stream.delta', payload: {channel: 'answer', text: 'delta'}}
}

describe('canonical persistence hot path', () => {
  it('does not read conversation context or projections for transient stream events', () => {
    const repository = new ConversationRuntimeRepositoryV2(root(), 'profile-1', 'workspace-12345678', process.cwd())
    const context = vi.fn(() => { throw new Error('Transient event requested history') })
    for (let seq = 1; seq <= 10_000; seq++) repository.appendCanonical(event(seq), context)
    expect(context).not.toHaveBeenCalled()
  })

  it('keeps streaming and metadata saves independent of full execution and context history', () => {
    const directory = root()
    const turns = [{id: 'user-1', role: 'user' as const, content: 'Fixture prompt', timestamp: 100}]
    const forbidden = vi.fn(() => { throw new Error('Hot path requested full history') })
    const getTurns = vi.fn(() => turns)
    const session = {id: 'conversation-performance', mode: 'vibe' as const, turns, createdAt: 100, updatedAt: 100}
    const manager = new ConversationManager({
      getSession: () => session, getFullConversationTurns: getTurns,
      getContextSegments: forbidden, getContextReservoir: forbidden,
      getContextCompactionState: forbidden, getWorkExecutionSnapshot: forbidden, getModelSurfaceState: forbidden,
    } as unknown as AgentEngine, {model: 'fixture', provider: 'custom'} as FluxAgentConfig, process.cwd(), undefined,
    new SessionRegistry(session.id), {conversationsRoot: directory, profileId: 'profile-1', workspaceId: 'workspace-12345678', conversationV2Root: join(directory, 'v2')})
    manager.recordCanonicalEvent({...event(1), type: 'run.started', source: 'workbench', payload: {objective: 'Fixture prompt'}})
    manager.recordCanonicalEvent({...event(2), type: 'turn.started', turnId: 'user-1', payload: {turn: turns[0]}})
    getTurns.mockClear()
    for (let seq = 3; seq <= 2002; seq++) manager.recordCanonicalEvent(event(seq))
    expect(getTurns).not.toHaveBeenCalled()
    manager.persist(true)
    expect(manager.retryPersistence().status).toBe('healthy')
    expect(forbidden).not.toHaveBeenCalled()
    expect(manager.getCanonicalEvents().at(-1)?.seq).toBe(2002)
    const loaded = new ConversationRuntimeRepositoryV2(join(directory,'v2'), 'profile-1', 'workspace-12345678', process.cwd()).load(session.id)
    expect(loaded?.turns.some(turn => turn.content === 'Fixture prompt')).toBe(true)
    manager.destroy()
  })

  it('isolates selected projection data and observes other writers', () => {
    const directory = root()
    const first = new ConversationRuntimeRepositoryV2(directory, 'profile-1', 'workspace-12345678', process.cwd())
    first.appendCanonical({...event(1), type: 'run.started', payload: {objective: 'Fixture prompt'}}, {
      id: 'conversation-performance', title: 'Original', createdAt: 100, updatedAt: 101, mode: 'vibe', model: 'fixture', provider: 'custom',
    })
    const reader = new ConversationRepositoryV2(directory)
    const selected = reader.selectProjection('conversation-performance', projection => projection.conversation)!
    selected.title = 'Mutation outside repository'
    expect(reader.selectProjection('conversation-performance', projection => projection.conversation?.title)).toBe('Original')
    first.rename('conversation-performance', 'Other writer', 'custom', 102)
    expect(reader.selectProjection('conversation-performance', projection => projection.conversation?.title)).toBe('Other writer')
  })
})
