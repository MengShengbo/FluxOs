import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentTurn, ToolCall } from '@fluxos/contracts/agentTypes'
import type { AnyConversationEvent } from '@fluxos/contracts/conversationEvent'
import { ModelSurface } from '@fluxos/models/modelSurface'
import { redactComputerConversation } from '../privacy/computerPrivacy'
import type { PersistedConversation } from './types'
import { ConversationRuntimeRepositoryV2 } from './conversationRuntimeRepositoryV2'

const argumentsJson = ' {\n  "path" : "src/a.ts", "offset": 1\n}\t '
const call: ToolCall = {
  id: 'provider-call', name: 'read_file', arguments: { path: 'src/a.ts', offset: 1 },
  modelInvocation: { name: 'call_tool', arguments: { name: 'read_file', arguments_json: argumentsJson } },
  operationIdentity: { sessionId: 'session', turnId: 'assistant', callId: 'provider-call' },
}

function conversation(root: string, toolCall: ToolCall): PersistedConversation {
  return {
    id: 'conversation', title: 'Gateway invocation', createdAt: 1, updatedAt: 3, mode: 'vibe',
    provider: 'custom', model: 'fixture', workspacePath: root, turnCount: 2,
    turns: [
      { id: 'assistant', role: 'assistant', content: '', timestamp: 1, toolCalls: [structuredClone(toolCall)] },
      { id: 'result', role: 'tool_result', content: '', timestamp: 2,
        toolResults: [{ toolCallId: toolCall.id, name: toolCall.name, output: 'ok', isError: false,
          operationIdentity: toolCall.operationIdentity }] },
    ],
  }
}

