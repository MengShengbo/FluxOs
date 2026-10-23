import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createAgentRuntime } from './agentRuntime'
import type { MemoryHistoryHit } from '@fluxos/contracts/memoryTypes'
it('uses the active conversation model with bounded background requests and records memory usage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flux-memory-model-'))
  const hit: MemoryHistoryHit = { id: 'chunk', conversationId: 'c', messageId: 'm', workspaceId: 'w', title: 'Task', kind: 'user', text: '部署端口 43891', offset: 0, digest: 'original', updatedAt: 1, score: 1 }
  const runtime = createAgentRuntime({ workspacePath: root, workspaceName: 'memory-test', runtimeStoragePath: join(root, 'runtime'), memoryRoot: join(root, 'memory'), globalMemoryRoot: join(root, 'global'), memoryWorkspaceId: 'w', delegationEnabled: false, config: { provider: 'custom', apiKey: 'fake-test-key', baseUrl: 'https://example.test/v1', model: 'test-current-model', contextWindow: 200000, maxTokens: 4096 }, memoryHistory: { search: () => [hit], read: () => hit, pending: checkpoints => checkpoints.chunk ? [] : [hit] } })
  try {
    const requests: any[] = []
    runtime.engine.subscribe(event => { if (event.type === 'model:request') requests.push(event.request) })
    const transport = vi.spyOn(runtime.toolExecutor, 'sendMessage').mockImplementation(async (_url, _headers, body, options) => {
      const request = JSON.parse(body)
      expect(request.model).toBe('test-current-model')
      expect(request.max_tokens ?? request.max_completion_tokens).toBe(2000)
      expect(request.tools).toBeUndefined()
      expect(options?.retry).toBe(false)
      return { success: true, data: JSON.stringify({ id: 'memory-response', choices: [{ message: { content: JSON.stringify({ memories: [{ key: 'deploy.port', text: '部署端口 43891', kind: 'fact', sourceIds: ['S1'] }], summaries: [] }) } }], usage: { prompt_tokens: 180, completion_tokens: 40, total_tokens: 220 } }) }
    })
    expect(await runtime.engine.maintainMemory(new AbortController().signal)).toBe(true)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(requests.at(-1)).toMatchObject({ purpose: 'memory', status: 'completed', model: 'test-current-model', usage: { input: 180, output: 40 } })
    expect(runtime.toolExecutor.memoryMaintenanceStatus()?.callsToday).toBe(1)
    expect((await runtime.toolExecutor.memoryQuery({ workspacePath: root, query: '43891' })).data?.items).toHaveLength(1)
    expect(await runtime.engine.maintainMemory(new AbortController().signal)).toBe(false)
  } finally { await runtime.destroy(); rmSync(root, { recursive: true, force: true }) }
})
