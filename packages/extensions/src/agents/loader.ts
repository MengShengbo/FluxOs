import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { SubAgentDefinition, SubAgentThinking } from '@fluxagentcore/contracts/subAgentTypes'

// ── Frontmatter 解析 ──────────────────────────────────────────────

interface AgentFrontmatter {
  name?: string
  description?: string
  tools?: string[]
  maxTurns?: number
  maxParallel?: number
  temperature?: number
  thinking?: SubAgentThinking
  color?: string
  skills?: string[]           // 关联的 skill IDs
  maxOutputTokens?: number
  requestTimeoutMs?: number
  requiredToolCalls?: Record<string, number>
}

function parseFrontmatter(content: string): { meta: AgentFrontmatter; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: content }

  const yamlBlock = match[1]
  const body = match[2]
  const meta: AgentFrontmatter = {}

  let currentKey: string | null = null
  let currentArray: string[] | null = null

  for (const rawLine of yamlBlock.split('\n')) {
    const line = rawLine.replace(/\r$/, '')

    // 数组续行（以 - 开头，且当前有活跃的数组 key）
    if (currentArray && line.match(/^\s*-\s+/)) {
      const val = line.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, '')
      if (val) currentArray.push(val)
      continue
    }

    // 新的 key: value
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (!kv) continue

    // 切换 key 时，保存之前的数组
    if (currentArray && currentKey) {
      ;(meta as any)[currentKey] = currentArray
      currentArray = null
      currentKey = null
    }

    const [, key, rawValue] = kv
    const value = rawValue.trim()

    // 数组类型字段
    if (key === 'tools' || key === 'skills') {
      if (value.startsWith('[')) {
        // 内联数组 [a, b, c]
        try {
          ;(meta as any)[key] = JSON.parse(value)
        } catch {
          ;(meta as any)[key] = value.replace(/[[\]]/g, '').split(',').map(s => s.trim()).filter(Boolean)
        }
      } else if (value === '') {
        // 多行数组，后续行以 - 开头
        currentKey = key
        currentArray = []
      } else {
        ;(meta as any)[key] = [value]
      }
      continue
    }

    // 数值类型
    if (key === 'maxTurns' || key === 'maxParallel' || key === 'temperature' || key === 'maxOutputTokens' || key === 'requestTimeoutMs') {
      const num = Number(value)
      if (!isNaN(num)) (meta as any)[key] = num
      continue
    }

    if (key === 'requiredToolCalls') {
      try {
        const parsed = JSON.parse(value)
        if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') meta.requiredToolCalls = parsed
      } catch {}
      continue
    }

    // 字符串类型
    ;(meta as any)[key] = value.replace(/^["']|["']$/g, '')
  }

  // 保存最后一个数组
  if (currentArray && currentKey) {
    ;(meta as any)[currentKey] = currentArray
  }

  return { meta, body }
}

// ── Agent 加载 ────────────────────────────────────────────────────

export interface LoadedAgent extends SubAgentDefinition {
  source: 'project' | 'builtin'
  filePath?: string
  color?: string
  skills?: string[]
}

const VALID_THINKING: Set<SubAgentThinking> = new Set(['disabled', 'high', 'max'])

export const SUB_AGENT_MAX_TURNS = { min: 1, max: 50 }
export const SUB_AGENT_MAX_PARALLEL = { min: 1, max: 16 }
export const SUB_AGENT_MAX_OUTPUT_TOKENS = { min: 256, max: 128_000 }
export const SUB_AGENT_REQUEST_TIMEOUT_MS = { min: 1_000, max: 600_000 }
export const SUB_AGENT_REQUIRED_TOOL_CALLS = { minItems: 1, maxItems: 16, minCount: 1, maxCount: 50 }

export const DEFAULT_SUB_AGENT_TOOL_NAMES = new Set([
  'search_content',
  'search_files',
  'read_file',
  'list_directory',
  'web_search',
  'web_fetch',
  'read_web_source',
  'write_research_report',
])

export interface SubAgentConfigInput {
  maxTurns?: number
  maxParallel?: number
  maxOutputTokens?: number
  requestTimeoutMs?: number
  requiredToolCalls?: Record<string, unknown>
  allowedTools?: string[]
}

export interface NormalizedSubAgentConfig {
  maxTurns: number
  maxParallel: number
  maxOutputTokens?: number
  requestTimeoutMs?: number
  requiredToolCalls?: Record<string, number>
  allowedTools?: string[]
}

function assertIntegerRange(value: unknown, range: { min: number; max: number }, label: string): number {
  if (typeof value !== 'number' || Number.isInteger(value) === false || value < range.min || value > range.max) {
    throw new Error(label + ' must be an integer between ' + range.min + ' and ' + range.max)
  }
  return value
}

