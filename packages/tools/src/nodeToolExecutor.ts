import { createReadStream, readFileSync, existsSync, mkdirSync, rmSync, renameSync, readdirSync, statSync, writeFileSync, promises as fsPromises } from 'fs'
import { createHash } from 'node:crypto'
import { basename, join, dirname, relative, resolve as resolveNativePath, isAbsolute } from 'path'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { constants as osConstants, setPriority } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { assertTextFile, decodeText, decodeTextStream } from './textFile'


import type {
  ToolExecutor,
  PatchPathIdentity,
  FileMutationResult,
  FileMutationState,
  Result,
  SearchContentHit,
  SearchContentBatchRequest,
  SearchContentOptions,
  SearchFilesOptions,
  SearchContentPage,
  FileRangeResult,
  FileByteRangeOptions,
  FileByteRangeResult,
  CommandOutput,
  RequestOptions,
  ListTreeOptions,
  WebFetchResponse,
  WebSearchResponse,
} from '@fluxos/contracts/toolExecutor'
import type { TreeNode } from '@fluxos/contracts/types'
import type { Memory, MemoryConfidence, MemoryKind, MemoryScope, MemorySnapshot } from '@fluxos/contracts/memoryTypes'
import type { TerminalOutputChunk, TerminalSessionInfo, TerminalStartCommandResult } from '@fluxos/contracts/terminalTypes'
import type { CapabilityProfile } from '@fluxos/contracts/agentTypes'
import type { RuntimeTaskPresentation } from '@fluxos/contracts/runtimeTaskTypes'
import { toolRecovery } from '@fluxos/contracts/toolResultData'
import { MemoryService } from './memory/service'
import { hashText, withFileLockSync, writeFileAtomic } from '@fluxos/platform/fileIO'
import { RuntimeTaskManager } from './runtimeTaskManager'
import { getChildProcessSpawnOptions, getDefaultShellSpec, createProcessTerminator, type ProcessTerminationReceipt } from '@fluxos/platform/process'
import { RuntimeLogWriter } from './runtimeLogWriter'
import { runtimeLogSegments } from './runtimeLogSegments'
import { CapabilityBoundary, CapabilityViolationError, type FilesystemAccess } from './capabilityBoundary'
import { resolvePatchPathIdentities } from './patchPaths'
import { FileByteRangeError, readFileByteRange } from './fileByteRange'
import { readTextLineRange } from './fileLineRange'
import { WebResearchService } from './webResearchService'
import { WorkspaceSearch } from './workspaceSearch'
import { CodeNavigationService } from './codeNavigation'
import type { CodeNavigationRequest, CodeNavigationResult } from '@fluxos/contracts/toolExecutor'
import { emitStreamTimingTrace, streamTimingTraceEnabled, summarizeTimings } from '@fluxos/platform/streamTimingTrace'

const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429])
const STREAM_RETRY_DELAYS_MS = [300, 900, 1800, 3600]
const MAX_STREAM_DIAGNOSTIC_CHARS = 64 * 1024
const MAX_STREAM_BUFFER_CHARS = 1 * 1024 * 1024

function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUS.has(status) || (status >= 500 && status <= 599)
}

export interface NodeToolExecutorOptions {
  runtimeTaskManager?: RuntimeTaskManager
  ownerSessionId?: string
  capabilityProfile?: CapabilityProfile
  memoryRoot?: string
  runtimeLogsRoot?: string
}

interface BackgroundTerminalSession {
  info: TerminalSessionInfo
  proc: ChildProcessWithoutNullStreams
  chunks: TerminalOutputChunk[]
  nextSeq: number
  bufferChars: number
  runtimeTaskId: string
  logPath: string
  outputBytes: number
  omittedBytes: number
  writer: RuntimeLogWriter
  commandSession: boolean
  pausedForLog: boolean
  lastRuntimeSnapshotAt: number
  stopRequested: boolean
  logError?: string
  rootClosed?: boolean
  stopPromise?: Promise<Result<void>>
  terminationPromise?: Promise<ProcessTerminationReceipt>
  termination?: ProcessTerminationReceipt
  finalize?: Promise<void>
}

const MAX_TERMINAL_CHUNKS = 500
const MAX_TERMINAL_BUFFER_CHARS = 1_000_000
const MAX_RECOVERED_TERMINAL_READ_BYTES = 2 * 1024 * 1024
const MAX_COMMAND_OUTPUT_CHARS = 2_000_000
const COMMAND_TERMINATION_GRACE_MS = 2000
const RUNTIME_LOG_DIRECTORY = join('.fluxagent', 'runtime-logs')
const RUNTIME_TASK_SNAPSHOT_INTERVAL_MS = 5000
const MODEL_REQUEST_TIMEOUT_MS = 2 * 60 * 1000
const DEFAULT_SHELL = getDefaultShellSpec()
const CODE_SEARCH_SKIPPED_DIRS = new Set([
  '.git', '.hg', '.svn', '.claude', '.fluxagent', '.vscode', '.cache', '.next', '.turbo',
  '.gradle', '.m2', '.npm', '.pnpm-store', '.rustup', '.venv',
  'AppData', 'appdata', 'Library', 'library', 'node_modules', 'vendor', 'venv', 'dist', 'dist-desktop', 'build', 'out',
  'coverage', 'target', 'tmp', 'temp',
])
const SAFE_ENV_TEMPLATE_NAMES = new Set(['.env.example', '.env.sample', '.env.template', '.env.defaults'])
const DEFAULT_READ_RANGE_LINES = 180
const DEFAULT_READ_RANGE_BYTES = 64 * 1024

export class NodeToolExecutor implements ToolExecutor {
  private readonly workspaceSearch = new WorkspaceSearch()
  private readonly codeNavigation = new CodeNavigationService()
  private memoryService: MemoryService
  private workspaceRoot: string
  private capabilityBoundary: CapabilityBoundary
  private backgroundTerminals: Map<string, BackgroundTerminalSession> = new Map()
  private activeStreams: Map<number, AbortController> = new Map()
  private readonly processStops = new WeakMap<ChildProcessWithoutNullStreams, () => Promise<ProcessTerminationReceipt>>()
  private readonly unconfirmedProcesses = new Map<ChildProcessWithoutNullStreams, string | undefined>()
  private runtimeTaskManager: RuntimeTaskManager
  private readonly webResearchService: WebResearchService
  private readonly runtimeLogsRoot?: string

  constructor(private workspacePath: string, options: NodeToolExecutorOptions = {}) {
    this.webResearchService = new WebResearchService({ sourceDirectory: join(options.runtimeLogsRoot || join(workspacePath, '.fluxagent'), 'web-sources', options.ownerSessionId ? createHash('sha256').update(options.ownerSessionId).digest('hex').slice(0, 32) : 'workspace') })
    this.memoryService = new MemoryService(options.memoryRoot)
    this.runtimeLogsRoot = options.runtimeLogsRoot ? resolveNativePath(options.runtimeLogsRoot) : undefined
    this.capabilityBoundary = new CapabilityBoundary(workspacePath, options.capabilityProfile)
    this.workspaceRoot = this.capabilityBoundary.workspaceRoot
    this.runtimeTaskManager = options.runtimeTaskManager || new RuntimeTaskManager({
      defaultOwnerSessionId: options.ownerSessionId,
    })
  }

  getRuntimeTaskManager(): RuntimeTaskManager {
    return this.runtimeTaskManager
  }

  getCapabilityProfile(): CapabilityProfile {
    return this.capabilityBoundary.getProfile()
  }

  setCapabilityProfile(profile: CapabilityProfile): void {
    this.capabilityBoundary.setProfile(profile)
  }

  private createRuntimeTaskLog(taskId: string): string {
    const directory = this.runtimeLogsRoot
      ?? this.resolvePath(join(this.workspaceRoot, RUNTIME_LOG_DIRECTORY), 'write')
    mkdirSync(directory, { recursive: true })
    return this.runtimeLogsRoot
      ? join(directory, `${taskId}.jsonl`)
      : this.resolvePath(join(directory, `${taskId}.jsonl`), 'write')
  }

