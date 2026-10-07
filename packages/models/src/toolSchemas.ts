import type { AgentTool, ToolParameter } from '@fluxos/contracts/agentTypes'
import { relaxNullableRequiredFields } from '@fluxos/platform/schemaValidation'

export function toolsToOpenAIFormat(tools: readonly AgentTool[], options?: { strict?: boolean }): object[] {
  const modeTools = tools
  return modeTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      ...(options?.strict ? { strict: true } : {}),
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          tool.parameters.map(p => [
            p.name,
            parameterSchema(p, options?.strict === true),
          ])
        ),
        required: (options?.strict ? tool.parameters : tool.parameters.filter(p => p.required)).map(p => p.name),
        additionalProperties: false,
      },
    },
  }))
}

export function toolsToAnthropicFormat(tools: readonly AgentTool[]): object[] {
  const modeTools = tools
  return modeTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(
        tool.parameters.map(p => [
          p.name,
          parameterSchema(p, false),
        ])
      ),
      required: tool.parameters.filter(p => p.required).map(p => p.name),
      additionalProperties: false,
    },
  }))
}

function parameterSchema(parameter: ToolParameter, strict: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = parameter.schema
    ? strict ? strictifySchema(parameter.schema) : relaxNullableRequiredFields(parameter.schema)
    : { type: parameter.type }
  if (parameter.enum) base.enum = parameter.enum
  if (parameter.default !== undefined) base.default = parameter.default
  if (strict && !parameter.required) {
    return { anyOf: [base, { type: 'null' }], description: parameter.description }
  }
  return { ...base, description: parameter.description }
}

function strictifySchema(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...schema }

  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((value): value is string => typeof value === 'string')
    delete normalized.type
    normalized.anyOf = types.map(type => strictifySchema({ type }))
    return strictifySchema({ ...normalized, anyOf: normalized.anyOf })
  }

  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    const candidates = schema[keyword]
    if (Array.isArray(candidates)) {
      normalized[keyword] = candidates.map(candidate => (
        candidate && typeof candidate === 'object' && !Array.isArray(candidate)
          ? strictifySchema(candidate as Record<string, unknown>)
          : candidate
      ))
    }
  }

  if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    normalized.items = strictifySchema(schema.items as Record<string, unknown>)
  }

  if (schema.type === 'object' || schema.properties) {
    const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, unknown>
      : {}
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter(item => typeof item === 'string') : [])
    normalized.properties = Object.fromEntries(Object.entries(properties).map(([name, property]) => {
      const child = property && typeof property === 'object' && !Array.isArray(property)
        ? strictifySchema(property as Record<string, unknown>)
        : property
      return [name, required.has(name) ? child : makeNullableSchema(child)]
    }))
    normalized.required = Object.keys(properties)
    normalized.additionalProperties = false
  }

  return normalized
}

function makeNullableSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema
  const record = schema as Record<string, unknown>
  const variants = record.anyOf
  if (Array.isArray(variants) && variants.some(item => (
    item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).type === 'null'
  ))) return record
  return { anyOf: [record, { type: 'null' }] }
}

/** External schemas are provider-owned; preserve their declared shape and strictness. */
export function externalToolSchema(tool: AgentTool): Record<string, unknown> {
  return tool.inputSchema || {
    type: 'object',
    properties: Object.fromEntries(tool.parameters.map(p => [p.name, { type: p.type, description: p.description }])),
    required: tool.parameters.filter(p => p.required).map(p => p.name),
  }
}
