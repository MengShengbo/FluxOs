import { describe, expect, it } from 'vitest'
import { validateSchemaValue } from '@fluxos/platform/schemaValidation'
import { validateToolArgs, getToolsForMode } from '@fluxos/tools/toolRegistry'
import { toolsToAnthropicFormat, toolsToOpenAIFormat } from '@fluxos/models/toolSchemas'

type Schema = Record<string, unknown> & { properties: Record<string, Record<string, unknown>>; required: string[] }
const openai = (strict: boolean) => (toolsToOpenAIFormat(getToolsForMode('vibe'), { strict }) as Array<{ function: { name: string; parameters: Schema } }>)
  .find(tool => tool.function.name === 'run_command')!.function.parameters
const anthropic = () => (toolsToAnthropicFormat(getToolsForMode('vibe')) as Array<{ name: string; input_schema: Schema }>)
  .find(tool => tool.name === 'run_command')!.input_schema

describe('run_command schema and runtime equivalence', () => {
  it.each(['strict', 'ordinary', 'anthropic'] as const)('expresses nonempty env and optional display through %s', format => {
    const schema = format === 'anthropic' ? anthropic() : openai(format === 'strict')
    const args: Record<string, unknown> = {
      ...(format === 'strict' ? Object.fromEntries(Object.keys(schema.properties).map(key => [key, null])) : {}),
      command: 'fixture', env: [{ name: 'QUERY', value: 'words with spaces' }, { name: 'EMPTY', value: '' }],
    }
    expect(validateSchemaValue(schema, args)).toEqual({ valid: true })
    expect(validateToolArgs('run_command', args)).toEqual({ valid: true })
    if (format === 'strict') {
      expect(schema.required).toContain('display_title')
      expect(schema.properties.display_title!.anyOf).toContainEqual({ type: 'null' })
    } else expect(schema.required).toEqual(['command'])
  })

  it.each([
    { command: 'fixture', env: { QUERY: 'old dictionary' } },
    { command: 'fixture', env: [{ name: 'QUERY', value: 1 }] },
    { command: 'fixture', env: [{ name: 'QUERY', value: null }] },
    { command: 'fixture', env: [{ name: 'QUERY' }] },
    { command: 'fixture', env: [{ name: 'QUERY', value: 'x', surprise: true }] },
    { command: 'fixture', env: [{ name: 'QUERY', value: 'x', constructor: 'unexpected' }] },
    { command: 'fixture', env: [{ name: '', value: 'x' }] },
    { command: 'fixture', env: [{ name: 'BAD=NAME', value: 'x' }] },
    { command: 'fixture', env: [{ name: 'QUERY', value: 'bad\u0000value' }] },
    { command: 'fixture', display_kind: 'invented' },
    { command: 'fixture', display_title: 7 },
    { command: 'fixture', unknown: true },
    {},
  ])('rejects invalid execution data %j consistently', args => {
    for (const schema of [openai(false), anthropic()]) expect(validateSchemaValue(schema, args).valid).toBe(false)
    const strictSchema = openai(true)
    const strictArgs = { ...Object.fromEntries(Object.keys(strictSchema.properties).map(key => [key, null])), ...args }
    expect(validateSchemaValue(strictSchema, strictArgs).valid).toBe(false)
    expect(validateToolArgs('run_command', args).valid).toBe(false)
  })
})
