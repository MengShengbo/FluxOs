import { SubAgentTelemetry } from '../subAgentTelemetry'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RuntimeTask, RuntimeTaskKind, RuntimeTaskStatus } from '@fluxagentcore/contracts/runtimeTaskTypes'
import type { RuntimeTaskManager } from '@fluxagentcore/tools/runtimeTaskManager'

import {
  SubAgentCompletionCoordinator,
  type SubAgentCompletionResult,
  type SubAgentCompletionDelivery,
  type SubAgentCompletionStats,
  type SubAgentCompletionStatus,
  type SubAgentJoinPolicy,
} from '../subAgentCompletionCoordinator'

export interface SubAgentTaskDescriptor {
  id: string
  kind: Extract<RuntimeTaskKind, 'agent'>
  agentType: string
  label: string
  objective: string
  workspacePath: string
  ownerSessionId?: string
  joinPolicy: SubAgentJoinPolicy
  workRunId?: string
  stepId?: string
  startedAt: number
  transcriptPath: string
  retryOf?: string
  agentSessionId?: string
  namedAgent?: boolean
}

export interface SubAgentTaskSnapshot extends SubAgentTaskDescriptor {
  runtimeTask: RuntimeTask
  result?: unknown
  stats?: SubAgentCompletionStats
}

export type SubAgentTranscriptRecord =
  | { version: 1; type: 'start'; timestamp: number; task: SubAgentTaskDescriptor }
  | { version: 1; type: 'event'; timestamp: number; event: unknown }
  | { version: 1; type: 'result'; timestamp: number; status: 'completed' | 'failed' | 'stopped'; result?: unknown; error?: string }
  | { version: 1; type: 'state'; timestamp: number; status: RuntimeTaskStatus; error?: string }
  | { version: 1; type: 'join_policy'; timestamp: number; joinPolicy: SubAgentJoinPolicy }

export interface StartSubAgentTaskContext {
  taskId: string
  signal: AbortSignal
  recordEvent: (event: unknown) => void
}

export interface StartSubAgentTaskInput<TResult> {
  kind: Extract<RuntimeTaskKind, 'agent'>
  agentType: string
  label: string
  objective: string
  workspacePath: string
  ownerSessionId?: string
  retryOf?: string
  agentSessionId?: string
  namedAgent?: boolean
  joinPolicy?: SubAgentJoinPolicy
  controller?: AbortController
  timeoutMs?: number
  /** Shared runtimes retain ownership until their abort cleanup settles. */
  drainOnStop?: boolean
  workRunId?: string
  stepId?: string
  run: (context: StartSubAgentTaskContext) => Promise<TResult>
  isSuccess?: (result: TResult) => boolean
  getError?: (result: TResult) => string | undefined
}

export interface StartedSubAgentTask<TResult> {
  task: RuntimeTask
  promise: Promise<TResult>
}

export interface ReadSubAgentTranscriptOptions {
  offset?: number
  limit?: number
}

export interface ReadSubAgentTranscriptResult {
  records: SubAgentTranscriptRecord[]
  offset: number
  nextOffset: number
  total: number
}

export type WaitSubAgentStatus = 'completed' | 'failed' | 'stopped' | 'interrupted' | 'still_running'

export interface WaitSubAgentsOptions {
  agentIds?: string[]
  mode: 'all' | 'any'
  timeoutMs?: number
  includeResults?: boolean
  ownerSessionId?: string
  workRunId?: string
  signal?: AbortSignal
}

export interface WaitSubAgentSnapshot {
  agentId: string
  agentType: string
  objective: string
  status: WaitSubAgentStatus
  runtimeStatus: RuntimeTaskStatus
  joinPolicy: SubAgentJoinPolicy
  elapsedMs: number
  finalText?: string
  error?: string
  evidenceCount: number
  turns: number
  stats?: SubAgentCompletionStats
}

export interface WaitSubAgentsResult {
  mode: 'all' | 'any'
  timedOut: boolean
  elapsedMs: number
  agents: WaitSubAgentSnapshot[]
}

export interface SubAgentTaskManagerOptions {
  workspacePath: string
  runtimeTaskManager: RuntimeTaskManager
  ownerSessionId?: string
  storageDir?: string | false
  now?: () => number
  maxTranscriptEventBytes?: number
  maxRetainedTasks?: number
  maxPendingResults?: number
  maxPendingCompletionBytes?: number
}

const TERMINAL_STATUSES = new Set<RuntimeTaskStatus>(['completed', 'failed', 'stopped', 'interrupted', 'orphaned'])
const DEFAULT_MAX_TRANSCRIPT_EVENT_BYTES = 512 * 1024
const DEFAULT_MAX_RETAINED_TASKS = 128

function sanitizeTranscriptValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => sanitizeTranscriptValue(item))
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const isEvidence = typeof source.path === 'string'
    && typeof source.startLine === 'number'
    && typeof source.endLine === 'number'
    && typeof source.reason === 'string'
  return Object.fromEntries(Object.entries(source)
    .filter(([key]) => !(isEvidence && key === 'content'))
    .map(([key, item]) => [key, sanitizeTranscriptValue(item)]))
}

export function sanitizeSubAgentTranscriptRecord(record: SubAgentTranscriptRecord): SubAgentTranscriptRecord {
  return sanitizeTranscriptValue(record) as SubAgentTranscriptRecord
}

function isRuntimeTaskStatus(value: unknown): value is RuntimeTaskStatus {
  return ['starting', 'running', 'stopping', 'completed', 'failed', 'stopped', 'interrupted', 'orphaned'].includes(String(value))
}

function parseTranscript(content: string): SubAgentTranscriptRecord[] {
  const records: SubAgentTranscriptRecord[] = []
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as SubAgentTranscriptRecord
      if (record?.version === 1 && typeof record.type === 'string') records.push(record)
    } catch {
      continue
    }
  }
  return records
}

export class SubAgentTaskManager {
  private readonly runtimeTaskManager: RuntimeTaskManager
  private ownerSessionId?: string
  private storageDir: string | null
  private readonly now: () => number
  private readonly descriptors = new Map<string, SubAgentTaskDescriptor>()
  private readonly results = new Map<string, unknown>()
  private readonly telemetry = new Map<string, SubAgentTelemetry>()
  private readonly taskStats = new Map<string, SubAgentCompletionStats>()
  private readonly outputBytes = new Map<string, number>()
  private readonly eventBytes = new Map<string, number>()
  private readonly maxTranscriptEventBytes: number
  private readonly maxRetainedTasks: number
  private completionCoordinator: SubAgentCompletionCoordinator
  private readonly waitAbortController = new AbortController()
  private readonly unsubscribeRuntimeTasks: () => void
  private sequence = 0
  private destroyed = false
  private shutdownPromise: Promise<void> | null = null

  constructor(private readonly options: SubAgentTaskManagerOptions) {
    this.runtimeTaskManager = options.runtimeTaskManager
    this.ownerSessionId = options.ownerSessionId
    this.storageDir = options.storageDir === false
      ? null
      : options.storageDir || path.join(options.workspacePath, '.fluxagent', 'runtime-agents')
    this.now = options.now || Date.now
    this.maxTranscriptEventBytes = Math.max(1024, Math.floor(options.maxTranscriptEventBytes || DEFAULT_MAX_TRANSCRIPT_EVENT_BYTES))
    this.maxRetainedTasks = Number.isFinite(options.maxRetainedTasks)
      ? Math.max(1, Math.floor(options.maxRetainedTasks!))
      : DEFAULT_MAX_RETAINED_TASKS
    this.completionCoordinator = new SubAgentCompletionCoordinator({
      storageDir: this.storageDir || false,
      now: this.now,
      maxPendingResults: options.maxPendingResults,
      maxPendingBytes: options.maxPendingCompletionBytes,
    })
    if (this.storageDir) {
      mkdirSync(this.storageDir, { recursive: true })
      this.recoverTranscripts()
    }
    this.unsubscribeRuntimeTasks = this.runtimeTaskManager.subscribe(event => {
      if (event.type === 'runtime-task:removed') {
        this.releaseTask(event.taskId)
        return
      }
      if (event.type !== 'runtime-task:finished' || !this.descriptors.has(event.task.id)) return
      this.appendRecord(event.task.id, {
        version: 1,
        type: 'state',
        timestamp: this.now(),
        status: event.task.status,
        error: event.task.error,
      })
      this.captureCompletion(event.task.id)
      this.pruneTerminalTasks()
    })
  }

  setOwnerSessionId(ownerSessionId: string): void {
    this.ownerSessionId = ownerSessionId
  }

