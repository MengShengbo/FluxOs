import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSubAgentDefinition, loadDynamicAgents, registerAgent } from './subAgentRegistry'

describe('subagent registry isolation', () => {
  it('replaces workspace agents without removing programmatic registrations', () => {
    const firstWorkspace = mkdtempSync(join(tmpdir(), 'fluxagent-agent-first-'))
    const secondWorkspace = mkdtempSync(join(tmpdir(), 'fluxagent-agent-second-'))
    mkdirSync(join(firstWorkspace, '.fluxagent', 'agents'), { recursive: true })
    writeFileSync(join(firstWorkspace, '.fluxagent', 'agents', 'first.md'), [
      '---',
      'name: first_workspace_agent',
      'description: first workspace only',
      'tools: [web_search, web_fetch]',
      '---',
      'Inspect the first workspace.',
    ].join('\n'))
    registerAgent({
      id: 'registered_agent_fixture',
      label: 'Registered fixture',
      description: 'process registration',
      systemPrompt: 'Stay registered.',
      maxTurns: 1,
      maxParallel: 1,
    })

    try {
      const first = loadDynamicAgents(firstWorkspace)
      expect(getSubAgentDefinition('first_workspace_agent', first)).toBeDefined()
      expect(getSubAgentDefinition('first_workspace_agent', first)?.allowedTools).toEqual(['web_search', 'web_fetch'])

      const second = loadDynamicAgents(secondWorkspace)
      expect(getSubAgentDefinition('first_workspace_agent', first)).toBeDefined()
      expect(getSubAgentDefinition('first_workspace_agent', second)).toBeUndefined()
      first.reload(secondWorkspace)
      expect(getSubAgentDefinition('first_workspace_agent', first)).toBeUndefined()
      expect(getSubAgentDefinition('first_workspace_agent')).toBeUndefined()
      expect(getSubAgentDefinition('registered_agent_fixture')).toBeDefined()
    } finally {
      rmSync(firstWorkspace, { recursive: true, force: true })
      rmSync(secondWorkspace, { recursive: true, force: true })
    }
  })
})

