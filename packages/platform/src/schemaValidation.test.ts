import { describe, expect, it } from 'vitest'
import { validateSchemaValue } from './schemaValidation'

describe('schema presence and closed-object semantics', () => {
  const nullable = { type: 'object', properties: { value: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['value'], additionalProperties: false }
  it('requires a declared property without rejecting its permitted null value', () => {
    expect(validateSchemaValue(nullable, {})).toMatchObject({ valid: false })
    expect(validateSchemaValue(nullable, { value: null })).toEqual({ valid: true })
    expect(validateSchemaValue(nullable, { value: 'text' })).toEqual({ valid: true })
    expect(validateSchemaValue(nullable, { value: 1 })).toMatchObject({ valid: false })
  })
  it('does not accept null or inherited required fields when the schema forbids them', () => {
    const schema = { ...nullable, properties: { value: { type: 'string' } } }
    expect(validateSchemaValue(schema, { value: null })).toMatchObject({ valid: false })
    expect(validateSchemaValue(schema, Object.create({ value: 'inherited' }))).toMatchObject({ valid: false })
  })
  it.each(['constructor', '__proto__', 'toString'])('rejects undeclared own properties named %s', name => {
    const value = JSON.parse(`{"value":"ok","${name}":"unexpected"}`)
    expect(validateSchemaValue(nullable, value)).toMatchObject({ valid: false, error: `Unexpected parameter: ${name}` })
  })
})