describe('model invocation in canonical conversations', () => {
  it.each([
    ['snapshot', 'invalid_json'], ['snapshot', 'extra_field'],
    ['canonical', 'invalid_json'], ['canonical', 'extra_field'],
  ] as const)('does not persist rejected computer gateway input through %s with %s', (mode, malformed) => {
    const root = mkdtempSync(join(tmpdir(), 'fluxagent-malformed-gateway-privacy-'))
    try {
      const secret = 'PRIVATE_REJECTED_COMPUTER_INPUT'
      const gateway: ToolCall = { id: 'computer-call', name: 'call_tool', arguments: {
        name: 'computer__type_text', arguments_json: malformed === 'invalid_json'
          ? ` { "text": "${secret}"` : ` { "text": "${secret}" } `,
        ...(malformed === 'extra_field' ? { unexpected: secret } : {}),
      } }
      // An undecoded gateway and an original-model copy can coexist before validation fails.
      gateway.modelInvocation = { name: gateway.name, arguments: structuredClone(gateway.arguments) }
      const value = conversation(root, gateway)
      value.modelSurface = new ModelSurface(undefined, value.turns).getState()
      value.canonicalEvents = [
        { schemaVersion: 1, eventId: 'started', conversationId: value.id, threadId: value.id,
          runId: 'run', turnId: 'assistant', seq: 1, at: 1, source: 'agent', provenance: 'live',
          type: 'turn.started', payload: { turn: value.turns[0]! } },
        { schemaVersion: 1, eventId: 'proposed', conversationId: value.id, threadId: value.id,
          runId: 'run', turnId: 'assistant', seq: 2, at: 2, source: 'agent', provenance: 'live',
          type: 'tool.proposed', payload: { toolCall: gateway } },
        { schemaVersion: 1, eventId: 'delta', conversationId: value.id, threadId: value.id,
          runId: 'run', turnId: 'assistant', seq: 3, at: 3, source: 'agent', provenance: 'live',
          type: 'tool.delta', payload: { toolCallId: gateway.id, toolName: gateway.name,
            partialJson: JSON.stringify(gateway.arguments) } },
      ]
      const redacted = redactComputerConversation(value)
      expect(JSON.stringify(redacted)).not.toContain(secret)
      const repo = new ConversationRuntimeRepositoryV2(root, 'profile', 'workspace', root)
      if (mode === 'snapshot') repo.persist(redacted)
      else for (const event of redacted.canonicalEvents!) repo.appendCanonical(event, redacted)
      const loaded = new ConversationRuntimeRepositoryV2(root, 'profile', 'workspace', root).load(value.id)!
      expect(JSON.stringify(loaded)).not.toContain(secret)
      expect(loaded.turns.flatMap(turn => turn.toolCalls ?? [])[0]).toMatchObject({ name: 'call_tool', arguments: {} })
      for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) expect(readFileSync(join(entry.parentPath, entry.name), 'utf8')).not.toContain(secret)
      }
      expect(JSON.stringify(value)).toContain(secret)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it.each(['snapshot', 'canonical'] as const)('retains execution and model identities after reopening %s events', mode => {
    const root = mkdtempSync(join(tmpdir(), 'fluxagent-model-invocation-'))
    try {
      const repository = () => new ConversationRuntimeRepositoryV2(root, 'profile', 'workspace', root)
      const repo = repository()
      const value = conversation(root, call)
      if (mode === 'snapshot') repo.persist(value)
      else {
        let seq = 0
        const append = (type: AnyConversationEvent['type'], payload: unknown) => repo.appendCanonical({
          schemaVersion: 1, eventId: `event-${++seq}`, conversationId: value.id, threadId: value.id,
          runId: 'run', turnId: 'assistant', seq, at: seq, source: 'agent', provenance: 'live', type, payload,
        } as AnyConversationEvent, value)
        append('run.started', { objective: 'Read a file' })
        append('turn.started', { turn: value.turns[0] })
        append('tool.proposed', { toolCall: call })
        append('tool.completed', { toolResult: value.turns[1]!.toolResults![0] })
      }
      const loaded = repository().load(value.id)!
      const restored = loaded.turns.flatMap(turn => turn.toolCalls ?? [])[0]!
      expect(restored).toMatchObject({ name: call.name, arguments: call.arguments,
        modelInvocation: call.modelInvocation, operationIdentity: call.operationIdentity })
      expect(restored.modelInvocation?.arguments.arguments_json).toBe(argumentsJson)
      expect(loaded.turns.flatMap(turn => turn.toolResults ?? [])[0]?.toolCallId).toBe(restored.id)
      const proposed = loaded.canonicalEvents?.find(event => event.type === 'tool.proposed')
      expect(proposed?.type === 'tool.proposed' ? proposed.payload.toolCall.modelInvocation : undefined).toEqual(call.modelInvocation)
      expect(new ModelSurface(undefined, loaded.turns).projectTurns().flatMap(turn => turn.toolCalls ?? [])[0]?.modelInvocation)
        .toEqual(call.modelInvocation)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('redacts both execution input and its model envelope in turns and persisted model surface', () => {
    const root = mkdtempSync(join(tmpdir(), 'fluxagent-model-invocation-privacy-'))
    try {
      const secret = 'PRIVATE_COMPUTER_INPUT'
      const computer: ToolCall = { id: 'computer-call', name: 'computer__type_text', arguments: { text: secret },
        modelInvocation: { name: 'call_tool', arguments: {
          name: 'computer__type_text', arguments_json: ` { "text": "${secret}" } `,
        } } }
      const value = conversation(root, computer)
      value.modelSurface = new ModelSurface(undefined, value.turns).getState()
      const redacted = redactComputerConversation(value)
      expect(JSON.stringify(redacted)).not.toContain(secret)
      expect(redacted.turns[0]!.toolCalls![0]).toMatchObject({ name: computer.name, arguments: {} })
      expect(redacted.turns[0]!.toolCalls![0]!.modelInvocation).toBeUndefined()
      const surfaceTurn = new ModelSurface(redacted.modelSurface).projectTurns()[0] as AgentTurn
      expect(surfaceTurn.toolCalls![0]!.modelInvocation).toBeUndefined()
      expect(value.turns[0]!.toolCalls![0]!.modelInvocation).toEqual(computer.modelInvocation)

      const repo = new ConversationRuntimeRepositoryV2(root, 'profile', 'workspace', root)
      repo.persist(redacted)
      const loaded = new ConversationRuntimeRepositoryV2(root, 'profile', 'workspace', root).load(value.id)!
      expect(JSON.stringify(loaded)).not.toContain(secret)
      expect(loaded.turns[0]!.toolCalls![0]!.modelInvocation).toBeUndefined()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