  switchSession(ownerSessionId: string, storageDir?: string | false): void {
    const activeTask = Array.from(this.descriptors.keys())
      .map(taskId => this.runtimeTaskManager.getTask(taskId))
      .find((task): task is RuntimeTask => task !== null
        && task.ownerSessionId === this.ownerSessionId
        && !TERMINAL_STATUSES.has(task.status))
    if (activeTask) throw new Error('Cannot switch conversations while subagent tasks are active')
    this.ownerSessionId = ownerSessionId
    this.storageDir = storageDir === false
      ? null
      : storageDir || path.join(this.options.workspacePath, '.fluxagent', 'runtime-agents')
    this.descriptors.clear()
    this.results.clear()
    this.taskStats.clear()
    this.telemetry.clear()
    this.outputBytes.clear()
    this.eventBytes.clear()
    this.completionCoordinator.switchStorage(this.storageDir || false)
    this.sequence = 0
    if (this.storageDir) {
      mkdirSync(this.storageDir, { recursive: true })
      this.recoverTranscripts()
    }
  }

  getOwnerSessionId(): string | undefined {
    return this.ownerSessionId
  }

  setExecutionContext(context: { runId?: string; stepId?: string } | null): void {
    this.runtimeTaskManager.setExecutionContext(context)
  }

