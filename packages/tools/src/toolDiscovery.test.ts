import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@fluxos/contracts/agentTypes'
import { decodeDeferredToolCall } from './toolDiscovery'
import { getAllTools, getResidentToolsForMode, getToolByName, getToolsForMode, isResidentToolName, validateToolArgs } from './toolRegistry'
import { toolsToAnthropicFormat, toolsToOpenAIFormat } from '../../models/src/toolSchemas'

const residentNames = [
  'read_file', 'read_tool_result', 'write_file', 'edit_file', 'apply_patch',
  'list_directory', 'search_files', 'search_content', 'run_command', 'ask_user',
  'use_skill', 'spawn_agent', 'tool_search', 'call_tool',
]
const wrapper = (args: unknown): ToolCall => ({ id: 'call-1', name: 'call_tool', arguments: args as Record<string, unknown> })

describe('resident request schemas', () => {
  it('keeps a fixed small core and the full catalog available for lookup', () => {
    expect(getResidentToolsForMode('vibe').map(tool => tool.name).sort()).toEqual([...residentNames].sort())
    expect(getAllTools().filter(tool => tool.access.exposure === 'resident').map(tool => tool.name).sort()).toEqual([...residentNames].sort())
    for (const tool of getAllTools()) expect(isResidentToolName(tool.name)).toBe(tool.access.exposure === 'resident')
    expect(isResidentToolName('future_tool')).toBe(false)
    expect(getToolByName('git_commit')?.access.exposure).toBe('deferred')
    expect(getToolByName('read_file_full')).toBeUndefined()
    expect(getToolByName('create_task')).toBeUndefined()
    expect(getToolsForMode('vibe').some(tool => tool.name === 'git_commit')).toBe(true)
  })

  it('applies mode and disabled policy while preserving registry order', () => {
    const plan = getResidentToolsForMode('plan')
    expect(plan.every(tool => tool.isReadOnly)).toBe(true)
    expect(plan.some(tool => tool.name === 'call_tool')).toBe(true)
    expect(plan.some(tool => tool.name === 'write_file')).toBe(false)
    expect(plan.some(tool => tool.name === 'spawn_agent')).toBe(false)
    const base = getResidentToolsForMode('vibe')
    expect(getResidentToolsForMode('vibe', { disabledTools: ['edit_file', 'git_commit'] })).toEqual(base.filter(tool => tool.name !== 'edit_file'))
    expect(getResidentToolsForMode('vibe')).toEqual(base)
  })

  it.each([
    ['OpenAI strict', (tools: ReturnType<typeof getAllTools>) => toolsToOpenAIFormat(tools, { strict: true })],
    ['Anthropic', toolsToAnthropicFormat],
  ] as const)('reduces %s serialized schema bytes by over half in each mode', (_name, convert) => {
    for (const mode of ['vibe', 'plan'] as const) {
      const full = Buffer.byteLength(JSON.stringify(convert(getToolsForMode(mode))))
      const resident = Buffer.byteLength(JSON.stringify(convert(getResidentToolsForMode(mode))))
      expect(resident).toBeLessThan(full / 2)
    }
  })

  it('requires a focused search and bounds its schema count', () => {
    expect(getToolByName('tool_search')?.parameters.find(parameter => parameter.name === 'limit')?.default).toBe(5)
    expect(validateToolArgs('tool_search', { query: 'git commit' }).valid).toBe(true)
    for (const query of ['', '  ', '\n']) expect(validateToolArgs('tool_search', { query }).valid).toBe(false)
    for (const limit of [0, 9, 1.5, NaN]) expect(validateToolArgs('tool_search', { query: 'git', limit }).valid).toBe(false)
    for (const limit of [1, 5, 8]) expect(validateToolArgs('tool_search', { query: 'git', limit }).valid).toBe(true)
  })
})

describe('deferred invocation decoding', () => {
  it('unwraps before normal execution and retains exact wire arguments and operation identity', () => {
    const call = wrapper({ name: 'git_commit', arguments_json: '{ "message" : "fix", "paths": ["a.ts"] }' })
    call.operationIdentity = { sessionId: 'session', turnId: 'turn', callId: call.id }
    const decoded = decodeDeferredToolCall(call)
    expect(decoded).toEqual({ ...call, name: 'git_commit', arguments: { message: 'fix', paths: ['a.ts'] },
      modelInvocation: { name: 'call_tool', arguments: call.arguments } })
    expect(call.name).toBe('call_tool')
    expect(decoded.operationIdentity).toBe(call.operationIdentity)
    expect(validateToolArgs('call_tool', call.arguments).valid).toBe(true)
  })

  it('does not authorize unknown names or validate a target schema', () => {
    const decoded = decodeDeferredToolCall(wrapper({ name: 'catalog__future', arguments_json: '{"unexpected":true}' }))
    expect(decoded.name).toBe('catalog__future')
    expect(decoded.arguments).toEqual({ unexpected: true })
    const direct: ToolCall = { id: 'direct', name: 'read_file', arguments: { path: 'a' } }
    expect(decodeDeferredToolCall(direct)).toBe(direct)
    expect(decodeDeferredToolCall(decoded)).toBe(decoded)
  })

  it('retains already captured wire metadata', () => {
    const call = wrapper({ name: 'git_status', arguments_json: '{}' })
    call.modelInvocation = { name: 'call_tool', arguments: { name: 'git_status', arguments_json: '{  }' } }
    expect(decodeDeferredToolCall(call).modelInvocation).toBe(call.modelInvocation)
  })

  it.each([
    null, [], {}, { name: '', arguments_json: '{}' }, { name: ' ', arguments_json: '{}' },
    { name: ' git_status ', arguments_json: '{}' }, { name: 1, arguments_json: '{}' },
    { name: 'call_tool', arguments_json: '{}' }, { name: 'tool_search', arguments_json: '{}' },
    { name: 'git_status', arguments_json: '{}', extra: true },
    { name: 'git_status', arguments_json: {} }, { name: 'git_status', arguments_json: '' },
    ...['{', 'null', '[]', '1', 'true', '"text"'].map(arguments_json => ({ name: 'git_status', arguments_json })),
  ])('rejects malformed or nested envelopes without mutation: %j', args => {
    const call = wrapper(args)
    expect(() => decodeDeferredToolCall(call)).toThrow('call_tool')
    expect(call.arguments).toBe(args)
    if (args && typeof args === 'object' && !Array.isArray(args)) expect(validateToolArgs('call_tool', args).valid).toBe(false)
  })
})
