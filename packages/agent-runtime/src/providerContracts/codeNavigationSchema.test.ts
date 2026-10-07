import { describe, expect, it } from 'vitest'
import { getToolByName, validateToolArgs, getToolsForMode } from '@fluxos/tools/toolRegistry'
import { toolsToAnthropicFormat, toolsToOpenAIFormat } from '@fluxos/models/toolSchemas'

describe('semantic navigation model schema', () => {
  it('has the same operations and position units in three provider schemas', () => {
    const anthropic = (toolsToAnthropicFormat(getToolsForMode('plan')) as any[]).find(tool => tool.name === 'code_navigation').input_schema
    const normal = (toolsToOpenAIFormat(getToolsForMode('plan'), { strict: false }) as any[]).find(tool => tool.function.name === 'code_navigation').function.parameters
    const strict = (toolsToOpenAIFormat(getToolsForMode('plan'), { strict: true }) as any[]).find(tool => tool.function.name === 'code_navigation').function.parameters
    for (const schema of [anthropic, normal, strict]) expect(schema.properties.operation.enum).toEqual(['definition', 'references', 'diagnostics'])
    expect(strict.properties.line.anyOf).toContainEqual({ type: 'null' })
    expect(getToolByName('code_navigation')?.access?.resources).toEqual([{ kind: 'filesystem', access: 'read', scope: 'workspace' }])
  })
  it('distinguishes omitted positions, diagnostics and version-bound continuation', () => {
    expect(validateToolArgs('code_navigation', { operation: 'definition', path: 'a.ts', line: 1, column: 1, offset: null, project_version: null }).valid).toBe(true)
    expect(validateToolArgs('code_navigation', { operation: 'diagnostics', path: 'a.ts', line: null, column: null }).valid).toBe(true)
    for (const args of [{ operation: 'definition' }, { operation: 'references', line: 1 }, { operation: 'definition', line: 0, column: 1 },
      { operation: 'diagnostics', line: 1, column: 1 }, { operation: 'diagnostics', offset: 1 }, { operation: 'diagnostics', limit: 501 }]) {
      expect(validateToolArgs('code_navigation', { path: 'a.ts', ...args }).valid).toBe(false)
    }
  })
})