export function normalizeSubAgentConfig(input: SubAgentConfigInput, label = 'Subagent'): NormalizedSubAgentConfig {
  const maxTurns = assertIntegerRange(input.maxTurns ?? 5, SUB_AGENT_MAX_TURNS, label + ' maxTurns')
  const maxParallel = assertIntegerRange(input.maxParallel ?? 4, SUB_AGENT_MAX_PARALLEL, label + ' maxParallel')
  const maxOutputTokens = input.maxOutputTokens === undefined
    ? undefined
    : assertIntegerRange(input.maxOutputTokens, SUB_AGENT_MAX_OUTPUT_TOKENS, label + ' maxOutputTokens')
  const requestTimeoutMs = input.requestTimeoutMs === undefined
    ? undefined
    : assertIntegerRange(input.requestTimeoutMs, SUB_AGENT_REQUEST_TIMEOUT_MS, label + ' requestTimeoutMs')
  const allowedTools = input.allowedTools === undefined ? undefined : [...new Set(input.allowedTools.map(tool => String(tool).trim()).filter(Boolean))]
  if (allowedTools) {
    const unknownTools = allowedTools.filter(tool => DEFAULT_SUB_AGENT_TOOL_NAMES.has(tool) === false)
    if (unknownTools.length > 0) throw new Error(label + ' allowedTools contains unknown tool(s): ' + unknownTools.join(', '))
  }
  const requiredToolCalls: Record<string, number> = {}
  if (input.requiredToolCalls !== undefined) {
    const entries = Object.entries(input.requiredToolCalls)
    if (entries.length < SUB_AGENT_REQUIRED_TOOL_CALLS.minItems || entries.length > SUB_AGENT_REQUIRED_TOOL_CALLS.maxItems) {
      throw new Error(label + ' requiredToolCalls must contain between ' + SUB_AGENT_REQUIRED_TOOL_CALLS.minItems + ' and ' + SUB_AGENT_REQUIRED_TOOL_CALLS.maxItems + ' entries')
    }
    for (const [tool, count] of entries) {
      const normalizedTool = String(tool).trim()
      if (normalizedTool.length === 0 || DEFAULT_SUB_AGENT_TOOL_NAMES.has(normalizedTool) === false) {
        throw new Error(label + ' requiredToolCalls references an unknown tool: ' + normalizedTool)
      }
      if (typeof count !== 'number' || Number.isInteger(count) === false || count < SUB_AGENT_REQUIRED_TOOL_CALLS.minCount || count > SUB_AGENT_REQUIRED_TOOL_CALLS.maxCount) {
        throw new Error(label + ' requiredToolCalls count for ' + normalizedTool + ' is invalid')
      }
      if (allowedTools && allowedTools.includes(normalizedTool) === false) {
        throw new Error(label + ' requiredToolCalls references a tool not present in allowedTools: ' + normalizedTool)
      }
      requiredToolCalls[normalizedTool] = count
    }
  }
  return {
    maxTurns,
    maxParallel,
    maxOutputTokens,
    requestTimeoutMs,
    requiredToolCalls: Object.keys(requiredToolCalls).length > 0 ? requiredToolCalls : undefined,
    allowedTools,
  }
}


function mapToDefinition(
  meta: AgentFrontmatter,
  body: string,
  source: 'project' | 'builtin',
  filePath?: string,
): LoadedAgent {
  const name = typeof meta.name === 'string' ? meta.name.trim() : ''
  const description = typeof meta.description === 'string' ? meta.description.trim() : ''
  if (name.length === 0 || description.length === 0) {
    throw new Error((filePath || 'Agent definition') + ' must define name and description')
  }
  const config = normalizeSubAgentConfig({
    maxTurns: meta.maxTurns,
    maxParallel: meta.maxParallel,
    maxOutputTokens: meta.maxOutputTokens,
    requestTimeoutMs: meta.requestTimeoutMs,
    requiredToolCalls: meta.requiredToolCalls,
    allowedTools: meta.tools,
  }, 'Agent ' + name)
  const thinking = meta.thinking && VALID_THINKING.has(meta.thinking) ? meta.thinking : 'disabled'
  return {
    id: name,
    label: name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    description,
    systemPrompt: body.trim(),
    allowedTools: config.allowedTools,
    maxTurns: config.maxTurns,
    maxParallel: config.maxParallel,
    maxOutputTokens: config.maxOutputTokens,
    requestTimeoutMs: config.requestTimeoutMs,
    requiredToolCalls: config.requiredToolCalls,
    temperature: typeof meta.temperature === 'number' && Number.isFinite(meta.temperature) ? meta.temperature : 0,
    thinking,
    source,
    filePath,
    color: meta.color,
    skills: meta.skills,
  }
}

function loadAgentFromFile(filePath: string, source: 'project' | 'builtin'): LoadedAgent {
  const raw = readFileSync(filePath, 'utf-8')
  const { meta, body } = parseFrontmatter(raw)
  return mapToDefinition(meta, body, source, filePath)
}

/**
 * 从 .fluxagent/agents/ 目录加载所有自定义代理定义
 */
export function loadAgentsFromDir(workspacePath: string): LoadedAgent[] {
  const agentsDir = join(workspacePath, '.fluxagent', 'agents')
  if (existsSync(agentsDir) === false) return []

  let entries: string[]
  try {
    entries = readdirSync(agentsDir)
  } catch {
    return []
  }

  const agents: LoadedAgent[] = []
  for (const entry of entries) {
    if (entry.endsWith('.md') === false) continue
    const fullPath = join(agentsDir, entry)
    try {
      if (statSync(fullPath).isFile() === false) continue
    } catch {
      continue
    }
    agents.push(loadAgentFromFile(fullPath, 'project'))
  }
  return agents
}

/**
 * 合并硬编码内置代理与动态加载的代理
 * 动态代理（project）优先于同 ID 的内置代理
 */
export function mergeAgentDefinitions(
  builtin: LoadedAgent[],
  dynamic: LoadedAgent[],
): Map<string, LoadedAgent> {
  const map = new Map<string, LoadedAgent>()

  // 先放内置
  for (const def of builtin) {
    map.set(def.id, def)
  }

  // 动态覆盖同 ID
  for (const def of dynamic) {
    map.set(def.id, def)
  }

  return map
}