  startTask<TResult>(input: StartSubAgentTaskInput<TResult>): StartedSubAgentTask<TResult> {
    if (this.destroyed || this.shutdownPromise) throw new Error('Subagent task manager is destroyed or shutting down')
    const startedAt = this.now()
    const id = this.generateId(input.kind, startedAt)
    const transcriptPath = this.storageDir ? path.join(this.storageDir, `${id}.jsonl`) : ''
    const descriptor: SubAgentTaskDescriptor = {
      id,
      kind: input.kind,
      agentType: input.agentType,
      label: input.label,
      objective: input.objective,
      workspacePath: input.workspacePath,
      ownerSessionId: input.ownerSessionId || this.ownerSessionId,
      joinPolicy: input.joinPolicy || 'required',
      workRunId: input.workRunId,
      stepId: input.stepId,
      startedAt,
      transcriptPath,
      retryOf: input.retryOf,
      agentSessionId: input.namedAgent ? input.agentSessionId || id : undefined,
    }
    this.descriptors.set(id, descriptor)
    this.appendRecord(id, { version: 1, type: 'start', timestamp: startedAt, task: descriptor })

    const controller = input.controller || new AbortController()
    let resolveExecutionSettled!: () => void
    const executionSettled = new Promise<void>(resolve => { resolveExecutionSettled = resolve })
    const task = this.runtimeTaskManager.createTask({
      id,
      kind: input.kind,
      ownerSessionId: descriptor.ownerSessionId,
      status: 'starting',
      command: input.objective,
      cwd: input.workspacePath,
      startedAt,
      interactive: false,
      restartPolicy: 'never',
      metadata: {
        agentType: input.agentType,
        label: input.label,
        transcriptPath: transcriptPath || undefined,
        retryOf: input.retryOf,
        agentSessionId: input.namedAgent ? input.agentSessionId || id : undefined,
        workRunId: input.workRunId,
        stepId: input.stepId,
      },
    }, {
      stop: () => {
        controller.abort()
        return input.drainOnStop ? executionSettled : undefined
      },
    })
    this.runtimeTaskManager.markRunning(id, {
      logPath: transcriptPath || undefined,
      outputBytes: this.outputBytes.get(id) || 0,
      outputOffset: this.outputBytes.get(id) || 0,
    })

    const runPromise = Promise.resolve().then(() => input.run({
      taskId: id,
      signal: controller.signal,
      recordEvent: event => this.appendRecord(id, {
        version: 1,
        type: 'event',
        timestamp: this.now(),
        event,
      }),
    }))
    const runSettled = runPromise.then(() => undefined, () => undefined)
    let timedOut = false
    const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? Math.floor(input.timeoutMs) : 0
    let timeout: ReturnType<typeof setTimeout> | undefined
    const boundedRun = timeoutMs > 0
      ? Promise.race([
          runPromise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              timedOut = true
              if (input.drainOnStop) this.runtimeTaskManager.updateTask(id, { metadata: { cleanupPending: true, terminationReason: 'timeout' } })
              reject(new Error(`${input.label} timed out after ${timeoutMs}ms`))
              controller.abort()
            }, timeoutMs)
          }),
        ])
      : runPromise
    const promise = boundedRun.catch(async error => {
      if (timedOut && input.drainOnStop) await runSettled
      throw error
    }).finally(() => {
      if (timeout) clearTimeout(timeout)
    }).then(result => {
      const succeeded = input.isSuccess ? input.isSuccess(result) : true
      const error = succeeded ? undefined : input.getError?.(result) || 'Subagent failed'
      const currentStatus = this.runtimeTaskManager.getTask(id)?.status
      const stopped = !timedOut && controller.signal.aborted && (currentStatus === 'stopping' || currentStatus === 'stopped')
      this.results.set(id, result)
      this.appendRecord(id, {
        version: 1,
        type: 'result',
        timestamp: this.now(),
        status: stopped ? 'stopped' : succeeded ? 'completed' : 'failed',
        result,
        error,
      })
      if (stopped) this.runtimeTaskManager.markStopped(id, error)
      else if (succeeded) this.runtimeTaskManager.completeTask(id)
      else this.runtimeTaskManager.failTask(id, error || 'Subagent failed')
      return result
    }, error => {
      const message = error instanceof Error ? error.message : String(error)
      const currentStatus = this.runtimeTaskManager.getTask(id)?.status
      const stopped = !timedOut && controller.signal.aborted && (currentStatus === 'stopping' || currentStatus === 'stopped')
      this.appendRecord(id, {
        version: 1,
        type: 'result',
        timestamp: this.now(),
        status: stopped ? 'stopped' : 'failed',
        error: message,
      })
      if (stopped) this.runtimeTaskManager.markStopped(id, message)
      else this.runtimeTaskManager.failTask(id, message, { metadata: { cleanupPending: false } })
      throw error
    })
    void promise.then(resolveExecutionSettled, resolveExecutionSettled)
    return { task: this.runtimeTaskManager.getTask(task.id) || task, promise }
  }

  getTask(taskId: string): SubAgentTaskSnapshot | null {
    const descriptor = this.descriptors.get(taskId)
    const runtimeTask = this.runtimeTaskManager.getTask(taskId)
    if (!descriptor || !runtimeTask) return null
    return {
      ...descriptor,
      runtimeTask,
      result: this.results.get(taskId),
      stats: this.taskStats.get(taskId),
    }
  }

  listTasks(): SubAgentTaskSnapshot[] {
    return Array.from(this.descriptors.keys())
      .map(taskId => this.getTask(taskId))
      .filter((task): task is SubAgentTaskSnapshot => Boolean(task))
      .sort((left, right) => left.startedAt - right.startedAt)
  }

  listPendingCompletions(ownerSessionId?: string, workRunId?: string): SubAgentCompletionResult[] {
    return this.completionCoordinator.listPending(ownerSessionId, workRunId)
  }

  pendingCompletionBytes(ownerSessionId?: string, workRunId?: string): number {
    return this.completionCoordinator.pendingBytes(ownerSessionId, workRunId)
  }

  takePendingCompletions(
    ownerSessionId?: string,
    workRunId?: string,
    options: { maxResults?: number; maxBytes?: number } = {},
  ): SubAgentCompletionResult[] {
    return this.completionCoordinator.take({ ownerSessionId, workRunId, ...options })
  }

  commitCompletionDelivery(delivery: SubAgentCompletionDelivery): void {
    this.completionCoordinator.commitDelivery(delivery)
  }

  listCompletionDeliveries(ownerSessionId: string, workRunId: string): SubAgentCompletionDelivery[] {
    return this.completionCoordinator.listDeliveries(ownerSessionId, workRunId)
  }

  getRequiredUnfinished(ownerSessionId?: string, workRunId?: string): SubAgentTaskSnapshot[] {
    return this.listTasks()
      .filter(task => task.joinPolicy === 'required')
      .filter(task => ownerSessionId === undefined || task.ownerSessionId === ownerSessionId)
      .filter(task => workRunId === undefined || task.workRunId === workRunId || task.runtimeTask.metadata?.workRunId === workRunId)
      .filter(task => !TERMINAL_STATUSES.has(task.runtimeTask.status))
  }

  setJoinPolicy(taskId: string, joinPolicy: SubAgentJoinPolicy): SubAgentTaskSnapshot {
    const descriptor = this.descriptors.get(taskId)
    if (!descriptor) throw new Error('Subagent task not found: ' + taskId)
    descriptor.joinPolicy = joinPolicy
    const runtimeTask = this.runtimeTaskManager.getTask(taskId)
    if (runtimeTask) this.runtimeTaskManager.updateTask(taskId, { metadata: { joinPolicy } })
    this.appendRecord(taskId, {
      version: 1,
      type: 'join_policy',
      timestamp: this.now(),
      joinPolicy,
    })
    return this.getTask(taskId) as SubAgentTaskSnapshot
  }

  readTranscript(taskId: string, options: ReadSubAgentTranscriptOptions = {}): ReadSubAgentTranscriptResult {
    const descriptor = this.descriptors.get(taskId)
    if (!descriptor) throw new Error(`Subagent task not found: ${taskId}`)
    const allRecords = descriptor.transcriptPath && existsSync(descriptor.transcriptPath)
      ? parseTranscript(readFileSync(descriptor.transcriptPath, 'utf8'))
      : []
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit || 20)))
    const requestedOffset = options.offset === undefined
      ? Math.max(0, allRecords.length - limit)
      : Math.max(0, Math.min(allRecords.length, Math.floor(options.offset)))
    const records = allRecords.slice(requestedOffset, requestedOffset + limit)
    return {
      records,
      offset: requestedOffset,
      nextOffset: requestedOffset + records.length,
      total: allRecords.length,
    }
  }

  async waitForTasks(options: WaitSubAgentsOptions): Promise<WaitSubAgentsResult> {
    if (this.destroyed || this.waitAbortController.signal.aborted || options.signal?.aborted) {
      const error = new Error('Subagent wait aborted')
      error.name = 'AbortError'
      throw error
    }
    const startedAt = this.now()
    const targetIds = options.agentIds && options.agentIds.length > 0
      ? [...new Set(options.agentIds.map(id => String(id).trim()).filter(Boolean))]
      : null
    let targets: SubAgentTaskSnapshot[]
    if (targetIds) {
      targets = targetIds.map(taskId => this.getTask(taskId)).filter((task): task is SubAgentTaskSnapshot => task !== null)
      if (targets.length !== targetIds.length) {
        const found = new Set(targets.map(task => task.id))
        const missing = targetIds.filter(taskId => !found.has(taskId))
        throw new Error('Unknown subagent task(s): ' + missing.join(', '))
      }
      for (const task of targets) {
        if (options.ownerSessionId !== undefined && task.ownerSessionId !== options.ownerSessionId) {
          throw new Error('Cannot wait on a subagent from another conversation: ' + task.id)
        }
        if (options.workRunId !== undefined && task.workRunId !== options.workRunId && task.runtimeTask.metadata?.workRunId !== options.workRunId) {
          throw new Error('Cannot wait on a subagent from another run: ' + task.id)
        }
      }
    } else {
      targets = this.listTasks()
        .filter(task => options.ownerSessionId === undefined || task.ownerSessionId === options.ownerSessionId)
        .filter(task => options.workRunId === undefined || task.workRunId === options.workRunId || task.runtimeTask.metadata?.workRunId === options.workRunId)
    }
    if (targets.length === 0) {
      return { mode: options.mode, timedOut: false, elapsedMs: this.now() - startedAt, agents: [] }
    }
    const snapshots = (): WaitSubAgentSnapshot[] => targets
      .map(task => this.getTask(task.id))
      .filter((task): task is SubAgentTaskSnapshot => task !== null)
      .map(task => this.createWaitSnapshot(task, options.includeResults === true))
    const done = (items: WaitSubAgentSnapshot[]): boolean => options.mode === 'all'
      ? items.every(item => item.status !== 'still_running')
      : items.some(item => item.status !== 'still_running')
    const initial = snapshots()
    if (done(initial)) {
      return { mode: options.mode, timedOut: false, elapsedMs: this.now() - startedAt, agents: initial }
    }
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, Math.floor(options.timeoutMs || 0)) : 120_000
    if (timeoutMs <= 0) {
      return { mode: options.mode, timedOut: true, elapsedMs: this.now() - startedAt, agents: initial }
    }
    return new Promise<WaitSubAgentsResult>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let unsubscribe = () => {}
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        unsubscribe()
        options.signal?.removeEventListener('abort', onAbort)
        this.waitAbortController.signal.removeEventListener('abort', onAbort)
      }
      const finish = (timedOut: boolean) => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ mode: options.mode, timedOut, elapsedMs: this.now() - startedAt, agents: snapshots() })
      }
      const tick = () => {
        if (settled) return
        if (done(snapshots())) finish(false)
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        const error = new Error('Subagent wait aborted')
        error.name = 'AbortError'
        reject(error)
      }
      if (options.signal?.aborted) {
        onAbort()
        return
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.waitAbortController.signal.addEventListener('abort', onAbort, { once: true })
      unsubscribe = this.runtimeTaskManager.subscribe(event => {
        if (event.type === 'runtime-task:removed' || event.type === 'runtime-task:updated' || event.type === 'runtime-task:finished') tick()
      })
      timer = setTimeout(() => finish(true), timeoutMs)
      tick()
    })
  }

  async stopTask(taskId: string, reason = 'Subagent cancelled by request'): Promise<RuntimeTask> {
    if (!this.descriptors.has(taskId)) throw new Error(`Subagent task not found: ${taskId}`)
    return this.runtimeTaskManager.stopTask(taskId, reason)
  }

  async stopAll(reason = 'Parent agent cancelled', options: { includeDetached?: boolean; ownerSessionId?: string; workRunId?: string } = {}): Promise<void> {
    await Promise.resolve()
    const pending = Array.from(this.descriptors.values())
      .filter(descriptor => options.includeDetached === true || descriptor.joinPolicy === 'required')
      .filter(descriptor => options.ownerSessionId === undefined || descriptor.ownerSessionId === options.ownerSessionId)
      .filter(descriptor => options.workRunId === undefined || descriptor.workRunId === options.workRunId)
      .map(descriptor => this.runtimeTaskManager.getTask(descriptor.id))
      .filter((task): task is RuntimeTask => task !== null && !TERMINAL_STATUSES.has(task.status))
    await Promise.all(pending.map(task => this.runtimeTaskManager.stopTask(task.id, reason).catch(() => undefined)))
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.waitAbortController.abort()
    this.shutdownPromise = Promise.resolve().then(async () => {
      try { await this.stopAll('Subagent task manager shut down', { includeDetached: true }) }
      finally { this.destroy() }
    })
    return this.shutdownPromise
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.waitAbortController.abort()
    this.completionCoordinator.destroy()
    for (const descriptor of this.descriptors.values()) {
      const task = this.runtimeTaskManager.getTask(descriptor.id)
      if (!task || TERMINAL_STATUSES.has(task.status)) continue
      void this.runtimeTaskManager.stopTask(descriptor.id, 'Subagent task manager destroyed').catch(() => {})
    }
    this.unsubscribeRuntimeTasks()
    this.descriptors.clear()
    this.results.clear()
    this.taskStats.clear()
    this.telemetry.clear()
    this.outputBytes.clear()
    this.eventBytes.clear()
  }

  private createWaitSnapshot(task: SubAgentTaskSnapshot, includeResults: boolean): WaitSubAgentSnapshot {
    const runtime = task.runtimeTask
    const result = task.result as { finalText?: string; error?: string; evidence?: unknown[]; turns?: number; stats?: SubAgentCompletionStats } | undefined
    const status: WaitSubAgentStatus = runtime.status === 'completed'
      ? 'completed'
      : runtime.status === 'failed'
        ? 'failed'
        : runtime.status === 'stopped'
          ? 'stopped'
          : runtime.status === 'interrupted' || runtime.status === 'orphaned'
            ? 'interrupted'
            : 'still_running'
    return {
      agentId: task.id,
      agentType: task.agentType,
      objective: task.objective,
      status,
      runtimeStatus: runtime.status,
      joinPolicy: task.joinPolicy,
      elapsedMs: Math.max(0, (runtime.endedAt || this.now()) - task.startedAt),
      finalText: includeResults && typeof result?.finalText === 'string' ? result.finalText.slice(0, 2_000) : undefined,
      error: includeResults ? (runtime.error || (typeof result?.error === 'string' ? result.error : undefined))?.slice(0, 1_000) : undefined,
      evidenceCount: Array.isArray(result?.evidence) ? result.evidence.length : 0,
      turns: Number(result?.turns || 0) || 0,
      stats: result?.stats,
    }
  }

  private captureCompletion(taskId: string): void {
    const task = this.getTask(taskId)
    if (!task) return
    const status = this.toCompletionStatus(task.runtimeTask.status)
    if (!status) return
    const descriptor = this.descriptors.get(taskId)
    if (!descriptor) return
    const result = task.result as { finalText?: string; error?: string; evidence?: unknown[]; turns?: number } | undefined
    const stats = { ...(this.taskStats.get(taskId) || this.buildCompletionStats(this.readAllRecords(taskId))) }
    stats.turns = Math.max(stats.turns, Number(result?.turns || 0) || 0)
    this.taskStats.set(taskId, stats)
    const evidence = (Array.isArray(result?.evidence) ? result.evidence : []).slice(0, 6).map(item => {
      const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      return {
        path: typeof value.path === 'string' ? value.path : '',
        startLine: Number(value.startLine || 0) || 0,
        endLine: Number(value.endLine || 0) || 0,
        preview: typeof value.preview === 'string' ? value.preview.slice(0, 500) : '',
        reason: typeof value.reason === 'string' ? value.reason.slice(0, 300) : '',
        kind: value.kind as never,
      }
    })
    const finalText = typeof result?.finalText === 'string'
      ? result.finalText.slice(0, 4_000)
      : undefined
    const completion: SubAgentCompletionResult = {
      id: 'completion_' + taskId,
      agentId: taskId,
      agentType: task.agentType,
      objective: task.objective,
      ownerSessionId: task.ownerSessionId,
      workRunId: task.workRunId || (typeof task.runtimeTask.metadata?.workRunId === 'string' ? task.runtimeTask.metadata.workRunId : undefined),
      stepId: task.stepId || (typeof task.runtimeTask.metadata?.stepId === 'string' ? task.runtimeTask.metadata.stepId : undefined),
      status,
      finalText,
      error: (task.runtimeTask.error || (typeof result?.error === 'string' ? result.error : undefined))?.slice(0, 2_000),
      evidence,
      turns: stats.turns,
      elapsedMs: Math.max(0, (task.runtimeTask.endedAt || this.now()) - task.startedAt),
      completedAt: task.runtimeTask.endedAt || this.now(),
      joinPolicy: descriptor.joinPolicy || 'required',
      stats,
    }
    this.completionCoordinator.enqueue(completion)
  }

  private readAllRecords(taskId: string): SubAgentTranscriptRecord[] {
    const descriptor = this.descriptors.get(taskId)
    if (!descriptor?.transcriptPath || !existsSync(descriptor.transcriptPath)) return []
    try {
      return parseTranscript(readFileSync(descriptor.transcriptPath, 'utf8'))
    } catch {
      return []
    }
  }

  private updateTaskStatsFromRecord(taskId: string, record: SubAgentTranscriptRecord): void {
    if (record.type !== 'event') return
    const telemetry = this.telemetry.get(taskId) || new SubAgentTelemetry()
    telemetry.record(record.event)
    this.telemetry.set(taskId, telemetry)
    this.taskStats.set(taskId, telemetry.snapshot())
  }

  private buildCompletionStats(records: SubAgentTranscriptRecord[], taskId?: string): SubAgentCompletionStats {
    const telemetry = new SubAgentTelemetry()
    for (const record of records) if (record.type === 'event') telemetry.record(record.event)
    if (taskId) this.telemetry.set(taskId, telemetry)
    return telemetry.snapshot()
  }

  private toCompletionStatus(status: RuntimeTaskStatus): SubAgentCompletionStatus | null {
    if (status === 'completed') return 'completed'
    if (status === 'failed') return 'failed'
    if (status === 'stopped') return 'stopped'
    if (status === 'interrupted' || status === 'orphaned') return 'interrupted'
    return null
  }

  private recoverTranscripts(): void {
    if (!this.storageDir) return
    const files = readdirSync(this.storageDir)
      .filter(file => file.endsWith('.jsonl'))
      .sort()
      .slice(-this.maxRetainedTasks)
    for (const file of files) {
      const transcriptPath = path.join(this.storageDir, file)
      const transcriptContent = readFileSync(transcriptPath, 'utf8')
      const records = parseTranscript(transcriptContent)
      const start = records.find((record): record is Extract<SubAgentTranscriptRecord, { type: 'start' }> => record.type === 'start')
      if (!start?.task?.id) continue
      const recoveredRuntimeTask = this.runtimeTaskManager.getTask(start.task.id)
      const descriptor: SubAgentTaskDescriptor = {
        ...start.task,
        joinPolicy: start.task.joinPolicy || 'required',
        transcriptPath,
      }
      this.descriptors.set(descriptor.id, descriptor)
      this.outputBytes.set(descriptor.id, statSync(transcriptPath).size)
      this.eventBytes.set(descriptor.id, records.reduce((total, record) => record.type === 'event'
        ? total + Buffer.byteLength(`${JSON.stringify(record)}\n`)
        : total, 0))

      let stateStatus: RuntimeTaskStatus | undefined
      let resultStatus: Extract<RuntimeTaskStatus, 'completed' | 'failed' | 'stopped'> | undefined
      let error: string | undefined
      let result: unknown
      for (const record of records) {
        if (record.type === 'join_policy') {
          descriptor.joinPolicy = record.joinPolicy
        } else if (record.type === 'result') {
          resultStatus = record.status
          error = record.error
          result = record.result
        } else if (record.type === 'state' && isRuntimeTaskStatus(record.status)) {
          stateStatus = record.status
          error = record.error || error
        }
      }
      const status = stateStatus && TERMINAL_STATUSES.has(stateStatus)
        ? stateStatus
        : resultStatus || stateStatus || 'running'
      if (result !== undefined) this.results.set(descriptor.id, result)
      this.taskStats.set(descriptor.id, this.buildCompletionStats(records, descriptor.id))

      if (recoveredRuntimeTask) {
        this.captureCompletion(descriptor.id)
        continue
      }

      this.runtimeTaskManager.createTask({
        id: descriptor.id,
        kind: descriptor.kind,
        ownerSessionId: descriptor.ownerSessionId,
        status: 'running',
        command: descriptor.objective,
        cwd: descriptor.workspacePath,
        startedAt: descriptor.startedAt,
        interactive: false,
        restartPolicy: 'never',
        metadata: {
          agentType: descriptor.agentType,
          label: descriptor.label,
          transcriptPath,
          recovered: true,
          workRunId: descriptor.workRunId,
          stepId: descriptor.stepId,
          joinPolicy: descriptor.joinPolicy,
        },
      })
      this.runtimeTaskManager.markRunning(descriptor.id, {
        logPath: transcriptPath,
        outputBytes: this.outputBytes.get(descriptor.id) || 0,
        outputOffset: this.outputBytes.get(descriptor.id) || 0,
      })

      if (status === 'completed') this.runtimeTaskManager.completeTask(descriptor.id)
      else if (status === 'failed') this.runtimeTaskManager.failTask(descriptor.id, error || 'Subagent failed')
      else if (status === 'stopped') this.runtimeTaskManager.markStopped(descriptor.id, error)
      else if (status === 'interrupted') this.runtimeTaskManager.interruptTask(descriptor.id, error || 'Subagent was interrupted')
      else {
        const reason = 'Subagent runtime restarted before this task completed'
        this.runtimeTaskManager.interruptTask(descriptor.id, reason)
        this.appendRecord(descriptor.id, {
          version: 1,
          type: 'state',
          timestamp: this.now(),
          status: 'interrupted',
          error: reason,
        })
      }
      this.captureCompletion(descriptor.id)
    }
  }

  private appendRecord(taskId: string, record: SubAgentTranscriptRecord): void {
    const descriptor = this.descriptors.get(taskId)
    if (!descriptor) return
    this.updateTaskStatsFromRecord(taskId, record)
    if (!descriptor.transcriptPath) return
    let line: string
    try {
      line = `${JSON.stringify(sanitizeSubAgentTranscriptRecord(record))}\n`
    } catch {
      line = `${JSON.stringify({
        version: 1,
        type: 'event',
        timestamp: this.now(),
        event: { type: 'serialization_error' },
      })}\n`
    }
    if (record.type === 'event') {
      const nextEventBytes = (this.eventBytes.get(taskId) || 0) + Buffer.byteLength(line)
      if (nextEventBytes > this.maxTranscriptEventBytes) return
      this.eventBytes.set(taskId, nextEventBytes)
    }
    appendFileSync(descriptor.transcriptPath, line, { encoding: 'utf8', mode: 0o600 })
    const bytes = (this.outputBytes.get(taskId) || 0) + Buffer.byteLength(line)
    this.outputBytes.set(taskId, bytes)
    if (this.runtimeTaskManager.getTask(taskId)) {
      this.runtimeTaskManager.updateTask(taskId, {
        logPath: descriptor.transcriptPath,
        outputBytes: bytes,
        outputOffset: bytes,
      })
    }
  }

  private pruneTerminalTasks(): void {
    const terminalTasks = Array.from(this.descriptors.keys())
      .map(taskId => this.runtimeTaskManager.getTask(taskId))
      .filter((task): task is RuntimeTask => task !== null && TERMINAL_STATUSES.has(task.status))
      .sort((left, right) => (
        (left.endedAt ?? left.updatedAt) - (right.endedAt ?? right.updatedAt)
        || left.startedAt - right.startedAt
        || left.id.localeCompare(right.id)
      ))
    const overflow = terminalTasks.length - this.maxRetainedTasks
    if (overflow <= 0) return
    for (const task of terminalTasks.slice(0, overflow)) {
      if (!this.runtimeTaskManager.removeTask(task.id)) this.releaseTask(task.id)
    }
  }

  private releaseTask(taskId: string): void {
    this.descriptors.delete(taskId)
    this.results.delete(taskId)
    this.taskStats.delete(taskId)
    this.telemetry.delete(taskId)
    this.outputBytes.delete(taskId)
    this.eventBytes.delete(taskId)
  }

  private generateId(kind: Extract<RuntimeTaskKind, 'agent'>, now: number): string {
    let id: string
    do {
      this.sequence += 1
      id = `runtime_${kind}_${now.toString(36)}_${this.sequence.toString(36)}_${randomUUID().slice(0, 8)}`
    } while (this.descriptors.has(id) || (this.storageDir && existsSync(path.join(this.storageDir, `${id}.jsonl`))))
    return id
  }
}

export function isTerminalSubAgentStatus(status: RuntimeTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}
