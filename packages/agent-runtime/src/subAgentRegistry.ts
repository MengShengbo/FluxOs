import type { SubAgentDefinition } from '@fluxos/contracts/subAgentTypes'
import { loadAgentsFromDir, type LoadedAgent } from '@fluxos/extensions/agents/loader'
import type { SkillRuntime } from '@fluxos/extensions/skills/runtime'
import type { LoadedSkill } from '@fluxos/extensions/skills/loader'

/** Workspace-scoped role discovery. No model requests or tool execution. */
const builtinResearchAgent: LoadedAgent = {
  id: 'research', label: '研究员', source: 'builtin',
  description: 'Investigate a focused question using primary evidence and report uncertainty.',
  systemPrompt: 'Research the exact requested subject. Use primary sources and preserve its exact name. Read source text before making factual claims. Missing text in a truncated result, failed retrieval or a 404 does not prove nonexistence. Use source pagination to inspect omitted content. Return findings, sources and remaining uncertainty. Use the current environment date. Do not substitute a similarly named subject.',
  maxTurns: 16, maxParallel: 4, maxOutputTokens: 4096,
}
const registeredAgents = new Map<string, LoadedAgent>([
  ['research', builtinResearchAgent],
  ['default', { ...builtinResearchAgent, id: 'default', label: '通用助手', description: 'Handle a delegated task with the inherited runtime and tools.', systemPrompt: 'Complete the delegated objective using the available tools. Verify the result and return an accurate handoff.' }],
  ['worker', { ...builtinResearchAgent, id: 'worker', label: '执行者', description: 'Implement and verify a focused change.', systemPrompt: 'Own the delegated implementation. Inspect existing work, make scoped changes, run appropriate checks and return files changed, verification and unresolved work. Coordinate shared resources.' }],
  ['explorer', { ...builtinResearchAgent, id: 'explorer', label: '探索者', description: 'Trace code paths and collect evidence.', systemPrompt: 'Investigate the delegated code question. Cite source paths and exact behavior; preserve uncertainty and return a concise map of findings.' }],
])

export class SubAgentRegistry {
  private workspaceAgents = new Map<string, LoadedAgent>()

  reload(workspacePath: string): void {
    this.workspaceAgents = new Map(loadAgentsFromDir(workspacePath).map(agent => [agent.id, agent]))
  }

  get(type: string): SubAgentDefinition | undefined {
    return this.workspaceAgents.get(type) ?? registeredAgents.get(type)
  }

  definitions(): SubAgentDefinition[] {
    return [...new Map([...registeredAgents, ...this.workspaceAgents]).values()]
  }
}
/**
 * 从 .fluxagent/agents/ 加载独立的工作区注册表。
 */
export function loadDynamicAgents(workspacePath: string): SubAgentRegistry {
  const registry = new SubAgentRegistry()
  registry.reload(workspacePath)
  return registry
}
export function registerAgent(def: SubAgentDefinition, skillRuntime?: SkillRuntime): void {
  const loaded = def as LoadedAgent
  registeredAgents.set(def.id, loaded)

  // 自动注册代理关联的 skills
  if (loaded.skills && loaded.skills.length > 0 && skillRuntime) {
    const agentSkills: LoadedSkill[] = loaded.skills.map(skillId => ({
      id: skillId,
      name: skillId,
      command: `/${skillId}`,
      description: `Skill registered by agent: ${def.id}`,
      category: 'custom' as const,
      systemPrompt: '',
      source: 'system' as const,
      filePath: `[agent:${def.id}]`,
      rawContent: '',
    }))
    skillRuntime.registerSkills(agentSkills)
  }
}

/**
 * 获取单个代理定义。
 */
export function getSubAgentDefinition(type: string, registry?: SubAgentRegistry): SubAgentDefinition | undefined {
  return registry ? registry.get(type) : registeredAgents.get(type)
}

/**
 * 获取所有已注册和工作区代理定义，工作区定义优先。
 */
export function getAllAgentDefinitions(registry?: SubAgentRegistry): SubAgentDefinition[] {
  return registry ? registry.definitions() : [...registeredAgents.values()]
}

/**
 * 获取所有可用的 agent type ID 列表
 */
export function getAvailableAgentTypes(registry?: SubAgentRegistry): string[] {
  return getAllAgentDefinitions(registry).map(d => d.id)
}

/**
 * 将所有动态代理关联的 skills 同步到 SkillRuntime
 * 在 SkillRuntime 初始化后调用一次即可
 */
export function syncAgentSkills(skillRuntime: SkillRuntime, definitions = getAllAgentDefinitions()): void {
  for (const definition of definitions) {
    const agent = definition as LoadedAgent
    const loaded = agent as LoadedAgent
    if (!loaded.skills || loaded.skills.length === 0) continue

    const agentSkills: LoadedSkill[] = loaded.skills.map(skillId => ({
      id: skillId,
      name: skillId,
      command: `/${skillId}`,
      description: `Skill registered by agent: ${agent.id}`,
      category: 'custom' as const,
      systemPrompt: '',
      source: 'system' as const,
      filePath: `[agent:${agent.id}]`,
      rawContent: '',
    }))
    skillRuntime.registerSkills(agentSkills)
  }
}
