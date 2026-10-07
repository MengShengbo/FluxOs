import { describe, expect, it } from 'vitest'
import { validateSchemaValue } from '@fluxos/platform/schemaValidation'
import { validateToolArgs, getToolsForMode } from '@fluxos/tools/toolRegistry'
import { toolsToAnthropicFormat, toolsToOpenAIFormat } from '@fluxos/models/toolSchemas'
import { normalizeBuiltInToolArguments } from '@fluxos/tools/toolArgumentNormalization'

type Schema = Record<string, unknown>
const schemas = (name: string): Schema[] => [
  ...(toolsToOpenAIFormat(getToolsForMode('vibe')) as Array<{ function: { name: string; parameters: Schema } }>).filter(t => t.function.name === name).map(t => t.function.parameters),
  ...(toolsToOpenAIFormat(getToolsForMode('vibe'), { strict: true }) as Array<{ function: { name: string; parameters: Schema } }>).filter(t => t.function.name === name).map(t => t.function.parameters),
  ...(toolsToAnthropicFormat(getToolsForMode('vibe')) as Array<{ name: string; input_schema: Schema }>).filter(t => t.name === name).map(t => t.input_schema),
]

// Strict protocols require nullable optionals to be present, including nested ones.
function fillNullable(schema: Schema, value: unknown): unknown {
  const alternatives = schema.anyOf as Schema[] | undefined
  if (alternatives) return fillNullable(alternatives.find(s => s.type !== 'null')!, value)
  if (Array.isArray(value)) return value.map(item => fillNullable(schema.items as Schema, item))
  if (!value || typeof value !== 'object' || !schema.properties) return value
  const result = { ...value } as Record<string, unknown>
  for (const [key, property] of Object.entries(schema.properties as Record<string, Schema>)) {
    if (key in result) result[key] = fillNullable(property, result[key])
    else if ((schema.required as string[] | undefined)?.includes(key) && validateSchemaValue(property, null).valid) result[key] = null
  }
  return result
}

const validCases: Array<[string, Record<string, unknown>]> = [
  ['write_file', { path: 'a.txt', content: '' }],
  ['replace_file', { path: 'a.txt', content: '' }],
  ['edit_file', { path: 'a.txt', old_content: 'remove', new_content: '' }],
  ['multi_edit', { path: 'a.txt', edits: [{ old_string: 'remove', new_string: '' }] }],
  ['create_task', { title: 'Task', description: '', priority: 'minor', dependencies: [] }],
  ['create_tasks', { tasks: [{ title: 'Task', description: '', priority: 'minor', dependencies: [] }] }],
  ['run_command', { command: 'fixture', env: [], run_in_background: false }],
  ['run_command', { command: 'fixture', env: [{ name: 'EMPTY', value: '' }] }],
  ['web_search', { query: 'fixture', domains: [], exclude_domains: [] }],
  ['search_content', { pattern: 'fixture' }],
  ['list_directory', { path: '.' }],
]
const invalidCases: Array<[string, Record<string, unknown>]> = [
  ['write_file', { path: 'a.txt' }],
  ['write_file', { path: 'a.txt', content: null }],
  ['write_file', { path: '', content: '' }],
  ['replace_file', { path: 'a.txt', content: null }],
  ['edit_file', { path: 'a.txt', old_content: 'remove' }],
  ['edit_file', { path: 'a.txt', old_content: 'remove', new_content: null }],
  ['edit_file', { path: 'a.txt', old_content: '', new_content: 'x' }],
  ['multi_edit', { path: 'a.txt', edits: [] }],
  ['multi_edit', { path: 'a.txt', edits: null }],
  ['multi_edit', { path: 'a.txt', edits: [{ old_string: 'x' }] }],
  ['multi_edit', { path: 'a.txt', edits: [{ old_string: 'x', new_string: null }] }],
  ['multi_edit', { path: 'a.txt', edits: [{ old_string: '', new_string: 'x' }] }],
  ['list_directory', { path: '' }],
  ['list_directory', { path: null }],
  ['list_directory', {}],
  ['search_files', { pattern: '*.ts', path: '' }],
  ['search_content', { pattern: 'needle', path: '' }],
  ['search_content', { pattern: 'needle', glob: '*.ts' }],
  ['run_command', { command: '' }],
  ['run_command', { command: null }],
  ['run_command', { command: 'fixture', cwd: '' }],
  ['run_command', { command: 'fixture', display_title: '' }],
  ['run_command', { command: 'fixture', timeout: '' }],
  ['run_command', { command: 'fixture', expected_exit_codes: [] }],
  ['apply_patch', { patch: '' }],
  ['web_fetch', { urls: [] }],
  ['web_fetch', { urls: [''] }],
  ['create_tasks', { tasks: [] }],
  ['create_tasks', { tasks: [{ title: '', description: '', priority: 'minor' }] }],
  ['create_task', { title: '', description: '', priority: 'minor' }],
  ['read_terminal', { session_id: '' }],
  ['git_commit', { message: '' }],
  ['git_revert', { revision: '' }],
]

describe('field presence and explicit constraints', () => {
  it.each(validCases)('accepts %s %j across schema and runtime', (name, args) => {
    expect(validateToolArgs(name, args)).toEqual({ valid: true })
    for (const schema of schemas(name)) {
      const represented = fillNullable(schema, args) as Record<string, unknown>
      expect(validateSchemaValue(schema, represented)).toEqual({ valid: true })
      expect(validateToolArgs(name, represented)).toEqual({ valid: true })
    }
  })
  it.each(invalidCases)('rejects %s %j before dispatch', (name, args) => {
    expect(validateToolArgs(name, args).valid).toBe(false)
    for (const schema of schemas(name)) expect(validateSchemaValue(schema, fillNullable(schema, args)).valid).toBe(false)
  })
  it('distinguishes missing, explicit null and empty string without inherited parameters', () => {
    expect(validateToolArgs('write_file', { path: 'a', content: undefined })).toEqual({ valid: false, error: 'Missing required parameter: content' })
    expect(validateToolArgs('write_file', { path: 'a', content: null })).toEqual({ valid: false, error: 'Invalid type for content: expected string' })
    expect(validateToolArgs('write_file', Object.assign(Object.create({ content: 'inherited' }), { path: 'a' }))).toEqual({ valid: false, error: 'Missing required parameter: content' })
    expect(validateToolArgs('edit_file', { path: 'a', old_content: 'x', new_content: '', replace_all: null })).toEqual({ valid: true })
  })
  it.each(invalidCases.filter(([name]) => ['search_content', 'list_directory'].includes(name)))('does not normalize invalid %s arguments into valid ones: %j', (name, args) => {
    const normalized = normalizeBuiltInToolArguments(name, args)
    expect(validateToolArgs(name, normalized).valid).toBe(false)
  })
})
