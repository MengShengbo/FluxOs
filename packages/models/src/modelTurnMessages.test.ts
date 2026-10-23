import { describe, expect, it } from 'vitest'
import type { AgentTurn, ToolCall } from '@fluxos/contracts/agentTypes'
import { normalizeAnthropicToolMessages } from './modelMessages'
import { toResponsesInput } from './modelProtocol'
import { turnToModelMessages } from './modelTurnMessages'

const argumentsJson = ' {\n  "path" : "src/a.ts", "offset": 1\n}\t '
const call: ToolCall = {
  id: 'call-1', name: 'read_file', arguments: { path: 'src/a.ts', offset: 1 },
  modelInvocation: { name: 'call_tool', arguments: { name: 'read_file', arguments_json: argumentsJson } },
}
const assistant = (toolCall: ToolCall): AgentTurn => ({
  id: 'assistant-1', role: 'assistant', content: '', timestamp: 1, toolCalls: [toolCall],
})

describe('model-facing tool invocation replay', () => {
  it('replays the gateway name and literal argument string through Chat Completions', () => {
    const original = structuredClone(call)
    expect(turnToModelMessages(assistant(call), 'openai')[0]).toMatchObject({
      tool_calls: [{ id: call.id, function: { name: 'call_tool', arguments: JSON.stringify(call.modelInvocation!.arguments) } }],
    })
    expect(call).toEqual(original)
  })

  it('keeps the same gateway invocation when mapping to Responses', () => {
    const messages = turnToModelMessages(assistant(call), 'openai')
    expect(toResponsesInput(messages)).toEqual([{
      type: 'function_call', call_id: call.id, name: 'call_tool', arguments: JSON.stringify(call.modelInvocation!.arguments),
    }])
    expect(JSON.parse(toResponsesInput(messages)[0]!.arguments as string).arguments_json).toBe(argumentsJson)
  })

  it('retains the gateway input through Anthropic message normalization', () => {
    const messages = normalizeAnthropicToolMessages([
      ...turnToModelMessages(assistant(call), 'anthropic'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'ok' }] },
    ])
    expect(messages[0]).toEqual({ role: 'assistant', content: [{
      type: 'tool_use', id: call.id, name: 'call_tool', input: call.modelInvocation!.arguments,
    }] })
    expect((messages[0]!.content as Array<{ input: Record<string, unknown> }>)[0]!.input.arguments_json).toBe(argumentsJson)
  })

  it('uses the execution identity when no separate model invocation exists', () => {
    const direct: ToolCall = { id: 'direct', name: 'read_file', arguments: { path: 'README.md' } }
    expect(turnToModelMessages(assistant(direct), 'openai')[0]).toMatchObject({
      tool_calls: [{ function: { name: direct.name, arguments: JSON.stringify(direct.arguments) } }],
    })
    expect(turnToModelMessages(assistant(direct), 'anthropic')[0]).toMatchObject({
      content: [{ type: 'tool_use', name: direct.name, input: direct.arguments }],
    })
  })
})