  async resolvePatchPaths(paths: string[], basePath: string, signal?: AbortSignal): Promise<Result<PatchPathIdentity[]>> {
    try {
      if (paths.length > 400) throw new Error('Patch path preflight exceeds 400 paths')
      const base = this.resolvePath(basePath, 'write')
      const resolved = paths.map(path => {
        if (/^[A-Za-z]:(?![\\/])/.test(path)) throw new Error(`Drive-relative patch paths are not supported: ${path}`)
        return this.resolvePath(resolveNativePath(base, path), 'write')
      })
      const identities = await resolvePatchPathIdentities(resolved, signal)
      return { success: true, data: identities.map(entry => ({ ...entry, relativePath: relative(base, entry.path) })) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async readFile(path: string): Promise<Result<string>> {
    try {
      const safePath = this.resolvePath(path)
      if (!existsSync(safePath)) return { success: false, error: 'File not found' }
      if (!statSync(safePath).isFile()) return { success: false, error: 'Path is not a file' }
      const content = decodeText(await fsPromises.readFile(safePath))
      return { success: true, data: content }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async readFileRange(path: string, offset = 0, limit = DEFAULT_READ_RANGE_LINES, maxBytes = DEFAULT_READ_RANGE_BYTES): Promise<Result<FileRangeResult>> {
    let stream: ReturnType<typeof createReadStream> | undefined
    try {
      const safePath = this.resolvePath(path)
      if (!existsSync(safePath)) return { success: false, error: 'File not found' }
      if (!statSync(safePath).isFile()) return { success: false, error: 'Path is not a file' }
      if (![offset, limit, maxBytes].every(Number.isFinite)) return { success: false, error: 'File range limits must be finite numbers', errorKind: 'validation' }
      await assertTextFile(safePath)
      stream = createReadStream(safePath, { highWaterMark: 16 * 1024 })
      const result = await readTextLineRange(decodeTextStream(stream as AsyncIterable<Buffer>), Math.max(0, Math.floor(offset)),
        Math.max(1, Math.min(2000, Math.floor(limit))), Math.max(4096, Math.min(2 * 1024 * 1024, Math.floor(maxBytes))))
      return { success: true, data: result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally { stream?.destroy() }
  }

  async readFileBytes(path: string, options: FileByteRangeOptions = {}): Promise<Result<FileByteRangeResult>> {
    try {
      return { success: true, data: await readFileByteRange(() => this.resolvePath(path), options) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error),
        errorKind: options.signal?.aborted ? 'abort' : error instanceof CapabilityViolationError ? 'permission' : error instanceof FileByteRangeError ? 'validation' : 'environment' }
    }
  }

  async writeFile(path: string, content: string, metadata?: Record<string, unknown>): Promise<FileMutationResult> {
    const outcome: { mutation: FileMutationState } = { mutation: 'not_committed' }
    try {
      let safePath = this.resolvePath(path, 'write')
      const dir = dirname(safePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      safePath = this.resolvePath(safePath, 'write')
      const lockPath = join(dir, `.${basename(safePath)}.fluxagent-write.lock`)
      await writeFileAtomic(safePath, content, {
        lockPath,
        onPublicationState: state => { outcome.mutation = state === 'published' ? 'committed' : 'unknown' },
        expectNotExists: metadata?.expectNotExists === true,
        beforeCommit: () => {
          if (metadata?.expectNotExists === true && existsSync(safePath)) {
            throw new Error(`Write conflict: file already exists: ${path}`)
          }
          if (typeof metadata?.expectedHash === 'string') {
            if (!existsSync(safePath)) throw new Error(`Write conflict: file was deleted: ${path}`)
            if (hashText(readFileSync(safePath, 'utf-8')) !== metadata.expectedHash) {
              throw new Error(`Write conflict: file changed since it was read: ${path}`)
            }
          }
        },
      })
      return { success: true, mutation: 'committed' }
    } catch (e) {
      if (outcome.mutation !== 'committed' && metadata?.expectNotExists === true && (e as NodeJS.ErrnoException).code === 'EEXIST') {
        return { success: false, mutation: 'not_committed', error: `Write conflict: file already exists: ${path}` }
      }
      return { success: false, mutation: outcome.mutation, error: String(e), errorKind: e instanceof CapabilityViolationError ? 'permission' : 'execution' }
    }
  }

  async deleteFile(path: string, options?: { recursive?: boolean; expectedHash?: string }): Promise<FileMutationResult> {
    let mutation: FileMutationState = 'not_committed'
    try {
      const safePath = this.resolvePath(path, 'write')
      return withFileLockSync(join(dirname(safePath), `.${basename(safePath)}.fluxagent-write.lock`), () => {
        if (!existsSync(safePath)) return { success: false, mutation, error: 'File not found' }
        const expectedHash = options?.expectedHash
        if (typeof expectedHash === 'string') {
          const actualHash = hashText(readFileSync(safePath, 'utf-8'))
          if (actualHash !== expectedHash) {
            return { success: false, mutation, error: `Delete conflict: file changed since it was read: ${path}` }
          }
        }
        mutation = 'unknown'
        rmSync(safePath, { recursive: options?.recursive ?? false, force: true })
        mutation = 'committed'
        return { success: true, mutation }
      })
    } catch (e) {
      return { success: false, mutation, error: String(e), errorKind: e instanceof CapabilityViolationError ? 'permission' : 'execution' }
    }
  }

  async moveFile(sourcePath: string, destinationPath: string, options?: { expectedHash?: string; expectedDestinationHash?: string }): Promise<Result<void>> {
    try {
      const safeSourcePath = this.resolvePath(sourcePath, 'write')
      const safeDestinationPath = this.resolvePath(destinationPath, 'write')
      const parent = dirname(safeDestinationPath)
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
      const locks = [safeSourcePath, safeDestinationPath].sort().map(target => join(dirname(target), `.${basename(target)}.fluxagent-write.lock`))
      return withFileLockSync(locks[0]!, () => withFileLockSync(locks[1]!, () => {
        if (!existsSync(safeSourcePath)) return { success: false, error: `File not found: ${sourcePath}` }
        if (statSync(safeSourcePath).isDirectory()) return { success: false, error: `Cannot move directory with moveFile: ${sourcePath}` }
        if (typeof options?.expectedHash === 'string') {
          const actualHash = hashText(readFileSync(safeSourcePath, 'utf-8'))
          if (actualHash !== options.expectedHash) {
            return { success: false, error: `Move conflict: source changed since it was read: ${sourcePath}` }
          }
        }
        if (existsSync(safeDestinationPath)) {
          if (statSync(safeDestinationPath).isDirectory()) return { success: false, error: `Cannot overwrite directory: ${destinationPath}` }
          if (typeof options?.expectedDestinationHash === 'string') {
            const actualHash = hashText(readFileSync(safeDestinationPath, 'utf-8'))
            if (actualHash !== options.expectedDestinationHash) {
              return { success: false, error: `Move conflict: destination changed since it was read: ${destinationPath}` }
            }
          }
        }
        renameSync(safeSourcePath, safeDestinationPath)
        return { success: true }
      }))
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }


  async listTree(path: string, options: ListTreeOptions = {}): Promise<Result<TreeNode>> {
    try {
      const maxDepth = Math.max(0, Math.min(5, Math.floor(options.maxDepth ?? 3)))
      const maxEntriesPerDirectory = Math.max(1, Math.min(500, Math.floor(options.maxEntriesPerDirectory ?? 500)))
      const maxNodes = Math.max(1, Math.min(20_000, Math.floor(options.maxNodes ?? 20_000)))
      const resolved = this.resolvePath(path)
      if (!statSync(resolved).isDirectory()) return { success: false, error: 'Path is not a directory' }
      const root = this.buildTree(resolved, maxDepth, 0, { remaining: maxNodes }, maxEntriesPerDirectory)
      return { success: true, data: root }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async searchFiles(pattern: string, basePath: string, options: SearchFilesOptions = {}) {
    try {
      return await this.workspaceSearch.files(pattern, this.resolvePath(basePath), options)
    } catch (error) {
      return { success: false, error: String(error), errorKind: 'permission' as const }
    }
  }

  async searchContent(pattern: string, basePath: string, filePattern?: string, caseInsensitive?: boolean): Promise<Result<SearchContentHit[]>> {
    const result = await this.searchContentPage(pattern, basePath, filePattern, caseInsensitive)
    return result.success ? { success: true, data: result.data?.hits || [] } : { success: false, error: result.error }
  }

  async searchContentBatch(requests: SearchContentBatchRequest[]): Promise<Array<Result<SearchContentPage>>> {
    return Promise.all(requests.map(request => this.searchContentPage(
      request.pattern, request.basePath, request.filePattern, request.caseInsensitive, request.options,
    )))
  }

  async navigateCode(request: CodeNavigationRequest): Promise<Result<CodeNavigationResult>> {
    try {
      return await this.codeNavigation.run(this.workspaceRoot, { ...request, path: this.resolvePath(request.path),
        ...(request.projectPath ? { projectPath: this.resolvePath(request.projectPath) } : {}) })
    } catch (error) {
      return { success: false, errorKind: 'permission', error: error instanceof Error ? error.message : String(error) }
    }
  }

  async searchContentPage(pattern: string, basePath: string, filePattern?: string, caseInsensitive?: boolean, options: SearchContentOptions = {}): Promise<Result<SearchContentPage>> {
    try {
      return await this.workspaceSearch.content(pattern, this.resolvePath(basePath), filePattern, caseInsensitive, options)
    } catch (error) {
      return { success: false, error: String(error), errorKind: 'permission' as const }
    }
  }

  async webSearch(query: Record<string, any>): Promise<Result<WebSearchResponse>> {
    return this.webResearchService.search(query as any)
  }

  async readWebSource(input: { source_id: string; offset?: number; limit?: number; query?: string }): Promise<Result<Record<string, unknown>>> {
    return this.webResearchService.readSource(input)
  }

  async webFetch(query: Record<string, any>): Promise<Result<WebFetchResponse>> {
    return this.webResearchService.fetchPages(query as any)
  }


  async memoryQuery(query: { query?: string; workspacePath: string; kind?: MemoryKind; scope?: MemoryScope; limit?: number }): Promise<Result<{ items: Array<{ id: string; text: string; content: string; kind: string; confidence: string; source: string; tags: string[]; score: number }> }>> {
    try {
      const safeWorkspacePath = this.resolvePath(query.workspacePath)
      const memories = await this.memoryService.query({
        workspacePath: safeWorkspacePath,
        query: query.query,
        kind: query.kind,
        scope: query.scope,
        limit: query.limit,
      })
      const items = memories.map(m => ({
        id: m.id,
        text: m.text,
        content: m.text,
        kind: m.kind,
        confidence: m.confidence,
        source: m.source,
        tags: m.tags,
        score: 1,
      }))
      return { success: true, data: { items } }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async memoryRemember(data: { content?: string; text?: string; kind?: MemoryKind; scope?: MemoryScope; tags?: string[]; confidence?: MemoryConfidence; workspacePath: string; conversationId?: string; messageId?: string }): Promise<Result<{ id: string; deduplicated?: boolean }>> {
    try {
      const safeWorkspacePath = this.resolvePath(data.workspacePath, 'write')
      const result = await this.memoryService.remember({
        workspacePath: safeWorkspacePath,
        text: data.content ?? data.text ?? '',
        kind: data.kind,
        scope: data.scope,
        tags: data.tags,
        confidence: data.confidence,
        conversationId: data.conversationId,
        messageId: data.messageId,
      })
      if (!result.success) return { success: false, error: result.error }
      return { success: true, data: { id: result.id || '', deduplicated: result.deduplicated } }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async memoryForget(data: { id: string; workspacePath: string; reason?: string }): Promise<Result<void>> {
    try {
      const safeWorkspacePath = this.resolvePath(data.workspacePath, 'write')
      const result = await this.memoryService.forget({ workspacePath: safeWorkspacePath, id: data.id, reason: data.reason })
      if (!result.success) return { success: false, error: result.error }
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async memoryUpdate(data: {
    id: string
    workspacePath: string
    text?: string
    scope?: MemoryScope
    kind?: MemoryKind
    confidence?: MemoryConfidence
    tags?: string[]
    pinned?: boolean
    reviewState?: Memory['reviewState']
    status?: Memory['status']
  }): Promise<Result<void>> {
    try {
      const safeWorkspacePath = this.resolvePath(data.workspacePath, 'write')
      const result = await this.memoryService.update({
        workspacePath: safeWorkspacePath,
        id: data.id,
        text: data.text,
        scope: data.scope,
        kind: data.kind,
        confidence: data.confidence,
        tags: data.tags,
        pinned: data.pinned,
        reviewState: data.reviewState,
        status: data.status,
      })
      if (!result.success) return { success: false, error: result.error }
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async memoryList(workspacePath: string, forceReload = false, includeInactive = false): Promise<Result<{ snapshot: MemorySnapshot; items: Array<{ id: string; content: string; kind: string }> }>> {
    try {
      const safeWorkspacePath = this.resolvePath(workspacePath)
      const snapshot = await this.memoryService.getSnapshot(safeWorkspacePath, { force: forceReload, includeInactive })
      const memories = await this.memoryService.query({ workspacePath: safeWorkspacePath, limit: 100 })
      const items = memories.map(m => ({ id: m.id, content: m.text, kind: m.kind }))
      return { success: true, data: { snapshot, items } }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async memoryGetRelevantInjection(params: { workspacePath: string; query: string }): Promise<Result<{ text: string; tokens: number }>> {
    try {
      const safeWorkspacePath = this.resolvePath(params.workspacePath)
      const result = await this.memoryService.getRelevantInjection(safeWorkspacePath, params.query)
      return { success: true, data: { text: result.text, tokens: result.tokens } }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async runCommand(
    command: string,
    cwd: string,
    env?: Record<string, string>,
    timeout?: number,
    approved?: boolean,
    signal?: AbortSignal,
    expectedExitCodes: number[] = [0],
    presentation?: RuntimeTaskPresentation,
  ): Promise<Result<CommandOutput>> {
    let safeCwd: string
    try {
      const validation = this.validateCommandSync(command, cwd)
      if (!validation.success) {
        return { success: false, error: validation.error, errorKind: validation.errorKind, recovery: toolRecovery(validation.errorKind, 'none'), data: { stdout: '', stderr: validation.error || '', exitCode: null } }
      }
      if (approved !== true) {
        const error = 'Command execution requires an explicit permission decision'
        return { success: false, error, errorKind: 'permission', recovery: toolRecovery('permission', 'none'), data: { stdout: '', stderr: error, exitCode: null } }
      }
      safeCwd = validation.cwd
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    return this.executeCommand(command, safeCwd, env, timeout, signal, expectedExitCodes, presentation)
  }

  private async executeCommand(
    command: string,
    safeCwd: string,
    env: Record<string, string> | undefined,
    timeout: number | undefined,
    signal?: AbortSignal,
    expectedExitCodes: number[] = [0],
    presentation?: RuntimeTaskPresentation,
  ): Promise<Result<CommandOutput>> {
    if (signal?.aborted) return this.preCancelledCommand()
    const { shell, shellArgs } = getShellCommand(command)
    const runtimeTask = this.runtimeTaskManager.createTask({
      kind: 'shell',
      command,
      cwd: safeCwd,
      interactive: false,
      metadata: { expectedExitCodes: [...expectedExitCodes] },
      presentation,
    })
    let logPath: string | undefined
    try {
      if (signal?.aborted) {
        this.runtimeTaskManager.markStopped(runtimeTask.id, 'Cancelled before spawn', { metadata: { aborted: true } })
        return this.preCancelledCommand()
      }
      logPath = this.createRuntimeTaskLog(runtimeTask.id)
      const proc = spawn(shell, shellArgs, {
        cwd: safeCwd,
        env: this.buildChildEnvironment(env),
        ...getChildProcessSpawnOptions(),
      })
      this.processStops.set(proc, createProcessTerminator(proc.pid, () => proc.exitCode !== null || proc.signalCode !== null))
      const pending = this.collectProcess(proc, timeout || 30000, runtimeTask.id, logPath, signal)
      this.runtimeTaskManager.markRunning(runtimeTask.id, { pid: proc.pid, logPath, outputBytes: 0, outputOffset: 0 })
      return pending
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.runtimeTaskManager.failTask(runtimeTask.id, message, { logPath, outputBytes: 0 })
      return { success: false, error: message, data: { stdout: '', stderr: message, exitCode: null, logPath, outputBytes: 0 } }
    }
  }

  async readOnlyProcess(command: string, args: string[], cwd: string, env?: Record<string, string>, timeout?: number, signal?: AbortSignal): Promise<Result<CommandOutput>> {
    return this.runProcess(command, args, cwd, env, timeout, signal, 'read')
  }

  async runProcess(command: string, args: string[], cwd: string, env?: Record<string, string>, timeout?: number, signal?: AbortSignal, access: FilesystemAccess = 'write'): Promise<Result<CommandOutput>> {
    if (signal?.aborted) return this.preCancelledCommand()
    let runtimeTaskId: string | undefined
    let logPath: string | undefined
    try {
      const safeCwd = this.resolvePath(cwd, access)
      const runtimeTask = this.runtimeTaskManager.createTask({
        kind: 'shell',
        command: [command, ...args].join(' '),
        cwd: safeCwd,
        interactive: false,
        metadata: { executable: command, args: [...args] },
      })
      runtimeTaskId = runtimeTask.id
      if (signal?.aborted) {
        this.runtimeTaskManager.markStopped(runtimeTask.id, 'Cancelled before spawn', { metadata: { aborted: true } })
        return this.preCancelledCommand()
      }
      logPath = access === 'read' && this.getCapabilityProfile() === 'read-only'
        ? undefined
        : this.createRuntimeTaskLog(runtimeTask.id)
      const proc = spawn(command, args, {
        cwd: safeCwd,
        env: this.buildChildEnvironment(env),
        ...getChildProcessSpawnOptions(),
      })
      this.processStops.set(proc, createProcessTerminator(proc.pid, () => proc.exitCode !== null || proc.signalCode !== null))
      const pending = this.collectProcess(proc, timeout || 30000, runtimeTask.id, logPath, signal)
      this.runtimeTaskManager.markRunning(runtimeTask.id, { pid: proc.pid, logPath, outputBytes: 0, outputOffset: 0 })
      return await pending
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (runtimeTaskId) this.runtimeTaskManager.failTask(runtimeTaskId, message, { logPath, outputBytes: 0 })
      return { success: false, error: message, data: { stdout: '', stderr: message, exitCode: null, logPath, outputBytes: 0 } }
    }
  }

  private preCancelledCommand(): Result<CommandOutput> {
    return { success: false, error: 'Command cancelled before spawn', errorKind: 'abort',
      recovery: toolRecovery('abort', 'none'), data: { stdout: '', stderr: '', exitCode: null, aborted: true } }
  }

  private collectProcess(
    proc: ChildProcessWithoutNullStreams, timeout: number, runtimeTaskId?: string,
    logPath?: string, signal?: AbortSignal,
  ): Promise<Result<CommandOutput>> {
    return new Promise(resolve => {
      const parts = { stdout: [] as string[], stderr: [] as string[] }
      const lengths = { stdout: 0, stderr: 0 }
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
      let truncated = false, timedOut = false, aborted = false, settled = false, closed = false
      let outputBytes = 0
      let exitCode: number | null = null
      let exitSignal: NodeJS.Signals | null = null
      let processError: string | undefined, logError: string | undefined
      let stop: Promise<void> | undefined
      let termination: ProcessTerminationReceipt | undefined
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      let timeoutCheckImmediate: ReturnType<typeof setImmediate> | undefined
      let closedResolve: (() => void) | undefined
      const closedPromise = new Promise<void>(done => { closedResolve = done })
      const logWriter = logPath ? new RuntimeLogWriter(logPath, {
        onDrain: () => { if (!proc.stdout.destroyed) proc.stdout.resume(); if (!proc.stderr.destroyed) proc.stderr.resume() },
        onError: error => { logError = error.message },
      }) : undefined
      const append = (channel: 'stdout' | 'stderr', text: string) => {
        const remaining = MAX_COMMAND_OUTPUT_CHARS - lengths[channel]
        if (text.length > remaining) truncated = true
        const bounded = text.slice(0, Math.max(0, remaining))
        if (bounded) parts[channel].push(bounded)
        lengths[channel] += bounded.length
      }
      const record = (channel: 'stdout' | 'stderr', data: Buffer | string) => {
        outputBytes += Buffer.byteLength(data)
        append(channel, typeof data === 'string' ? data : decoders[channel].write(data))
        if (logWriter && !logError && !logWriter.append(channel, data)) { proc.stdout.pause(); proc.stderr.pause() }
      }
      const finish = async () => {
        if (settled) return
        settled = true
        if (timeoutTimer) clearTimeout(timeoutTimer)
        if (timeoutCheckImmediate) clearImmediate(timeoutCheckImmediate)
        proc.stdout.off('data', onStdout); proc.stderr.off('data', onStderr)
        proc.off('error', onError); proc.off('close', onClose)
        signal?.removeEventListener('abort', onAbort)
        append('stdout', decoders.stdout.end()); append('stderr', decoders.stderr.end())
        await logWriter?.close()
        if (termination?.status === 'unknown') {
          this.unconfirmedProcesses.set(proc, runtimeTaskId)
          // Keep draining without retaining output until explicit shutdown retries
          // ownership cleanup. Late process errors must not crash the host.
          proc.on('error', () => {})
          proc.stdout.resume(); proc.stderr.resume()
        }
        const error = aborted ? 'Command aborted' : timedOut ? `Command timed out after ${timeout}ms`
          : processError || (exitCode === null ? 'Command terminated without an exit code' : undefined)
        const result: Result<CommandOutput> = {
          success: !aborted && !timedOut && !processError && (exitCode !== null || exitSignal !== null),
          ...(error ? { error: termination?.status === 'unknown' ? `${error}; local termination unconfirmed: ${termination.error}` : error } : {}),
          ...((aborted || timedOut) ? { errorKind: aborted ? 'abort' as const : 'timeout' as const,
            recovery: toolRecovery(aborted ? 'abort' : 'timeout', 'unknown') } : {}),
          data: { stdout: parts.stdout.join(''), stderr: parts.stderr.join(''), exitCode,
            ...(exitSignal ? { exitSignal } : {}), ...(termination ? { termination } : {}),
            timedOut, aborted, truncated, logPath, outputBytes },
        }
        if (runtimeTaskId) this.finishProcessRuntimeTask(runtimeTaskId, result, logError)
        resolve(result)
      }
      const cancel = (reason: 'abort' | 'timeout'): Promise<void> => {
        if (stop) return stop
        if (settled) return Promise.resolve()
        if (reason === 'abort') aborted = true; else timedOut = true
        // Defer the action until the shared promise is published, including synchronous close.
        stop = Promise.resolve().then(async () => {
          termination = await this.terminateProcessTree(proc)
          if (!closed) {
            let timer: ReturnType<typeof setTimeout> | undefined
            await Promise.race([closedPromise, new Promise<void>(done => { timer = setTimeout(done, COMMAND_TERMINATION_GRACE_MS) })])
            if (timer) clearTimeout(timer)
          }
          if (!closed) termination = { ...termination!, status: 'unknown', error: 'Process streams/exit did not close within the termination deadline' }
          await finish()
        })
        return stop
      }
      const onStdout = (data: Buffer | string) => record('stdout', data)
      const onStderr = (data: Buffer | string) => record('stderr', data)
      const onError = (error: Error) => { processError = error.message; if (!stop) void finish() }
      const onClose = (code: number | null, receivedSignal: NodeJS.Signals | null) => {
        closed = true; exitCode = code; exitSignal = receivedSignal; closedResolve?.()
        if (!stop) void finish()
      }
      const onAbort = () => { void cancel('abort') }
      proc.stdout.on('data', onStdout); proc.stderr.on('data', onStderr)
      proc.on('error', onError); proc.on('close', onClose)
      if (runtimeTaskId) this.runtimeTaskManager.setControl(runtimeTaskId, { stop: async () => {
        await cancel('abort')
        if (termination?.status === 'unknown') throw new Error(termination.error || 'Process termination unconfirmed')
      } })
      if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true })
      timeoutTimer = setTimeout(() => {
        timeoutCheckImmediate = setImmediate(() => {
          timeoutCheckImmediate = undefined
          if (settled || stop) return
          // OS exit may precede Node's close event after event-loop contention. Give
          // pending pipe/close events one bounded drain window, then stop descendants.
          let rootExited = proc.exitCode != null || proc.signalCode != null
          try { if (typeof proc.kill === 'function' && !proc.kill(0)) rootExited = true } catch {}
          if (rootExited) timeoutTimer = setTimeout(() => { if (!settled && !stop) void cancel('timeout') }, 50)
          else void cancel('timeout')
        })
      }, Math.max(1, timeout))
    })
  }

  private terminateProcessTree(proc: ChildProcessWithoutNullStreams): Promise<ProcessTerminationReceipt> {
    const existing = this.processStops.get(proc)
    if (existing) return existing()
    const terminate = createProcessTerminator(proc.pid, () => proc.exitCode != null || proc.signalCode != null)
    this.processStops.set(proc, terminate)
    return terminate()
  }

  private async stopProcessAndWait(proc: ChildProcessWithoutNullStreams): Promise<void> {
    const receipt = await this.terminateProcessTree(proc)
    if (receipt.status !== 'confirmed') throw new Error(receipt.error || 'Process termination unconfirmed')
  }

  private finishProcessRuntimeTask(taskId: string, result: Result<CommandOutput>, logError?: string): void {
    const output = result.data
    const patch = {
      exitCode: output?.exitCode ?? null,
      outputBytes: output?.outputBytes || 0,
      logPath: output?.logPath,
      metadata: {
        timedOut: output?.timedOut === true,
        aborted: output?.aborted === true,
        ...(output?.exitSignal ? { exitSignal: output.exitSignal } : {}),
        truncated: output?.truncated === true,
        ...(output?.termination ? { termination: output.termination } : {}),
        ...(logError ? { logError } : {}),
      },
    }
    const expected = this.runtimeTaskManager.getTask(taskId)?.metadata?.expectedExitCodes
    const expectedExitCodes = Array.isArray(expected) ? expected : [0]
    if (output?.aborted) {
      if (output.termination?.status === 'confirmed') this.runtimeTaskManager.markStopped(taskId, 'Command aborted', patch)
      else this.runtimeTaskManager.interruptTask(taskId, result.error || 'Command aborted; process termination unconfirmed', patch)
      return
    }
    if (result.success && !output?.exitSignal && typeof output?.exitCode === 'number' && expectedExitCodes.includes(output.exitCode)) {
      this.runtimeTaskManager.completeTask(taskId, patch)
      return
    }
    this.runtimeTaskManager.failTask(taskId, result.error || (output?.exitSignal ? `Process exited with signal ${output.exitSignal}` : `Process exited with code ${patch.exitCode ?? 'unknown'}`), patch)
  }

  async validateCommand(command: string, cwd: string): Promise<Result<void>> {
    const validation = this.validateCommandSync(command, cwd)
    if (!validation.success) return { success: false, error: validation.error, errorKind: validation.errorKind, recovery: toolRecovery(validation.errorKind, 'none') }
    return { success: true }
  }

  private validateCommandSync(command: string, cwd: string): { success: true; cwd: string } | { success: false; error: string; errorKind: 'permission' | 'validation' } {
    try {
      this.capabilityBoundary.assertCommandAllowed()
      const safeCwd = this.resolvePath(cwd, 'write')
      return { success: true, cwd: safeCwd }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), errorKind: error instanceof CapabilityViolationError ? 'permission' : 'validation' }
    }
  }

  async startBackgroundCommand(
    command: string,
    cwd: string,
    env?: Record<string, string>,
    approved?: boolean,
    presentation?: RuntimeTaskPresentation,
    expectedExitCodes: number[] = [0],
    signal?: AbortSignal,
  ): Promise<Result<TerminalStartCommandResult>> {
    if (signal?.aborted) return { success: false, error: 'Command cancelled before spawn', errorKind: 'abort', recovery: toolRecovery('abort', 'none') }
    const validation = this.validateCommandSync(command, cwd)
    if (!validation.success) return { success: false, error: validation.error, errorKind: validation.errorKind, recovery: toolRecovery(validation.errorKind, 'none') }
    if (approved !== true) return { success: false, error: 'Command execution requires an explicit permission decision', errorKind: 'permission', recovery: toolRecovery('permission', 'none') }
    const { shell, shellArgs } = getShellCommand(command)
    return this.spawnTerminalSession({
      shell,
      shellArgs,
      shellId: DEFAULT_SHELL.id,
      shellLabel: DEFAULT_SHELL.label,
      command,
      cwd: validation.cwd,
      env,
      commandSession: true,
      signal,
      presentation,
      expectedExitCodes,
    })
  }

  async ptyCreate(options?: { shell?: string; cwd?: string; env?: Record<string, string>; presentation?: RuntimeTaskPresentation; expectedExitCodes?: number[]; signal?: AbortSignal }): Promise<Result<{ sessionId: string; session: TerminalSessionInfo }>> {
    if (options?.signal?.aborted) return { success: false, error: 'Terminal cancelled before spawn', errorKind: 'abort', recovery: toolRecovery('abort', 'none') }
    let safeCwd: string
    try {
      this.capabilityBoundary.assertCommandAllowed()
      safeCwd = this.resolvePath(options?.cwd || this.workspaceRoot, 'write')
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    const shell = options?.shell || DEFAULT_SHELL.command
    return this.spawnTerminalSession({
      shell,
      shellArgs: options?.shell ? [] : DEFAULT_SHELL.args,
      shellId: options?.shell ? 'custom' : DEFAULT_SHELL.id,
      shellLabel: options?.shell ? shell : DEFAULT_SHELL.label,
      command: shell,
      cwd: safeCwd,
      env: options?.env,
      commandSession: false,
      signal: options?.signal,
      presentation: options?.presentation,
      expectedExitCodes: options?.expectedExitCodes,
    })
  }

  private async spawnTerminalSession(options: {
    shell: string
    shellArgs: string[]
    shellId: string
    shellLabel: string
    command: string
    cwd: string
    env?: Record<string, string>
    commandSession: boolean
    signal?: AbortSignal
    presentation?: RuntimeTaskPresentation
    expectedExitCodes?: number[]
  }): Promise<Result<TerminalStartCommandResult>> {
    let runtimeTaskId: string | undefined
    let proc: ChildProcessWithoutNullStreams | undefined
    try {
      const now = Date.now()
      const sessionId = `term_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      const runtimeTask = this.runtimeTaskManager.createTask({
        kind: 'terminal',
        command: options.command,
        cwd: options.cwd,
        interactive: true,
        presentation: options.presentation,
        metadata: { sessionId, shellId: options.shellId, commandSession: options.commandSession, expectedExitCodes: [...(options.expectedExitCodes ?? [0])] },
      })
      runtimeTaskId = runtimeTask.id
      if (options.signal?.aborted) {
        this.runtimeTaskManager.markStopped(runtimeTask.id, 'Cancelled before spawn', { metadata: { aborted: true } })
        return { success: false, error: 'Terminal cancelled before spawn', errorKind: 'abort', recovery: toolRecovery('abort', 'none') }
      }
      const logPath = this.createRuntimeTaskLog(runtimeTask.id)
      proc = spawn(options.shell, options.shellArgs, {
        cwd: options.cwd,
        env: this.buildChildEnvironment(options.env),
        ...getChildProcessSpawnOptions(),
      })
      const ownedProc = proc
      this.processStops.set(proc, createProcessTerminator(proc.pid, () => ownedProc.exitCode !== null || ownedProc.signalCode !== null))
      if (proc.pid) {
        try {
          setPriority(proc.pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
        } catch {}
      }
      const info: TerminalSessionInfo = {
        id: sessionId,
        pid: proc.pid ?? 0,
        shell: options.shell,
        shellId: options.shellId,
        shellLabel: options.shellLabel,
        cwd: options.cwd,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        isAgentSession: true,
        title: options.command,
        command: options.command,
        runtimeTaskId: runtimeTask.id,
        logPath,
        outputBytes: 0,
        omittedBytes: 0,
        firstSeq: 1,
        lastSeq: 0,
        canWrite: true,
        expectedExitCodes: [...(options.expectedExitCodes ?? [0])],
      }
      const writer = new RuntimeLogWriter(logPath, {
        onDrain: () => {
          const active = this.backgroundTerminals.get(sessionId)
          if (!active?.pausedForLog) return
          active.pausedForLog = false
          if (!active.proc.stdout.destroyed) active.proc.stdout.resume()
          if (!active.proc.stderr.destroyed) active.proc.stderr.resume()
        },
        onError: error => {
          const active = this.backgroundTerminals.get(sessionId)
          if (active) active.logError = error.message
        },
      })
      const session: BackgroundTerminalSession = {
        info,
        proc,
        chunks: [],
        nextSeq: 1,
        bufferChars: 0,
        runtimeTaskId: runtimeTask.id,
        logPath,
        outputBytes: 0,
        omittedBytes: 0,
        writer,
        commandSession: options.commandSession,
        pausedForLog: false,
        lastRuntimeSnapshotAt: now,
        stopRequested: false,
      }
      this.backgroundTerminals.set(sessionId, session)
      this.runtimeTaskManager.setControl(runtimeTask.id, {
        stop: async () => {
          const result = await this.ptyKill(sessionId)
          if (!result.success) throw new Error(result.error || `Failed to stop terminal ${sessionId}`)
        },
        write: async data => {
          const result = await this.ptyWrite(sessionId, data)
          if (!result.success) throw new Error(result.error || `Failed to write terminal ${sessionId}`)
        },
      })
      this.runtimeTaskManager.markRunning(runtimeTask.id, {
        pid: proc.pid,
        logPath,
        outputBytes: 0,
        outputOffset: 0,
      })

      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
      const append = (channel: 'stdout' | 'stderr', data: Buffer | string) => {
        const text = typeof data === 'string' ? data : decoders[channel].write(data)
        const seq = text ? session.nextSeq++ : undefined
        session.outputBytes += Buffer.byteLength(data)
        if (!session.logError && !session.writer.append(channel, data, seq)) {
          session.pausedForLog = true
          session.proc.stdout.pause()
          session.proc.stderr.pause()
        }
        if (!text) return
        session.chunks.push({
          seq: seq!,
          data: text,
          timestamp: Date.now(),
        })
        session.bufferChars += text.length
        if (session.chunks.length > MAX_TERMINAL_CHUNKS) {
          const removed = session.chunks.splice(0, session.chunks.length - MAX_TERMINAL_CHUNKS)
          session.bufferChars -= removed.reduce((sum, chunk) => sum + chunk.data.length, 0)
          session.omittedBytes += removed.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.data), 0)
        }
        while (session.bufferChars > MAX_TERMINAL_BUFFER_CHARS && session.chunks.length > 1) {
          const removed = session.chunks.shift()
          if (removed) {
            session.bufferChars -= removed.data.length
            session.omittedBytes += Buffer.byteLength(removed.data)
          }
        }
        if (session.bufferChars > MAX_TERMINAL_BUFFER_CHARS) {
          const chunk = session.chunks[0]
          let cut = chunk.data.length - MAX_TERMINAL_BUFFER_CHARS
          if (/^[\uDC00-\uDFFF]$/.test(chunk.data[cut] || '')) cut++
          session.omittedBytes += Buffer.byteLength(chunk.data.slice(0, cut))
          chunk.data = chunk.data.slice(cut); session.bufferChars = chunk.data.length
        }
        const updatedAt = Date.now()
        session.info.updatedAt = updatedAt
        session.info.outputBytes = session.outputBytes
        session.info.omittedBytes = session.omittedBytes
        session.info.firstSeq = session.chunks[0]?.seq ?? session.nextSeq
        session.info.lastSeq = session.nextSeq - 1
        if (updatedAt - session.lastRuntimeSnapshotAt >= RUNTIME_TASK_SNAPSHOT_INTERVAL_MS) {
          session.lastRuntimeSnapshotAt = updatedAt
          this.runtimeTaskManager.updateTask(session.runtimeTaskId, {
            outputBytes: session.outputBytes,
            outputOffset: session.outputBytes,
            metadata: {
              firstSeq: session.info.firstSeq,
              lastSeq: session.info.lastSeq,
              omittedBytes: session.omittedBytes,
            },
          })
        }
      }

      proc.stdout.on('data', data => append('stdout', data))
      proc.stderr.on('data', data => append('stderr', data))
      let processError: string | undefined
      proc.on('error', (err) => {
        processError = err.message
        session.info.error = err.message
        session.info.updatedAt = Date.now()
        append('stderr', `\n[terminal error] ${err.message}\n`)
      })
      proc.on('close', (code, signal) => {
        session.rootClosed = true
        session.finalize = (async () => {
          append('stdout', decoders.stdout.end()); append('stderr', decoders.stderr.end())
          if (session.stopRequested && !session.terminationPromise) session.terminationPromise = this.terminateProcessTree(session.proc)
          if (session.terminationPromise) session.termination = await session.terminationPromise
          await session.writer.close()
          const stopped = session.stopRequested
            || ['stopping', 'stopped'].includes(this.runtimeTaskManager.getTask(session.runtimeTaskId)?.status || '')
          const failed = !stopped && Boolean(processError || signal || code === null || !(options.expectedExitCodes ?? [0]).includes(code))
          session.info.status = failed ? 'error' : 'exited'
          session.info.exitCode = code
          session.info.exitSignal = signal ?? null
          session.info.stopped = stopped && session.termination?.status !== 'unknown'
          session.info.canWrite = false
          session.info.error = failed
            ? processError || (signal ? `Terminal exited with signal ${signal}` : `Terminal exited with code ${code ?? 'unknown'}`)
            : undefined
          session.info.updatedAt = Date.now()
          const patch = {
            exitCode: code,
            outputBytes: session.outputBytes,
            outputOffset: session.outputBytes,
            logPath: session.logPath,
            error: undefined,
            metadata: {
              exitSignal: signal ?? null,
              durationMs: Date.now() - session.info.createdAt,
              ...(session.termination ? { termination: session.termination } : {}),
              omittedBytes: session.omittedBytes,
              firstSeq: session.info.firstSeq,
              lastSeq: session.info.lastSeq,
              ...(session.logError ? { logError: session.logError } : {}),
            },
          }
          if (stopped && session.termination?.status === 'unknown') this.runtimeTaskManager.interruptTask(session.runtimeTaskId, session.termination.error || 'Terminal termination unconfirmed', patch)
          else if (stopped) this.runtimeTaskManager.markStopped(session.runtimeTaskId, 'Terminal stopped', patch)
          else if (!failed) this.runtimeTaskManager.completeTask(session.runtimeTaskId, patch)
          else this.runtimeTaskManager.failTask(
            session.runtimeTaskId,
            session.info.error!,
            patch,
          )
          if (session.termination?.status !== 'unknown') this.backgroundTerminals.delete(sessionId)
        })()
      })

      return { success: true, data: { sessionId, session: info }, session, sessionId }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (proc) await this.terminateProcessTree(proc)
      if (runtimeTaskId) this.runtimeTaskManager.failTask(runtimeTaskId, message)
      return { success: false, error: message }
    }
  }

  async ptyWrite(sessionId: string, data: string): Promise<Result<void>> {
    const session = this.backgroundTerminals.get(sessionId)
    if (!session) return { success: false, error: `Terminal not found: ${sessionId}` }
    if (session.info.status !== 'running') return { success: false, error: `Terminal ${sessionId} is ${session.info.status}` }

    try {
      session.proc.stdin.write(data)
      session.info.updatedAt = Date.now()
      const firstLine = data.split(/\r?\n/).find(line => line.trim())
      if (firstLine && !session.commandSession) {
        session.info.title = firstLine.trim()
        this.runtimeTaskManager.updateTask(session.runtimeTaskId, { command: firstLine.trim() })
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async ptyGetBuffer(sessionId: string, sinceSeq = 0): Promise<Result<string>> {
    const session = this.backgroundTerminals.get(sessionId)
    if (!session) return this.readRecoveredTerminal(sessionId, sinceSeq)
    const chunks = sinceSeq > 0
      ? session.chunks.filter(chunk => chunk.seq > sinceSeq)
      : session.chunks
    const firstSeq = session.chunks[0]?.seq ?? session.nextSeq
    const lastSeq = session.nextSeq - 1
    return {
      success: true,
      data: chunks.map(chunk => chunk.data).join(''),
      chunks: [...chunks],
      session: { ...session.info },
      firstSeq,
      lastSeq,
      omittedBytes: sinceSeq < firstSeq - 1 ? session.omittedBytes : 0,
    }
  }

  async ptyInterruptCommand(sessionId: string): Promise<Result<void>> {
    const session = this.backgroundTerminals.get(sessionId)
    if (!session) return { success: false, error: `Terminal not found: ${sessionId}` }
    if (session.info.status !== 'running') return { success: false, error: `Terminal ${sessionId} is ${session.info.status}` }

    try {
      if (session.commandSession || process.platform === 'win32') {
        session.stopRequested = true
      }
      if (process.platform === 'win32') {
        await this.killTerminalProcessTree(session)
      } else {
        try {
          process.kill(-session.info.pid, 'SIGINT')
        } catch {
          session.proc.kill('SIGINT')
        }
      }
      if (session.stopRequested) this.runtimeTaskManager.markStopping(session.runtimeTaskId)
      session.info.updatedAt = Date.now()
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async ptyKill(sessionId: string): Promise<Result<void>> {
    const session = this.backgroundTerminals.get(sessionId)
    if (!session) {
      const task = this.runtimeTaskManager.listTasks({ kind: 'terminal' }).find(item => item.metadata?.sessionId === sessionId)
      return task?.status === 'stopped' || task?.status === 'completed'
        ? { success: true } : { success: false, error: `Terminal not found or termination unconfirmed: ${sessionId}` }
    }
    if (session.stopPromise) return session.stopPromise
    session.stopPromise = Promise.resolve().then(async () => {
      session.stopRequested = true
      this.runtimeTaskManager.markStopping(session.runtimeTaskId)
      session.terminationPromise = this.terminateProcessTree(session.proc)
      session.termination = await session.terminationPromise
      const closed = await this.waitForTerminalClose(session, COMMAND_TERMINATION_GRACE_MS)
      if (session.termination.status !== 'confirmed' || !closed) {
        const error = session.termination.error || 'Terminal root/streams exit unconfirmed'
        this.runtimeTaskManager.interruptTask(session.runtimeTaskId, error, { metadata: { termination: session.termination } })
        return { success: false, error, recovery: toolRecovery('execution', 'unknown') }
      }
      await session.finalize
      await session.writer.close()
      this.backgroundTerminals.delete(sessionId)
      return { success: true }
    }).catch(error => ({ success: false, error: error instanceof Error ? error.message : String(error) })).then(result => {
      if (!result.success) session.stopPromise = undefined
      return result
    })
    return session.stopPromise
  }

  async ptyList(): Promise<Result<TerminalSessionInfo[]>> {
    const sessions = Array.from(this.backgroundTerminals.values())
      .map(session => ({ ...session.info }))
    const knownIds = new Set(sessions.map(session => session.id))
    for (const task of this.runtimeTaskManager.listTasks({ kind: 'terminal' })) {
      const sessionId = typeof task.metadata?.sessionId === 'string' ? task.metadata.sessionId : undefined
      if (!sessionId || knownIds.has(sessionId)) continue
      const shellId = typeof task.metadata?.shellId === 'string' ? task.metadata.shellId : 'recovered'
      sessions.push({
        id: sessionId,
        pid: task.pid ?? 0,
        shell: shellId,
        shellId,
        shellLabel: shellId,
        cwd: task.cwd || this.workspaceRoot,
        status: task.status === 'running' || task.status === 'starting'
          ? 'running'
          : task.status === 'failed' || task.status === 'orphaned' ? 'error' : 'exited',
        createdAt: task.startedAt,
        updatedAt: task.updatedAt,
        isAgentSession: true,
        title: task.command || shellId,
        command: task.command,
        runtimeTaskId: task.id,
        logPath: task.logPath,
        outputBytes: task.outputBytes,
        omittedBytes: typeof task.metadata?.omittedBytes === 'number' ? task.metadata.omittedBytes : 0,
        firstSeq: typeof task.metadata?.firstSeq === 'number' ? task.metadata.firstSeq : undefined,
        lastSeq: typeof task.metadata?.lastSeq === 'number' ? task.metadata.lastSeq : undefined,
        exitCode: task.exitCode,
        exitSignal: typeof task.metadata?.exitSignal === 'string' ? task.metadata.exitSignal : null,
        expectedExitCodes: Array.isArray(task.metadata?.expectedExitCodes) ? [...task.metadata.expectedExitCodes] : [0],
        stopped: task.status === 'stopped',
        error: task.error,
        recovered: task.metadata?.recovered === true,
        canWrite: false,
      })
    }
    sessions
      .sort((a, b) => a.createdAt - b.createdAt)
    return { success: true, data: sessions, sessions }
  }

  private readRecoveredTerminal(sessionId: string, sinceSeq: number): Result<string> {
    const task = this.runtimeTaskManager.listTasks({ kind: 'terminal' }).find(item => item.metadata?.sessionId === sessionId)
    if (!task) return { success: false, error: `Terminal not found: ${sessionId}` }
    const listed = this.runtimeTaskToSession(task)
    if (!task.logPath) {
      return { success: true, data: '', chunks: [], session: listed, firstSeq: 1, lastSeq: 0, omittedBytes: 0 }
    }
    try {
      const segments = runtimeLogSegments(task.logPath)
      const lastSegment = segments.at(-1)
      const fileSize = lastSegment ? lastSegment.start + lastSegment.size : 0
      const requestedOffset = Math.max(0, fileSize - MAX_RECOVERED_TERMINAL_READ_BYTES)
      const output = this.runtimeTaskManager.readTaskOutput(task.id, requestedOffset, MAX_RECOVERED_TERMINAL_READ_BYTES)
      const lines = output.content.split(/\r?\n/)
      if (output.offset > output.startOffset && this.runtimeTaskManager.readTaskOutput(task.id, output.offset - 1, 1).content !== '\n') lines.shift()
      const records = lines.filter(Boolean).flatMap((line, index) => {
        try {
          const record = JSON.parse(line) as { timestamp?: number; data?: string; seq?: number }
          return [{
            seq: typeof record.seq === 'number' ? record.seq : index + 1,
            timestamp: record.timestamp || task.startedAt,
            data: String(record.data || ''),
          }]
        } catch {
          return []
        }
      })
      const chunks = sinceSeq > 0 ? records.filter(record => record.seq > sinceSeq) : records
      const firstSeq = records[0]?.seq ?? 1
      const currentOutputBytes = records.reduce((total, record) => total + Buffer.byteLength(record.data), 0)
      const knownOmittedBytes = Math.max(
        typeof task.metadata?.omittedBytes === 'number' ? task.metadata.omittedBytes : 0,
        Math.max(0, (task.outputBytes || 0) - currentOutputBytes),
      )
      return {
        success: true,
        data: chunks.map(chunk => chunk.data).join(''),
        chunks,
        session: listed,
        firstSeq,
        lastSeq: records.at(-1)?.seq ?? 0,
        omittedBytes: sinceSeq < firstSeq - 1 ? knownOmittedBytes : 0,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private runtimeTaskToSession(task: import('@fluxos/contracts/runtimeTaskTypes').RuntimeTask): TerminalSessionInfo {
    const sessionId = typeof task.metadata?.sessionId === 'string' ? task.metadata.sessionId : task.id
    const shellId = typeof task.metadata?.shellId === 'string' ? task.metadata.shellId : 'recovered'
    return {
      id: sessionId,
      pid: task.pid ?? 0,
      shell: shellId,
      shellId,
      shellLabel: shellId,
      cwd: task.cwd || this.workspaceRoot,
      status: task.status === 'running' || task.status === 'starting'
        ? 'running'
        : task.status === 'failed' || task.status === 'orphaned' ? 'error' : 'exited',
      createdAt: task.startedAt,
      updatedAt: task.updatedAt,
      isAgentSession: true,
      title: task.command || shellId,
      command: task.command,
      runtimeTaskId: task.id,
      logPath: task.logPath,
      outputBytes: task.outputBytes,
      firstSeq: typeof task.metadata?.firstSeq === 'number' ? task.metadata.firstSeq : undefined,
      lastSeq: typeof task.metadata?.lastSeq === 'number' ? task.metadata.lastSeq : undefined,
      exitCode: task.exitCode,
      exitSignal: typeof task.metadata?.exitSignal === 'string' ? task.metadata.exitSignal : null,
      expectedExitCodes: Array.isArray(task.metadata?.expectedExitCodes) ? [...task.metadata.expectedExitCodes] : [0],
      stopped: task.status === 'stopped',
      error: task.error,
      recovered: task.metadata?.recovered === true,
      canWrite: false,
    }
  }

  async ptyKillAll(): Promise<Result<void>> {
    const errors: string[] = []
    for (const sessionId of this.backgroundTerminals.keys()) {
      const result = await this.ptyKill(sessionId)
      if (!result.success) errors.push(`${sessionId}: ${result.error || 'unknown error'}`)
    }
    for (const [proc, taskId] of this.unconfirmedProcesses) {
      const receipt = await this.terminateProcessTree(proc)
      if (taskId) this.runtimeTaskManager.updateTask(taskId, { metadata: { termination: receipt } })
      if (receipt.status === 'confirmed') this.unconfirmedProcesses.delete(proc)
      else errors.push(`${taskId || proc.pid}: ${receipt.error || 'process termination unconfirmed'}`)
    }
    if (errors.length > 0) return { success: false, error: errors.join('\n') }
    return { success: true }
  }

  private async killTerminalProcessTree(session: BackgroundTerminalSession): Promise<void> {
    await this.stopProcessAndWait(session.proc)
  }

  private waitForTerminalClose(session: BackgroundTerminalSession, timeoutMs: number): Promise<boolean> {
    if (session.rootClosed) return Promise.resolve(true)
    return new Promise(resolve => {
      let settled = false
      const done = (closed: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        session.proc.off('close', onClose)
        resolve(closed)
      }
      const onClose = () => done(true)
      const timer = setTimeout(() => done(false), timeoutMs)
      session.proc.once('close', onClose)
    })
  }

  async sendMessage(url: string, headers: Record<string, string>, body: string, options: RequestOptions = {}): Promise<Result<string>> {
    const request = this.createRequestController(options)
    const maxRetries = options.retry === false ? 0 : STREAM_RETRY_DELAYS_MS.length
    try {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        options.onAttempt?.(attempt)
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body,
            signal: request.controller.signal,
          })
          const text = await response.text()
          if (!response.ok) {
            const error = this.formatHttpError(url, response.status, text)
            const retryAfterMs = this.retryAfterMs(response.headers.get('retry-after'))
            if (attempt < maxRetries && isRetryableHttpStatus(response.status)) {
              options.onRetry?.(response.status)
              await this.delay(Math.max(STREAM_RETRY_DELAYS_MS[attempt]!, retryAfterMs || 0), request.controller.signal)
              continue
            }
            return {
              success: false,
              error,
              status: response.status,
              receivedStreamData: false,
              ...(retryAfterMs ? { retryAfterMs } : {}),
            }
          }
          return { success: true, data: text }
        } catch (error) {
          if (request.controller.signal.aborted || this.isAbortError(error)) {
            return {
              success: false,
              error: request.timedOut() && !options.signal?.aborted
                ? `Request timed out after ${request.timeoutMs}ms`
                : 'Request aborted',
            }
          }
          if (attempt < maxRetries) {
            options.onRetry?.()
            await this.delay(STREAM_RETRY_DELAYS_MS[attempt], request.controller.signal)
            continue
          }
          return { success: false, error: this.formatNetworkError(url, error) }
        }
      }
      return { success: false, error: 'Request failed' }
    } finally {
      request.cleanup()
    }
  }

  async streamMessage(
    url: string,
    headers: Record<string, string>,
    body: string,
    onLine: (line: string) => void,
    options: RequestOptions = {},
  ): Promise<Result<string>> {
    const request = this.createRequestController(options)
    const maxRetries = options.retry === false ? 0 : STREAM_RETRY_DELAYS_MS.length
    if (options.streamId !== undefined) {
      this.activeStreams.get(options.streamId)?.abort()
      this.activeStreams.set(options.streamId, request.controller)
    }
    try {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        options.onAttempt?.(attempt)
        const traceEnabled = streamTimingTraceEnabled()
        const requestStartedAt = traceEnabled ? performance.now() : 0
        const readWaitDurations: number[] = []
        const dispatchDurations: number[] = []
        let responseReceivedAt = 0
        let rawChunkCount = 0
        let rawByteCount = 0
        let dispatchedLineCount = 0
        let emittedAnyLine = false
        let receivedAnyBytes = false
        let buffer = ''
        const diagnosticChunks: string[] = []
        let diagnosticChars = 0
        const recordDiagnostic = (line: string): void => {
          if (diagnosticChars >= MAX_STREAM_DIAGNOSTIC_CHARS) return
          const remaining = MAX_STREAM_DIAGNOSTIC_CHARS - diagnosticChars
          const bounded = line.slice(0, remaining)
          diagnosticChunks.push(bounded)
          diagnosticChars += bounded.length
        }
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body,
            signal: request.controller.signal,
          })
          if (traceEnabled) responseReceivedAt = performance.now()
          request.refreshTimeout()
          if (!response.ok) {
            const text = await response.text()
            const error = this.formatHttpError(url, response.status, text)
            const retryAfterMs = this.retryAfterMs(response.headers.get('retry-after'))
            if (attempt < maxRetries && isRetryableHttpStatus(response.status)) {
              options.onRetry?.(response.status)
              await this.delay(Math.max(STREAM_RETRY_DELAYS_MS[attempt]!, retryAfterMs || 0), request.controller.signal)
              continue
            }
            return {
              success: false,
              error,
              status: response.status,
              receivedStreamData: false,
              ...(retryAfterMs ? { retryAfterMs } : {}),
            }
          }
          const reader = response.body?.getReader()
          if (!reader) return { success: false, error: 'No response body', receivedStreamData: false }

          const decoder = new TextDecoder()

          while (true) {
            const readStartedAt = traceEnabled ? performance.now() : 0
            const { done, value } = await reader.read()
            if (traceEnabled) readWaitDurations.push(performance.now() - readStartedAt)
            if (done) break
            if (traceEnabled) {
              rawChunkCount += 1
              rawByteCount += value.byteLength
            }
            if (value.byteLength > 0) {
              receivedAnyBytes = true
              request.refreshTimeout()
            }
            buffer += decoder.decode(value, { stream: true })
            if (buffer.length > MAX_STREAM_BUFFER_CHARS) {
              const lastNewline = buffer.lastIndexOf('\n')
              buffer = lastNewline >= 0 && lastNewline <= MAX_STREAM_BUFFER_CHARS
                ? buffer.slice(0, lastNewline + 1)
                : ''
            }
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''
            for (const line of lines) {
              if (line.trim()) {
                emittedAnyLine = true
                const dispatchStartedAt = traceEnabled ? performance.now() : 0
                onLine(line)
                if (traceEnabled) {
                  dispatchDurations.push(performance.now() - dispatchStartedAt)
                  dispatchedLineCount += 1
                }
                recordDiagnostic(`${line}\n`)
              }
            }
          }
          if (buffer.trim()) {
            emittedAnyLine = true
            const dispatchStartedAt = traceEnabled ? performance.now() : 0
            onLine(buffer)
            if (traceEnabled) {
              dispatchDurations.push(performance.now() - dispatchStartedAt)
              dispatchedLineCount += 1
            }
            recordDiagnostic(buffer)
          }
          if (traceEnabled) {
            const completedAt = performance.now()
            let endpoint = url
            try {
              const parsed = new URL(url)
              endpoint = `${parsed.origin}${parsed.pathname}`
            } catch {}
            emitStreamTimingTrace('node-tool-executor', {
              attempt,
              endpoint,
              status: response.status,
              headerMs: Number((responseReceivedAt - requestStartedAt).toFixed(3)),
              totalMs: Number((completedAt - requestStartedAt).toFixed(3)),
              rawChunkCount,
              rawByteCount,
              dispatchedLineCount,
              readWait: summarizeTimings(readWaitDurations),
              lineDispatch: summarizeTimings(dispatchDurations),
            })
          }
          return { success: true }
        } catch (error) {
          if (request.controller.signal.aborted || this.isAbortError(error)) {
            return {
              success: false,
              error: request.timedOut() && !options.signal?.aborted
                ? `Request timed out after ${request.timeoutMs}ms`
                : 'Request aborted',
              receivedStreamData: emittedAnyLine || receivedAnyBytes,
            }
          }
          if (buffer.trim()) {
            emittedAnyLine = true
            onLine(buffer)
            recordDiagnostic(buffer)
            buffer = ''
          }
          if (!emittedAnyLine && !receivedAnyBytes && attempt < maxRetries) {
            options.onRetry?.()
            await this.delay(STREAM_RETRY_DELAYS_MS[attempt], request.controller.signal)
            continue
          }
          return {
            success: false,
            error: this.formatNetworkError(url, error),
            receivedStreamData: emittedAnyLine || receivedAnyBytes,
            ...(diagnosticChunks.length > 0 ? { data: diagnosticChunks.join('') } : {}),
          }
        }
      }
      return { success: false, error: 'Stream request failed', receivedStreamData: false }
    } finally {
      if (options.streamId !== undefined && this.activeStreams.get(options.streamId) === request.controller) {
        this.activeStreams.delete(options.streamId)
      }
      request.cleanup()
    }
  }

  async streamAbort(streamId: number): Promise<void> {
    this.activeStreams.get(streamId)?.abort()
  }

  private createRequestController(options: RequestOptions): {
    controller: AbortController
    cleanup: () => void
    refreshTimeout: () => void
    timedOut: () => boolean
    timeoutMs: number
  } {
    const controller = new AbortController()
    const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs || 0) > 0
      ? Math.floor(options.timeoutMs as number)
      : MODEL_REQUEST_TIMEOUT_MS
    let timedOut = false
    const abortFromParent = () => controller.abort()
    if (options.signal?.aborted) controller.abort()
    else options.signal?.addEventListener('abort', abortFromParent, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const refreshTimeout = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
    }
    refreshTimeout()
    return {
      controller,
      timeoutMs,
      timedOut: () => timedOut,
      refreshTimeout,
      cleanup: () => {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', abortFromParent)
      },
    }
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
  }

  // Helper methods
  private resolvePath(path: string, access: FilesystemAccess = 'read'): string {
    return this.capabilityBoundary.resolvePath(path, access)
  }

  private buildTree(
    dirPath: string,
    maxDepth: number,
    depth = 0,
    budget: { remaining: number } = { remaining: 20_000 },
    maxEntriesPerDirectory = 500,
  ): TreeNode {
    const name = depth === 0 ? dirPath : dirPath.split(/[\\/]/).pop() || dirPath
    const node: TreeNode = { name, type: 'directory', children: [] }
    budget.remaining = Math.max(0, budget.remaining - 1)

    if (depth >= maxDepth) return node
    if (budget.remaining <= 0) return { ...node, truncated: true }

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true })
        .filter(entry => !entry.isSymbolicLink() && !this.shouldSkipEntry(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))
      if (entries.length > maxEntriesPerDirectory) node.truncated = true
      for (const entry of entries.slice(0, maxEntriesPerDirectory)) {
        if (budget.remaining <= 0) { node.truncated = true; break }
        const fullPath = join(dirPath, entry.name)
        if (entry.isDirectory()) {
          const child = this.buildTree(fullPath, maxDepth, depth + 1, budget, maxEntriesPerDirectory)
          node.children!.push(child)
          if (child.truncated) node.truncated = true
        } else {
          budget.remaining -= 1
          node.children!.push({ name: entry.name, type: 'file' })
        }
      }
    } catch (error) {
      if (depth === 0) throw error
      node.truncated = true
    }

    return node
  }


  private shouldSkipEntry(name: string): boolean {
    if (CODE_SEARCH_SKIPPED_DIRS.has(name.toLowerCase())) return true
    return this.isSensitiveEnvironmentFileName(name)
  }

  private isSensitiveEnvironmentFileName(name: string): boolean {
    const normalized = name.toLowerCase()
    return normalized.startsWith('.env') && !SAFE_ENV_TEMPLATE_NAMES.has(normalized)
  }

  private buildChildEnvironment(overrides?: Record<string, string>): NodeJS.ProcessEnv {
    return { ...process.env, ...overrides }
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      signal?.addEventListener('abort', finish, { once: true })
    })
  }

  private formatHttpError(url: string, status: number, text: string): string {
    const detail = text.trim() || 'empty response'
    return `HTTP ${status}: ${detail}`
  }

  private retryAfterMs(value: string | null): number | undefined {
    if (!value) return undefined
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(120_000, Math.round(seconds * 1000))
    const date = Date.parse(value)
    if (!Number.isFinite(date)) return undefined
    return Math.min(120_000, Math.max(0, date - Date.now()))
  }

  private formatNetworkError(url: string, error: unknown): string {
    const parts: string[] = []
    const seen = new Set<unknown>()
    let current: unknown = error
    for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
      if (seen.has(current)) break
      seen.add(current)
      if (current instanceof Error) {
        const record = current as Error & {
          code?: unknown
          errno?: unknown
          syscall?: unknown
          address?: unknown
          port?: unknown
          cause?: unknown
        }
        const metadata = [
          record.code ? `code=${String(record.code)}` : '',
          record.errno ? `errno=${String(record.errno)}` : '',
          record.syscall ? `syscall=${String(record.syscall)}` : '',
          record.address ? `address=${String(record.address)}` : '',
          record.port ? `port=${String(record.port)}` : '',
        ].filter(Boolean)
        parts.push(`${record.message || record.name}${metadata.length > 0 ? ` (${metadata.join(', ')})` : ''}`)
        current = record.cause
        continue
      }
      if (typeof current === 'object') {
        const record = current as Record<string, unknown>
        const metadata = ['code', 'errno', 'syscall', 'address', 'port']
          .filter(key => record[key] !== undefined)
          .map(key => `${key}=${String(record[key])}`)
        const message = typeof record.message === 'string' ? record.message : String(current)
        parts.push(`${message}${metadata.length > 0 ? ` (${metadata.join(', ')})` : ''}`)
        current = record.cause
        continue
      }
      parts.push(String(current))
      break
    }
    return `Network request to ${url} failed: ${parts.filter(Boolean).join(' <- caused by: ') || 'unknown network error'}`
  }
}

function getShellCommand(command: string): { shell: string; shellArgs: string[] } {
  if (process.platform !== 'win32') {
    return { shell: DEFAULT_SHELL.command, shellArgs: ['-lc', command] }
  }
  const wrapped = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding',
    command,
    '$fluxagentSucceeded = $?',
    '$fluxagentExitCode = $LASTEXITCODE',
    'if (-not $fluxagentSucceeded) { if ($null -ne $fluxagentExitCode) { exit $fluxagentExitCode }; exit 1 }',
  ].join('\n')
  return {
    shell: DEFAULT_SHELL.command,
    shellArgs: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', wrapped],
  }
}
