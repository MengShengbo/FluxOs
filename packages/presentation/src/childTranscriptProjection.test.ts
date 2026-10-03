import { describe, expect, it } from 'vitest'
import type { ChildTranscriptItem } from '@fluxagentcore/contracts/childAgentTypes'
import { childToolGroupLabel, projectChildTranscript } from './childTranscriptProjection'
let index = 0
function record(content: Record<string, unknown>, executionId = 'run'): ChildTranscriptItem {
  return { id: 'record-' + ++index, sequence: index, timestamp: index, executionId, ...content } as ChildTranscriptItem
}
const call = (id: string, name = 'read_file') => record({ kind: 'tool_call', toolCall: { id, name, arguments: { path: 'source.ts' } } })
const result = (id: string, error = false) => record({ kind: 'tool_result', toolResult: { toolCallId: id, name: 'read_file', output: 'evidence', isError: error } })
const message = (id: string, content: string) => record({ kind: 'message', turn: { id, content, role: 'assistant', timestamp: 1 } })

describe('child conversation projection', () => {
  it('groups consecutive tools across status noise and joins out-of-order results', () => {
    const projected = projectChildTranscript([message('progress', 'Inspecting source'), call('a'), record({ kind: 'status', phase: 'thinking' }), call('b'), result('b'), result('a'), message('final', 'Verified findings')])
    expect(projected.map(item => item.kind)).toEqual(['message', 'tools', 'message'])
    const group = projected[1]
    if (group.kind !== 'tools') throw Error('Expected tools')
    expect(group.tools.map(tool => tool.result?.toolCallId)).toEqual(['a', 'b'])
    expect(childToolGroupLabel(group.tools)).toBe('已读取 2 次')
  })
  it('updates a tool group when a later page supplies its result without adding another row', () => {
    const a = call('paged')
    const first = projectChildTranscript([a])
    const second = projectChildTranscript([a, result('paged', true)])
    expect(first[0].id).toBe(second[0].id)
    expect(second).toHaveLength(1)
    if (second[0].kind === 'tools') expect(childToolGroupLabel(second[0].tools)).toContain('1 项未完成')
  })
  it('does not turn internal lifecycle records or empty tool rounds into chat bubbles', () => {
    const internal = message('internal', 'internal')
    if (internal.kind === 'message') internal.turn.metadata = { internal: true }
    const projected = projectChildTranscript([internal, message('empty', ''), record({ kind: 'status', phase: 'running' }), call('mode', 'set_response_mode'), message('user-visible', 'Public progress')])
    expect(projected).toHaveLength(1)
    expect(projected[0].kind).toBe('message')
  })
  it('keeps execution rounds separate and deduplicates persisted public messages', () => {
    const repeated = message('same', 'Saved once')
    const records = [repeated, repeated, call('a'), record({ kind: 'tool_call', toolCall: { id: 'b', name: 'run_command', arguments: {} } }, 'followup')]
    expect(projectChildTranscript(records).map(item => item.kind)).toEqual(['message', 'tools', 'tools'])
  })
})
