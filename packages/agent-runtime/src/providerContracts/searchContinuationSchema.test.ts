import { describe, expect, it } from 'vitest'
import { validateToolArgs, getToolsForMode } from '@fluxos/tools/toolRegistry'
import { toolsToAnthropicFormat, toolsToOpenAIFormat } from '@fluxos/models/toolSchemas'

describe('search cursor schema contracts', () => {
  it.each(['search_files', 'search_content'])('exposes stable continuation on all schemas for %s', name => {
    const anthropic = (toolsToAnthropicFormat(getToolsForMode('plan')) as any[]).find(tool => tool.name === name).input_schema
    const openai = (toolsToOpenAIFormat(getToolsForMode('plan'), { strict: false }) as any[]).find(tool => tool.function.name === name).function.parameters
    const strict = (toolsToOpenAIFormat(getToolsForMode('plan'), { strict: true }) as any[]).find(tool => tool.function.name === name).function.parameters
    for (const schema of [anthropic, openai]) expect(schema.properties.cursor).toMatchObject({ type: 'string', minLength: 1 })
    expect(strict.properties.cursor.anyOf).toContainEqual(expect.objectContaining({ type: 'string', minLength: 1 }))
    expect(strict.properties.cursor.anyOf).toContainEqual({ type: 'null' })
    expect(validateToolArgs(name, { pattern: 'needle', cursor: 'opaque', offset: null, head_limit: 100 }).valid).toBe(true)
    for (const args of [{ cursor: 'opaque', offset: 0 }, { cursor: '' }, { head_limit: 0 }, { head_limit: 501 }, { offset: -1 }, { offset: 1.5 }]) {
      expect(validateToolArgs(name, { pattern: 'needle', ...args }).valid).toBe(false)
    }
  })
})
