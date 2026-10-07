import { registerAgent } from '../subAgentRegistry'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentRuntime, type AgentRuntime } from './agentRuntime'
import { NodeToolExecutor } from '@fluxos/tools/nodeToolExecutor'
import { childCapabilityProfile, normalizeChildName } from '@fluxos/contracts/childAgentTypes'

const runtimes: AgentRuntime[] = [], workspaces: string[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.destroy()))
  vi.restoreAllMocks()
  for (const path of workspaces.splice(0)) rmSync(path, { force: true, recursive: true })
})
function fixture(path = mkdtempSync(join(tmpdir(), 'tf-child-session-'))) {
  if (!workspaces.includes(path)) workspaces.push(path)
  const runtime = createAgentRuntime({ workspacePath: path, workspaceName: 'fixture', conversationId: 'root-session', connectMcp: false, approvalPolicy: 'full',
    config: { provider: 'custom', apiKey: 'fixture', baseUrl: 'http://example.test', model: 'test-model', contextWindow: 100000, maxTokens: 4096, gitEnabled: false, reasoning: { enabled: true, effort: 'high' } } })
  runtimes.push(runtime)
  const engine = runtime.engine as any
  engine.workExecution.startRun('parent-run', 'Verify child behavior', Date.now())
  return { runtime, engine, path }
}
function streamModel(reply: (input: any) => { text?: string; tools?: Array<{ name: string; args: object }> }) {
  return vi.spyOn(NodeToolExecutor.prototype, 'streamMessage').mockImplementation(async (_url, _headers, body, onLine) => {
    const input = JSON.parse(body)
    const result = input.tool_choice?.function?.name === 'set_response_mode'
      ? { tools: [{ name: 'set_response_mode', args: { mode: 'task' } }] } : reply(input)
    const delta = result.tools ? { tool_calls: result.tools.map((tool, index) => ({ index, id: 'tc-' + Math.random(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) } : { content: result.text }
    onLine('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: result.tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 10 } }))
    onLine('data: [DONE]')
    return { success: true, data: '' }
  })
}
async function spawn(f: ReturnType<typeof fixture>, name: string, mode: 'full' | 'read_only', objective = 'Do the task') {
  const receipt = await f.engine.dispatchTool('spawn_agent', { name, agent_type: 'worker', capability_mode: mode, objective })
  const id = String(receipt).match(/Agent ID: ([\w-]+)/)![1]
  await f.engine.dispatchTool('wait_agents', { agent_ids: [id], mode: 'all', timeout_ms: 3000 })
  return id
}

describe('named shared-runtime children', () => {
  it('keeps names independent of roles and intersects authority', () => {
    expect(normalizeChildName(' 星河 ')).toBe('星河')
    expect(() => normalizeChildName('bad\nname')).toThrow()
    expect(childCapabilityProfile('full', 'read-only')).toBe('read-only')
    expect(childCapabilityProfile('read_only', 'danger-full-access')).toBe('read-only')
  })

  it('uses the full engine to write a real file and preserves transcript, name, color and follow-up identity', async () => {
    const f = fixture()
    streamModel(input => {
      const messages = JSON.stringify(input.messages)
      if (messages.includes('FOLLOW_UP')) {
        expect(messages).toContain('File written and verified')
        return { text: 'Follow-up used my previous result.' }
      }
      if (input.messages.some((m: any) => m.role === 'tool' && m.content?.includes('COMMAND_VERIFIED'))) return { text: 'File written and verified' }
      if (input.messages.some((m: any) => m.role === 'tool' && m.content?.includes('written'))) return { tools: [{ name: 'run_command', args: { command: 'test -s child-output.txt && echo COMMAND_VERIFIED', display_kind: 'check', display_title: '验证子代理产物' } }] }
      return { tools: [{ name: 'write_file', args: { path: 'child-output.txt', content: 'REAL_CHILD_WRITE' } }] }
    })
    const id = await spawn(f, '星河', 'full')
    expect(readFileSync(join(f.path, 'child-output.txt'), 'utf8')).toBe('REAL_CHILD_WRITE')
    const controller = f.engine.getChildAgentController()
    const detail = controller.read(id, 'root-session', 0, 100)
    expect(detail.agent).toMatchObject({ name: '星河', roleId: 'worker', roleLabel: '执行者', mode: 'full', state: 'idle', lastOutcome: 'completed', reasoning: { enabled: true, effort: 'high' } })
    expect(detail.items.some((item: any) => item.kind === 'tool_result' && item.toolResult.name === 'write_file')).toBe(true)
    const followup = f.engine.followupChildAgent(id, 'FOLLOW_UP')
    const executionId = followup.match(/Execution ID: ([\w-]+)/)![1]
    expect(executionId).not.toBe(id)
    await f.runtime.subAgentTaskManager.waitForTasks({ agentIds: [executionId], mode: 'all', timeoutMs: 3000 })
    const next = controller.get(id, 'root-session')
    expect(next.name).toBe('星河'); expect(next.color).toBe(detail.agent.color)
    expect(next.finalText).toContain('Follow-up')
    expect(f.runtime.subAgentTaskManager.listPendingCompletions('root-session', 'parent-run')).toHaveLength(2)
    await f.runtime.destroy()
    const restored = fixture(f.path)
    expect(restored.engine.getChildAgentController().read(id, 'root-session', 0, 100).agent).toMatchObject({ name: '星河', color: next.color, state: 'idle' })
    expect(() => restored.engine.getChildAgentController().read(id, 'another-session')).toThrow('not found')
  })

  it('filters writes and also rejects unoffered writes at execution in read-only mode', async () => {
    const f = fixture()
    const write = vi.spyOn(NodeToolExecutor.prototype, 'writeFile')
    let calls = 0
    streamModel(input => {
      expect(input.tools.some((tool: any) => tool.function?.name === 'write_file')).toBe(false)
      if (++calls === 1) return { tools: [{ name: 'write_file', args: { path: 'forbidden.txt', content: 'no' } }] }
      expect(JSON.stringify(input.messages)).toContain('read-only')
      return { text: 'Read-only mode correctly rejected the requested write.' }
    })
    const id = await spawn(f, '观澜', 'read_only')
    expect(write).not.toHaveBeenCalled()
    const detail = f.engine.getChildAgentController().read(id, 'root-session', 0, 100)
    expect(detail.agent.effectiveCapabilityProfile).toBe('read-only')
    expect(detail.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tool_result', toolResult: expect.objectContaining({ isError: true, errorKind: 'permission' }) })]))
  })

  it('routes child approval to the exact session and resumes the waiting execution', async () => {
    const f = fixture()
    f.engine.setApprovalPolicy('ask')
    streamModel(input => input.messages.some((message: any) => message.role === 'tool' && message.content?.includes('written'))
      ? { text: 'Approved write finished.' } : { tools: [{ name: 'write_file', args: { path: 'approved.txt', content: 'approved' } }] })
    const receipt = await f.engine.dispatchTool('spawn_agent', { name: '问津', agent_type: 'worker', capability_mode: 'full', objective: 'Write after approval' })
    const id = receipt.match(/Agent ID: ([\w-]+)/)![1]
    const controller = f.engine.getChildAgentController()
    await vi.waitFor(() => expect(controller.get(id, 'root-session').pendingRequests).toHaveLength(1))
    const request = controller.get(id, 'root-session').pendingRequests[0]
    expect(() => controller.respond(id, 'wrong-session', request.id, 'allow-once')).toThrow()
    expect(controller.respond(id, 'root-session', request.id, 'allow-once')).toBe(true)
    await f.engine.dispatchTool('wait_agents', { agent_ids: [id], mode: 'all', timeout_ms: 3000 })
    expect(readFileSync(join(f.path, 'approved.txt'), 'utf8')).toBe('approved')
  })

  it('interrupts an active child without destroying its identity and continues it later', async () => {
    const f = fixture()
    let requestStarted!: () => void
    const started = new Promise<void>(resolve => { requestStarted = resolve })
    const mock = vi.spyOn(NodeToolExecutor.prototype, 'streamMessage').mockImplementation(async (_url, _headers, body, onLine, options) => {
      const request = JSON.parse(body)
      if (request.tool_choice?.function?.name === 'set_response_mode') {
        onLine('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'mode', type: 'function', function: { name: 'set_response_mode', arguments: '{"mode":"task"}' } }] }, finish_reason: 'tool_calls' }] }))
        onLine('data: [DONE]'); return { success: true, data: '' }
      }
      requestStarted()
      return new Promise(resolve => options?.signal?.addEventListener('abort', () => resolve({ success: false, error: 'Aborted' }), { once: true }))
    })
    const receipt = await f.engine.dispatchTool('spawn_agent', { name: '停云', agent_type: 'research', capability_mode: 'read_only', objective: 'Wait for interruption' })
    const id = receipt.match(/Agent ID: ([\w-]+)/)![1]
    await started
    f.engine.getChildAgentController().interrupt(id, 'root-session')
    await f.engine.dispatchTool('wait_agents', { agent_ids: [id], mode: 'all', timeout_ms: 3000 })
    expect(f.engine.getChildAgentController().get(id, 'root-session')).toMatchObject({ name: '停云', state: 'idle', lastOutcome: 'interrupted' })
    mock.mockRestore(); streamModel(() => ({ text: 'Continued after interruption.' }))
    const followup = f.engine.followupChildAgent(id, 'Continue now')
    const execution = followup.match(/Execution ID: ([\w-]+)/)![1]
    await f.runtime.subAgentTaskManager.waitForTasks({ agentIds: [execution], mode: 'all', timeoutMs: 3000 })
    expect(f.engine.getChildAgentController().get(id, 'root-session').finalText).toContain('Continued')
  })

  it('borrows MCP tools while enforcing read-only calls and owning child-specific system connections', async () => {
    const f = fixture()
    const writes = vi.fn(async () => 'MCP_WRITE')
    f.runtime.mcpClient.registerLocalServer({ name: 'fixture', tools: [
      { name: 'read', description: 'Read data', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
      { name: 'write', description: 'Write data', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
    ], handler: async name => name === 'write' ? writes() : 'MCP_READ' })
    let round = 0
    streamModel(input => {
      const text = JSON.stringify(input.messages)
      if (text.includes('MCP_READ')) return { text: 'Read succeeded through inherited MCP.' }
      if (++round === 1) return { tools: [{ name: 'fixture__write', args: {} }] }
      return { tools: [{ name: 'fixture__read', args: {} }] }
    })
    const id = await spawn(f, '知微', 'read_only')
    expect(writes).not.toHaveBeenCalled()
    expect(f.engine.getChildAgentController().get(id, 'root-session').finalText).toContain('Read succeeded')
    await f.engine.getChildAgentController().close(id, 'root-session')
    expect(f.runtime.mcpClient.getConnection('fixture')?.status).toBe('connected')
  })

  it('rejects duplicate names without starting another child and keeps a closed session readable', async () => {
    const f = fixture(); streamModel(() => ({ text: 'done' }))
    const id = await spawn(f, '砺石', 'full')
    await expect(spawn(f, '砺石', 'full')).rejects.toThrow('name')
    await f.engine.getChildAgentController().close(id, 'root-session')
    expect(f.engine.getChildAgentController().read(id, 'root-session').agent.state).toBe('closed')
    expect(() => f.engine.followupChildAgent(id, 'more')).toThrow('closed')
  })
  it('rejects unnamed production delegation instead of silently using the old execution loop', async () => {
    const f = fixture()
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(f.engine.dispatchTool('spawn_agent', { agent_type: 'worker', objective: 'No identity' })).rejects.toThrow('name')
    expect(f.runtime.subAgentTaskManager.listTasks()).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('resolves the stable identity to the latest execution for detach, read, wait and retry', async () => {
    const f = fixture(); streamModel(() => ({ text: 'finished' }))
    const id = await spawn(f, '恒星', 'full')
    const firstExecution = f.engine.getChildAgentController().get(id, 'root-session').executionId
    expect(firstExecution).not.toBe(id)
    const followup = f.engine.followupChildAgent(id, 'second execution')
    const execution = followup.match(/Execution ID: ([a-zA-Z0-9_-]+)/)![1]
    await f.runtime.subAgentTaskManager.waitForTasks({ agentIds: [execution], mode: 'all', timeoutMs: 3000 })
    await f.engine.dispatchTool('detach_agent', { agent_id: id })
    expect(f.runtime.subAgentTaskManager.getTask(execution)?.joinPolicy).toBe('detached')
    expect(f.runtime.subAgentTaskManager.getTask(firstExecution)?.joinPolicy).toBe('required')
    const waited = await f.engine.dispatchTool('wait_agents', { agent_ids: [id], include_results: true })
    expect(waited).toContain('finished')
    expect(waited).toContain('- agentId: ' + id)
    expect(waited).toContain('executionId: ' + execution)
    const read = await f.engine.dispatchTool('read_agent', { agent_id: execution })
    expect(JSON.parse(String(read)).agent.agentId).toBe(id)
    expect(JSON.parse(String(read)).agent.executionId).toBe(execution)
    const retry = f.engine.retrySubAgentTask(id)
    await f.runtime.subAgentTaskManager.waitForTasks({ agentIds: [retry.id], mode: 'all', timeoutMs: 3000 })
    const controller = f.engine.getChildAgentController()
    expect(controller.list('root-session')).toHaveLength(1)
    expect(controller.get(id, 'root-session').executionId).toBe(retry.id)
    expect(f.runtime.subAgentTaskManager.getTask(retry.id)?.retryOf).toBe(execution)
  })

  it('fences duplicate concurrent launches before a child record exists', async () => {
    const f = fixture(); streamModel(() => ({ text: 'done' }))
    const launches = await Promise.allSettled([1, 2].map(() => f.engine.dispatchTool('spawn_agent', { name: '同名', agent_type: 'worker', objective: 'Run once' })))
    expect(launches.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(f.runtime.subAgentTaskManager.listTasks()).toHaveLength(1)
  })

  it('closes admission synchronously and shares shutdown without reopening the child', async () => {
    const f = fixture(); streamModel(() => ({ text: 'done' }))
    const id = await spawn(f, '暮云', 'full')
    const controller = f.engine.getChildAgentController()
    const close = controller.close(id, 'root-session')
    expect(controller.close(id, 'root-session')).toBe(close)
    expect(() => f.engine.followupChildAgent(id, 'cannot reopen')).toThrow('closed')
    await close
    expect(controller.get(id, 'root-session').state).toBe('closed')
    const shutdown = controller.destroy()
    expect(controller.destroy()).toBe(shutdown)
    await shutdown
  })

  it('narrows reused child permissions when the parent authority is reduced', async () => {
    const f = fixture(); streamModel(() => ({ text: 'first run complete' }))
    const id = await spawn(f, '守界', 'full')
    f.engine.updateRuntimeConfiguration({ capabilityProfile: 'read-only' })
    vi.restoreAllMocks()
    const write = vi.spyOn(NodeToolExecutor.prototype, 'writeFile')
    let rounds = 0
    streamModel(input => {
      expect(input.tools.some((tool: any) => tool.function?.name === 'write_file')).toBe(false)
      if (++rounds === 1) return { tools: [{ name: 'write_file', args: { path: 'forbidden-followup.txt', content: 'no' } }] }
      return { text: 'continued with reduced permissions' }
    })
    const followup = f.engine.followupChildAgent(id, 'Work with reduced authority')
    const execution = followup.match(/Execution ID: ([a-zA-Z0-9_-]+)/)![1]
    await f.runtime.subAgentTaskManager.waitForTasks({ agentIds: [execution], mode: 'all', timeoutMs: 3000 })
    expect(write).not.toHaveBeenCalled()
    expect(f.engine.getChildAgentController().get(id, 'root-session').effectiveCapabilityProfile).toBe('read-only')
  })
  it('enforces custom role output and tool-round budgets in the shared engine', async () => {
    const f = fixture()
    writeFileSync(join(f.path, 'budget-source.txt'), 'source')
    registerAgent({ id: 'bounded_role_fixture', label: 'Bounded', description: 'Bounded role', systemPrompt: 'Read once', maxTurns: 1, maxParallel: 1, maxOutputTokens: 256 })
    let workingRequests = 0
    streamModel(input => {
      workingRequests++
      expect(input.max_tokens ?? input.max_completion_tokens).toBe(256)
      return { tools: [{ name: 'read_file', args: { path: 'budget-source.txt' } }] }
    })
    const receipt = await f.engine.dispatchTool('spawn_agent', { name: '有界', agent_type: 'bounded_role_fixture', objective: 'Read source' })
    const id = String(receipt).match(/Agent ID: ([a-zA-Z0-9_-]+)/)![1]
    await f.engine.dispatchTool('wait_agents', { agent_ids: [id], timeout_ms: 3000 })
    const child = f.engine.getChildAgentController().get(id, 'root-session')
    expect(workingRequests).toBe(1)
    expect(child.lastOutcome).toBe('partial')
    expect(child.finalText).toContain('Stopped after 1 tool rounds')
  })
  it('rejects a completed-looking answer when role evidence requirements are unmet', async () => {
    const f = fixture(); streamModel(() => ({ text: 'An unverified claim' }))
    registerAgent({ id: 'evidence_role_fixture', label: 'Evidence', description: 'Evidence role', systemPrompt: 'Verify sources', maxTurns: 4, maxParallel: 1, requiredToolCalls: { read_file: 1 } })
    const receipt = await f.engine.dispatchTool('spawn_agent', { name: '求证', agent_type: 'evidence_role_fixture', objective: 'Verify before reporting' })
    const id = String(receipt).match(/Agent ID: ([a-zA-Z0-9_-]+)/)![1]
    await f.engine.dispatchTool('wait_agents', { agent_ids: [id], timeout_ms: 3000 })
    const child = f.engine.getChildAgentController().get(id, 'root-session')
    expect(child.lastOutcome).toBe('partial')
    expect(child.error).toContain('read_file (0/1)')
    expect(f.runtime.subAgentTaskManager.getTask(child.executionId)?.runtimeTask.status).toBe('failed')
  })

  it('aborts a stalled shared-runtime model request at the role deadline', async () => {
    const f = fixture()
    registerAgent({ id: 'deadline_role_fixture', label: 'Deadline', description: 'Deadline role', systemPrompt: 'Finish in time', maxTurns: 4, maxParallel: 1, requestTimeoutMs: 15 })
    vi.spyOn(NodeToolExecutor.prototype, 'streamMessage').mockImplementation(async (_url, _headers, _body, _onLine, options) =>
      new Promise(resolve => {
        if (options?.signal?.aborted) resolve({ success: false, error: 'Aborted' })
        else options?.signal?.addEventListener('abort', () => resolve({ success: false, error: 'Aborted' }), { once: true })
      }))
    const receipt = await f.engine.dispatchTool('spawn_agent', { name: '时限', agent_type: 'deadline_role_fixture', objective: 'Do not hang' })
    const id = String(receipt).match(/Agent ID: ([a-zA-Z0-9_-]+)/)![1]
    await f.engine.dispatchTool('wait_agents', { agent_ids: [id], timeout_ms: 3000 })
    const child = f.engine.getChildAgentController().get(id, 'root-session')
    expect(child).toMatchObject({ state: 'idle', lastOutcome: 'failed' })
    expect(child.error).toContain('model request timed out after 15ms')
    expect(f.runtime.subAgentTaskManager.getTask(child.executionId)?.runtimeTask.status).toBe('failed')
  })
})
