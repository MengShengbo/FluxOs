import { describe, expect, it, vi } from 'vitest'
import type { AgentTool, ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import { executeToolCallBatches, partitionToolCalls } from './toolCallOrchestrator'
import { getToolByName } from '@fluxos/tools/toolRegistry'
import { NodeToolExecutor } from '@fluxos/tools/nodeToolExecutor'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const readTool: AgentTool = {
  access: { source: 'builtin', exposure: 'resident', output: 'ToolResult', resources: [{ kind: 'filesystem', access: 'read', scope: 'workspace' }] },
  name: 'read',
  description: 'read',
  category: 'read',
  parameters: [],
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
}

const writeTool: AgentTool = {
  ...readTool,
  name: 'write',
  category: 'write',
  isReadOnly: false,
  isConcurrencySafe: false,
}

const calls: ToolCall[] = [
  { id: 'read-1', name: 'read', arguments: {} },
  { id: 'read-2', name: 'read', arguments: {} },
  { id: 'write-1', name: 'write', arguments: {} },
  { id: 'read-3', name: 'read', arguments: {} },
]

function result(toolCall: ToolCall): ToolResult {
  return { toolCallId: toolCall.id, name: toolCall.name, output: 'ok', isError: false }
}

describe('tool call orchestration', () => {
  it('executes same-file shell writes in order through the real executor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shell-order-'))
    const executor = new NodeToolExecutor(root, { capabilityProfile: 'danger-full-access' })
    const writes: ToolCall[] = [
      { id: 'first', name: 'run_command', arguments: { command: 'echo first > same.txt' } },
      { id: 'second', name: 'run_command', arguments: { command: 'echo second > same.txt' } },
    ]
    const batches = partitionToolCalls(writes, {
      resolveTool: getToolByName,
      isWrite: call => getToolByName(call.name)?.isReadOnly === false,
      isReadAfterWriteSensitive: () => false,
    })
    const observed: string[] = []
    let active = 0
    const execute = async (call: ToolCall) => {
      expect(++active).toBe(1)
      try {
        const execution = await executor.runCommand(String(call.arguments.command), root, {}, 30_000, true)
        expect(execution.success).toBe(true)
        expect(execution.data?.exitCode).toBe(0)
        observed.push(readFileSync(join(root, 'same.txt'), 'utf8').replaceAll('\0', '').trim())
        return result(call)
      } finally { active-- }
    }
    try {
      await executeToolCallBatches(writes, {
        batches, isAborted: () => false, executeSerial: execute,
        executeConcurrent: calls => Promise.all(calls.map(execute)),
        createCancelled: call => ({ ...result(call), isError: true, errorKind: 'abort' }),
      })
      expect(observed[0]).toContain('first')
      expect(observed[1]).toContain('second')
    } finally {
      await executor.ptyKillAll()
      rmSync(root, { recursive: true, force: true })
    }
  }, 65_000)

  it('uses production metadata to serialize shell writes and retain structured read batches', async () => {
    const toolCalls: ToolCall[] = [
      { id: 'read-before-a', name: 'read_file', arguments: { path: 'a.txt' } },
      { id: 'read-before-b', name: 'read_file', arguments: { path: 'b.txt' } },
      { id: 'write-a', name: 'run_command', arguments: { command: 'echo first > same.txt' } },
      { id: 'write-b', name: 'run_command', arguments: { command: 'echo second > same.txt' } },
      { id: 'read-after-a', name: 'read_file', arguments: { path: 'same.txt' } },
      { id: 'read-after-b', name: 'list_directory', arguments: { path: '.' } },
    ]
    const batches = partitionToolCalls(toolCalls, {
      resolveTool: getToolByName,
      isWrite: call => getToolByName(call.name)?.isReadOnly === false,
      isReadAfterWriteSensitive: call => ['read_file', 'list_directory'].includes(call.name),
    })
    expect(batches.map(batch => batch.toolCalls.map(call => call.id))).toEqual([
      ['read-before-a', 'read-before-b'], ['write-a'], ['write-b'], ['read-after-a', 'read-after-b'],
    ])
    let activeWriters = 0
    const order: string[] = []
    const results = await executeToolCallBatches(toolCalls, {
      batches,
      isAborted: () => false,
      executeSerial: async call => {
        expect(++activeWriters).toBe(1)
        order.push(`start:${call.id}`)
        await Promise.resolve()
        order.push(`end:${call.id}`)
        activeWriters--
        return result(call)
      },
      executeConcurrent: async calls => {
        expect(calls.every(call => getToolByName(call.name)?.isReadOnly)).toBe(true)
        expect(activeWriters).toBe(0)
        order.push(calls.map(call => call.id).join(','))
        return calls.map(result)
      },
      createCancelled: call => ({ ...result(call), isError: true, errorKind: 'abort' }),
    })
    expect(results).toHaveLength(toolCalls.length)
    expect(order).toEqual(['read-before-a,read-before-b', 'start:write-a', 'end:write-a', 'start:write-b', 'end:write-b', 'read-after-a,read-after-b'])
  })

  it('keeps reads parallel on each side of a completed write', () => {
    const batches = partitionToolCalls([...calls, { id: 'read-4', name: 'read', arguments: {} }], {
      resolveTool: name => name === 'write' ? writeTool : readTool,
      isWrite: toolCall => toolCall.name === 'write',
      isReadAfterWriteSensitive: toolCall => toolCall.name === 'read',
    })

    expect(batches.map(batch => ({
      safe: batch.isConcurrencySafe,
      ids: batch.toolCalls.map(toolCall => toolCall.id),
    }))).toEqual([
      { safe: true, ids: ['read-1', 'read-2'] },
      { safe: false, ids: ['write-1'] },
      { safe: true, ids: ['read-3', 'read-4'] },
    ])
  })

  it('separates sensitive reads from a concurrency-safe write', () => {
    const batches = partitionToolCalls([...calls, { id: 'read-4', name: 'read', arguments: {} }], {
      resolveTool: name => name === 'write' ? { ...writeTool, isConcurrencySafe: true } : readTool,
      isWrite: toolCall => toolCall.name === 'write',
      isReadAfterWriteSensitive: toolCall => toolCall.name === 'read',
    })

    expect(batches.map(batch => batch.toolCalls.map(call => call.id))).toEqual([
      ['read-1', 'read-2', 'write-1'],
      ['read-3', 'read-4'],
    ])
  })

  it('runs safe batches concurrently and fills cancellation results after abort', async () => {
    let aborted = false
    const executeConcurrent = vi.fn(async (batch: ToolCall[]) => {
      aborted = true
      return batch.map(result)
    })
    const executeSerial = vi.fn(async (toolCall: ToolCall) => result(toolCall))

    const results = await executeToolCallBatches(calls, {
      batches: [
        { isConcurrencySafe: true, toolCalls: calls.slice(0, 2) },
        { isConcurrencySafe: false, toolCalls: calls.slice(2) },
      ],
      isAborted: () => aborted,
      executeSerial,
      executeConcurrent,
      createCancelled: toolCall => ({
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: 'cancelled',
        isError: true,
        errorKind: 'abort',
      }),
    })

    expect(executeConcurrent).toHaveBeenCalledOnce()
    expect(executeSerial).not.toHaveBeenCalled()
    expect(results.map(item => [item.toolCallId, item.errorKind])).toEqual([
      ['read-1', undefined],
      ['read-2', undefined],
      ['write-1', 'abort'],
      ['read-3', 'abort'],
    ])
  })
})
