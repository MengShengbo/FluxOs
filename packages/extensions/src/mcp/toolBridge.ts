import type { AgentAttachment, AgentTool, ToolParameter } from '@fluxos/contracts/agentTypes'
import type { McpClient } from './client'
import type { McpToolCallOptions, McpToolInfo } from './types'
import { validateSchemaValue } from '@fluxos/platform/schemaValidation'

export function mcpToolToAgentTool(tool: McpToolInfo): AgentTool {
  const params = extractParameters(tool.inputSchema)
  // Remote annotations cannot establish read-only execution or concurrency safety.
  const isReadOnly = tool.hostPolicy?.isReadOnly === true
  const isDestructive = tool.hostPolicy?.isDestructive !== false
  return {
    name: tool.name,
    access: { source: tool.hostPolicy ? 'host' : 'external', exposure: 'deferred', output: 'ToolResult',
      resources: tool.hostPolicy?.resources ?? [{ kind: 'external', access: 'unknown', scope: 'external' }] },
    description: `[MCP:${tool.serverName}] ${tool.description}${tool.instructions ? `\nServer guidance: ${tool.instructions.slice(0, 512)}` : ''}`,
    category: isReadOnly ? 'read' : 'execute',
    parameters: params,
    isReadOnly,
    isDestructive,
    isConcurrencySafe: isReadOnly && tool.hostPolicy?.isConcurrencySafe === true,
    inputSchema: tool.inputSchema,
  }
}

export function validateMcpToolArgs(schema: Record<string, unknown>, args: Record<string, unknown>): { valid: boolean; error?: string } {
  return validateSchemaValue(schema, args, '')
}

function extractParameters(schema: Record<string, unknown>): ToolParameter[] {
  const properties = (schema.properties || {}) as Record<string, any>
  const required = (schema.required || []) as string[]
  const params: ToolParameter[] = []

  for (const [name, prop] of Object.entries(properties).sort(([a], [b]) => a.localeCompare(b))) {
    params.push({
      name,
      type: mapJsonSchemaType(prop.type),
      description: prop.description || '',
      required: required.includes(name),
      enum: prop.enum,
      default: prop.default,
    })
  }

  return params
}

function mapJsonSchemaType(type: string | undefined): ToolParameter['type'] {
  switch (type) {
    case 'string': return 'string'
    case 'number':
    case 'integer': return 'number'
    case 'boolean': return 'boolean'
    case 'array': return 'array'
    case 'object': return 'object'
    default: return 'string'
  }
}

export function getMcpAgentTools(mcpClient: McpClient): AgentTool[] {
  return mcpClient
    .getAllTools()
    .map(mcpToolToAgentTool)
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

export function isMcpTool(toolName: string): boolean {
  return toolName.includes('__')
}

export function parseMcpToolName(toolName: string): { serverName: string; originalName: string } | null {
  const idx = toolName.indexOf('__')
  if (idx === -1) return null
  return {
    serverName: toolName.slice(0, idx),
    originalName: toolName.slice(idx + 2),
  }
}

export async function executeMcpTool(
  mcpClient: McpClient,
  toolName: string,
  args: Record<string, unknown>,
  options?: McpToolCallOptions,
): Promise<{ output: string; isError: boolean; attachments?: AgentAttachment[] }> {
  const parsed = parseMcpToolName(toolName)
  if (!parsed) return { output: `Invalid MCP tool name: ${toolName}`, isError: true }
  const result = options
    ? await mcpClient.callTool(parsed.serverName, parsed.originalName, args, options)
    : await mcpClient.callTool(parsed.serverName, parsed.originalName, args)
  return { output: result.content, isError: result.isError, attachments: result.attachments }
}
