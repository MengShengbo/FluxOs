import { describe, expect, it } from 'vitest'
import { normalizeBuiltInToolArguments } from './toolArgumentNormalization'

describe('built-in tool argument normalization', () => {
  it('preserves an empty required directory path so validation can reject it', () => {
    expect(normalizeBuiltInToolArguments('list_directory', { path: '' })).toEqual({ path: '' })
  })

  it('preserves a concrete file scope without matching same-named descendants', () => {
    expect(normalizeBuiltInToolArguments('search_content', {
      path: 'apps/web/package.json',
      pattern: 'scripts',
      context_after: 2,
    })).toEqual({
      path: 'apps/web/package.json',
      pattern: 'scripts',
      context_after: 2,
    })
  })

  it('preserves undeclared fields and invalid paths for admission to reject', () => {
    expect(normalizeBuiltInToolArguments('search_content', {
      path: '',
      pattern: 'AgentEngine',
      glob: '*.ts',
    })).toEqual({
      path: '',
      pattern: 'AgentEngine',
      glob: '*.ts',
    })
  })
  it.each([{}, { path: null }, { path: undefined }])('defaults only an omitted optional search path: %j', args => {
    expect(normalizeBuiltInToolArguments('search_content', { pattern: 'needle', ...args })).toEqual({ pattern: 'needle', path: '.' })
  })
  it('preserves spaces that are part of a valid path', () => {
    expect(normalizeBuiltInToolArguments('search_content', { path: ' folder ', pattern: 'x' })).toEqual({ path: ' folder ', pattern: 'x' })
  })
})
