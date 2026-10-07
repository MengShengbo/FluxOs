import { describe, expect, it } from 'vitest'
import { getToolByName, validateToolArgs, getToolsForMode } from '@fluxos/tools/toolRegistry'
import { toolsToAnthropicFormat, toolsToOpenAIFormat } from '@fluxos/models/toolSchemas'

describe('continuation schema and access boundaries', () => {
  it.each([
    { byte_offset: 0, offset: 1 }, { byte_offset: 0, limit: 1 }, { byte_limit: 100 },
    { byte_offset: 1 }, { byte_offset: -1 }, { byte_offset: 0.5 }, { byte_offset: 0, byte_limit: 32769 },
  ])('rejects ambiguous or unbounded byte reads %j', args => {
    expect(validateToolArgs('read_file', { path: 'file', ...args }).valid).toBe(false)
  })
  it('accepts strict nullable omission and continuation versions', () => {
    expect(validateToolArgs('read_file', { path: 'file', offset: null, limit: null, byte_offset: 0, byte_limit: null, source_version: null }).valid).toBe(true)
    expect(validateToolArgs('read_file', { path: 'file', byte_offset: 4, source_version: 'a'.repeat(64) }).valid).toBe(true)
    expect(validateToolArgs('read_tool_result', { source_id: 'id', offset: 0, limit: 16000 }).valid).toBe(true)
    expect(validateToolArgs('read_tool_result', { source_id: 'id', limit: 16001 }).valid).toBe(false)
  })
  it('exposes both continuations consistently with read-only access metadata', () => {
    const anthropic = toolsToAnthropicFormat(getToolsForMode('plan')) as any[]
    const openai = toolsToOpenAIFormat(getToolsForMode('plan'), { strict: true }) as any[]
    expect(anthropic.find(tool => tool.name === 'read_file').input_schema.properties.byte_offset.type).toBe('integer')
    expect(openai.find(tool => tool.function.name === 'read_file').function.parameters.properties.byte_offset.anyOf).toContainEqual(expect.objectContaining({ type: 'integer', minimum: 0 }))
    for (const name of ['read_file', 'read_tool_result']) {
      expect(getToolByName(name)).toMatchObject({ isReadOnly: true, access: { source: 'builtin' } })
      expect(anthropic.some(tool => tool.name === name)).toBe(true)
      expect(openai.some(tool => tool.function.name === name)).toBe(true)
    }
  })
})
