import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadAgentsFromDir, normalizeSubAgentConfig } from './loader'

const newline = String.fromCharCode(10)

function writeAgent(workspacePath: string, name: string, frontmatterLines: string[]): void {
  const agentsDir = path.join(workspacePath, '.turboflux', 'agents')
  mkdirSync(agentsDir, { recursive: true })
  const content = ['---', ...frontmatterLines, '---', 'Agent body', ''].join(newline)
  writeFileSync(path.join(agentsDir, name + '.md'), content)
}

describe('subagent config normalization', () => {
  it('loads valid project agents and rejects invalid limits or tool references at load time', () => {
    const workspacePath = mkdtempSync(path.join(tmpdir(), 'turboflux-agent-loader-'))
    try {
      writeAgent(workspacePath, 'valid', [
        'name: valid',
        'description: Valid agent',
        'maxTurns: 5',
        'maxParallel: 2',
        'maxOutputTokens: 4096',
        'requestTimeoutMs: 30000',
        'tools: ["read_file"]',
        'requiredToolCalls: {"read_file":1}',
      ])
      expect(loadAgentsFromDir(workspacePath)).toHaveLength(1)

      writeAgent(workspacePath, 'bad_turns', ['name: bad_turns', 'description: Bad turns', 'maxTurns: 0'])
      expect(() => loadAgentsFromDir(workspacePath)).toThrow('maxTurns')
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('rejects unknown tools and completion gates outside the allowed tool set', () => {
    expect(() => normalizeSubAgentConfig({ allowedTools: ['not_a_tool'] }, 'Agent x')).toThrow('unknown tool')
    expect(() => normalizeSubAgentConfig({ allowedTools: ['read_file'], requiredToolCalls: { web_search: 1 } }, 'Agent x')).toThrow('not present in allowedTools')
    expect(() => normalizeSubAgentConfig({ requiredToolCalls: { read_file: 0 } }, 'Agent x')).toThrow('count for read_file')
  })
})
