import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import type { ToolExecutor } from '@fluxos/contracts/toolExecutor'
import { AgentEngine } from './agentEngine'
import { DefaultAgentStateProvider } from './runtime/stateProvider'
import { NodeToolExecutor } from '@fluxos/tools/nodeToolExecutor'

function harness(workspace = process.cwd(), executor?: ToolExecutor) {
  const runCommand = vi.fn<ToolExecutor['runCommand']>(async () => ({ success: true, data: { stdout: '', stderr: '', exitCode: 0 } }))
  const startBackgroundCommand = vi.fn<NonNullable<ToolExecutor['startBackgroundCommand']>>(async () => ({ success: true, data: {
    sessionId: 'fixture-session', session: { id: 'fixture-session', pid: 0, shell: 'fixture', shellId: 'fixture', shellLabel: 'fixture', cwd: workspace,
      status: 'running', createdAt: 1, updatedAt: 1, isAgentSession: true, title: 'fixture' },
  } }))
  const engine = new AgentEngine({ mode: 'vibe', approvalPolicy: 'full', gitEnabled: false, workspacePath: workspace },
    executor ?? { runCommand, startBackgroundCommand } as unknown as ToolExecutor,
    new DefaultAgentStateProvider({ provider: 'custom', apiKey: 'fixture', baseUrl: 'http://example.test', model: 'test', contextWindow: 100_000, maxTokens: 4096 }, workspace))
  const execute = (engine as unknown as { executeSingleTool(call: ToolCall): Promise<ToolResult> }).executeSingleTool.bind(engine)
  return { engine, runCommand, startBackgroundCommand, execute }
}

describe('command input normalization', () => {
  it('passes Unicode and empty overrides to a real process with host-generated presentation', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fluxagent-env-schema-')))
    const executor = new NodeToolExecutor(root, { capabilityProfile: 'danger-full-access' })
    const h = harness(root, executor)
    try {
      const result = await h.execute({ id: 'real-env', name: 'run_command', arguments: {
        command: 'node -e "process.stdout.write(JSON.stringify([process.env.FLUXAGENT_ENV_FIXTURE, process.env.FLUXAGENT_EMPTY_FIXTURE]))"',
        run_in_background: false,
        env: [{ name: 'FLUXAGENT_ENV_FIXTURE', value: 'earlier' }, { name: 'FLUXAGENT_ENV_FIXTURE', value: '你好 spaced' }, { name: 'FLUXAGENT_EMPTY_FIXTURE', value: '' }],
      } })
      expect(result.isError).toBe(false)
      expect(result.data).toMatchObject({ kind: 'command', stdout: '["你好 spaced",""]', process: { state: 'exited', exitCode: 0 } })
      expect(executor.getRuntimeTaskManager().listTasks({ kind: 'shell' })[0]?.presentation).toMatchObject({ kind: 'work', title: '执行工作步骤' })
    } finally { h.engine.destroy(); rmSync(root, { recursive: true, force: true }) }
  }, 40_000)
  it.each([false, true])('executes background=%s with env entries and no display obligations', async background => {
    const h = harness()
    try {
      const result = await h.execute({ id: 'call', name: 'run_command', arguments: {
        command: 'fixture', run_in_background: background,
        env: [{ name: 'QUERY', value: 'word space' }, { name: 'EMPTY', value: '' }, { name: '__proto__', value: 'literal' }],
      } })
      expect(result.isError).toBe(false)
      const invocation = background ? h.startBackgroundCommand.mock.calls[0]! : h.runCommand.mock.calls[0]!
      const env = invocation[2]!
      expect(env).toEqual(JSON.parse('{"QUERY":"word space","EMPTY":"","__proto__":"literal"}'))
      expect(Object.getPrototypeOf(env)).toBe(Object.prototype)
      const presentation = background ? invocation[4] : invocation[7]
      expect(presentation).toMatchObject({ kind: 'work', title: '执行工作步骤' })
    } finally { h.engine.destroy() }
  })

  it.each([
    [{ display_kind: 'check' }, { kind: 'check', title: '检查执行结果' }],
    [{ display_title: '自定义工作' }, { kind: 'work', title: '自定义工作' }],
    [{ preview_url: 'http://localhost:3000' }, { kind: 'service', title: '运行本地服务' }],
    [{ display_kind: null, display_title: null, env: null }, { kind: 'work', title: '执行工作步骤' }],
  ])('uses structured intent for omitted presentation fields: %j', async (overrides, expected) => {
    const h = harness()
    try {
      const result = await h.execute({ id: 'call', name: 'run_command', arguments: { command: 'fixture', run_in_background: true, ...overrides } })
      expect(result.isError).toBe(false)
      expect(h.startBackgroundCommand.mock.calls[0]![4]).toMatchObject(expected)
    } finally { h.engine.destroy() }
  })

  it('does not execute unsupported dictionaries or missing commands', async () => {
    const h = harness()
    try {
      for (const args of [{ env: [] }, { command: 'fixture', env: { QUERY: 'old format' } }]) {
        const result = await h.execute({ id: 'call', name: 'run_command', arguments: args })
        expect(result).toMatchObject({ isError: true, errorKind: 'validation' })
      }
      expect(h.runCommand).not.toHaveBeenCalled()
      expect(h.startBackgroundCommand).not.toHaveBeenCalled()
    } finally { h.engine.destroy() }
  })
})
