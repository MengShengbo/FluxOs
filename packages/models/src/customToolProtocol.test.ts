import { describe, expect, it } from 'vitest'
import { toResponsesInput, toResponsesTools } from './modelProtocol'
import { OpenAIResponsesStreamParser } from './providers/openAIResponsesStream'
import { MAX_STREAM_TOOL_ARGUMENT_CHARS } from './modelStream'

const bindings = { apply_patch: 'patch' }
const patch = '*** Begin Patch\n*** Add File: a.ts\n+const s = "\\\\$&你好"\n*** End Patch'
const tools = [{ type: 'function', function: { name: 'apply_patch', description: 'Apply a patch', parameters: { type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'], additionalProperties: false } } }]
const history = [
  { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ patch }) } }] },
  { role: 'tool', tool_call_id: 'call-1', content: 'Patch applied' },
]

describe('explicit Responses custom tool transport', () => {
  it('keeps JSON by default and emits raw text only for declared bindings', () => {
    expect(toResponsesTools(tools)[0]).toMatchObject({ type: 'function', name: 'apply_patch' })
    const custom = toResponsesTools(tools, bindings)[0]
    expect(custom).toMatchObject({ type: 'custom', name: 'apply_patch', format: { type: 'text' } })
    expect(custom).not.toHaveProperty('parameters')
    expect(custom).not.toHaveProperty('strict')
    expect(toResponsesInput(history, bindings)).toEqual([
      { type: 'custom_tool_call', call_id: 'call-1', name: 'apply_patch', input: patch },
      { type: 'custom_tool_call_output', call_id: 'call-1', output: 'Patch applied' },
    ])
    expect(toResponsesInput(history)[0]).toMatchObject({ type: 'function_call', arguments: JSON.stringify({ patch }) })
  })
  it('preserves invalid historical arguments without dropping data during conversion', () => {
    const invalid = [
      { role: 'assistant', tool_calls: [{ id: 'bad', function: { name: 'apply_patch', arguments: '{"patch":null,"extra":7}' } }] },
      { role: 'tool', tool_call_id: 'bad', content: 'Invalid arguments' },
    ]
    expect(toResponsesInput(invalid, bindings)).toEqual(toResponsesInput(invalid))
  })
  it.each(['delta', 'done', 'completed'] as const)('normalizes raw patch from %s events into the canonical arguments exactly once', mode => {
    const parser = new OpenAIResponsesStreamParser({}, bindings)
    const event = (value: unknown) => parser.handleLine(`data: ${JSON.stringify(value)}`)
    if (mode === 'completed') event({ type: 'response.completed', response: { output: [{ type: 'custom_tool_call', id: 'item-1', call_id: 'call-1', name: 'apply_patch', input: patch }] } })
    else {
      event({ type: 'response.output_item.added', output_index: 0, item: { type: 'custom_tool_call', id: 'item-1', call_id: 'call-1', name: 'apply_patch', input: '' } })
      if (mode === 'delta') for (const delta of [patch.slice(0, 20), patch.slice(20)]) event({ type: 'response.custom_tool_call_input.delta', item_id: 'item-1', delta })
      event({ type: 'response.custom_tool_call_input.done', item_id: 'item-1', input: patch })
      event({ type: 'response.output_item.done', item: { type: 'custom_tool_call', id: 'item-1', call_id: 'call-1', name: 'apply_patch', input: patch } })
      event({ type: 'response.completed', response: { output: [] } })
    }
    expect(parser.snapshot()).toMatchObject({ streamFailure: '', toolCalls: [{ id: 'call-1', name: 'apply_patch', argumentsJson: JSON.stringify({ patch }) }] })
    expect(parser.snapshot().toolCalls).toHaveLength(1)
  })
  it('rejects unadvertised custom tools and incomplete raw input', () => {
    const parser = new OpenAIResponsesStreamParser()
    parser.handleLine(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'custom_tool_call', call_id: 'call', name: 'apply_patch', input: patch }] } })}`)
    expect(parser.snapshot().streamFailure).toContain('not enabled')
    const incomplete = new OpenAIResponsesStreamParser({}, bindings)
    incomplete.handleLine(`data: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'custom_tool_call', call_id: 'call', name: 'apply_patch', input: patch } })}`)
    expect(incomplete.snapshot().streamFailure).toContain('incomplete')
  })
  it('reconciles an early delta with its later canonical call id without losing text', () => {
    const parser = new OpenAIResponsesStreamParser({}, bindings)
    parser.handleLine(`data: ${JSON.stringify({ type: 'response.custom_tool_call_input.delta', item_id: 'early-item', output_index: 0, delta: patch })}`)
    parser.handleLine(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'custom_tool_call', id: 'early-item', call_id: 'actual-call', name: 'apply_patch', input: '' } })}`)
    parser.handleLine(`data: ${JSON.stringify({ type: 'response.custom_tool_call_input.done', item_id: 'early-item', input: patch })}`)
    expect(parser.snapshot().toolCalls).toEqual([{ id: 'actual-call', name: 'apply_patch', argumentsJson: JSON.stringify({ patch }) }])
    expect(parser.snapshot().streamFailure).toBe('')
  })
  it('does not execute a truncated raw input after exceeding the stream budget', () => {
    const parser = new OpenAIResponsesStreamParser({}, bindings)
    parser.handleLine(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'custom_tool_call', call_id: 'call', name: 'apply_patch', input: 'x'.repeat(MAX_STREAM_TOOL_ARGUMENT_CHARS + 1) }] } })}`)
    expect(parser.snapshot().streamFailure).toContain('limit')
  })
})
