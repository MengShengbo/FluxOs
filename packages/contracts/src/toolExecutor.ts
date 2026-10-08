import type { TreeNode } from './types'
import type { MemoryKind, MemoryScope } from './memoryTypes'
import type { TerminalBufferResult, TerminalSessionInfo, TerminalStartCommandResult } from './terminalTypes'
import type { RuntimeTaskPresentation } from './runtimeTaskTypes'
import type { ToolResult } from './agentTypes'
import type { ToolRecovery } from './toolResultData'
import type { CodeNavigationRequest, CodeNavigationResult } from './codeNavigation'
export type { CodeNavigationRequest, CodeNavigationResult, CodeLocation } from './codeNavigation'

export interface Result<T = any> {
  success: boolean
  data?: T
  error?: string
  errorKind?: ToolResult['errorKind']
  recovery?: ToolRecovery
  retryAfterMs?: number
  receivedStreamData?: boolean
  // TODO: remove this index signature once all IPC/tool results migrate to
  // the `data` envelope pattern instead of flat extra properties.
  [key: string]: any
}

/** Facts about the target file, separate from invocation and durability errors. */
export type FileMutationState = 'committed' | 'not_committed' | 'unknown'
export type FileMutationResult =
  | { success: true; mutation: 'committed'; error?: never }
  | { success: false; mutation: FileMutationState; error: string; errorKind?: ToolResult['errorKind'] }

export interface SearchContentHit {
  file: string
  line: number
  text: string
  context?: string
  contextLines?: Array<{ line: number; text: string; matched?: boolean }>
  endLine?: number
  textTruncated?: boolean
}

export interface SearchContentOptions {
  /** Continue the same captured results. Mutually exclusive with offset. */
  cursor?: string
  offset?: number
  limit?: number
  contextBefore?: number
  contextAfter?: number
  multiline?: boolean
  fileType?: string
  maxColumns?: number
  fixedStrings?: boolean
  includeIgnored?: boolean
  outputMode?: 'content' | 'files' | 'count'
  signal?: AbortSignal
}

export interface SearchContentPage {
  nextCursor?: string
  snapshot?: SearchSnapshot
  incompleteReasons?: SearchIncompleteReason[]
  hits: SearchContentHit[]
  files?: Array<{ file: string; count?: number }>
  outputMode?: 'content' | 'files' | 'count'
  totalMatches: number
  offset: number
  limit: number
  truncated: boolean
  totalIsExact?: boolean
  nextOffset?: number
  warning?: string
}

export interface SearchContentBatchRequest {
  pattern: string
  basePath: string
  filePattern?: string
  caseInsensitive?: boolean
  options?: SearchContentOptions
}

export interface SearchFilesOptions {
  cursor?: string
  offset?: number
  limit?: number
  includeIgnored?: boolean
  signal?: AbortSignal
}

export interface SearchFilesPage {
  nextCursor?: string
  snapshot?: SearchSnapshot
  incompleteReasons?: SearchIncompleteReason[]
  matches: string[]
  offset: number
  limit: number
  totalMatches: number
  totalIsExact: boolean
  truncated: boolean
  nextOffset?: number
  warning?: string
}

export type SearchIncompleteReason = 'capture_budget' | 'timeout' | 'path_error' | 'decode_error' | 'result_budget'

/** A bounded capture, not an atomic filesystem snapshot or live workspace view. */
export interface SearchSnapshot {
  id: string
  capturedAt: string
  expiresAt: string
  consistency: 'captured_results'
}

export interface FileRangeResult {
  content: string
  startLine: number
  endLine: number
  truncated: boolean
  bytesRead: number
  partialLine?: boolean
}

export interface FileByteRangeOptions {
  offset?: number
  maxBytes?: number
  version?: string
  signal?: AbortSignal
}

export interface FileByteRangeResult {
  content: string
  version: string
  offset: number
  endOffset: number
  totalBytes: number
  nextOffset?: number
}

export interface WebSearchResult {
  id?: string
  title: string
  url: string
  canonicalUrl?: string
  domain?: string
  snippet: string
  source?: string
  providers?: string[]
  publishedDate?: string
  score?: number
}

export interface WebSearchProviderStatus {
  provider: string
  status: 'ok' | 'empty' | 'failed'
  resultCount: number
  latencyMs: number
  error?: string
}

export interface WebSearchResponse {
  results: WebSearchResult[]
  provider: string
  query: string
  queries: string[]
  retrievedAt: string
  partial: boolean
  providers: WebSearchProviderStatus[]
  warnings: string[]
}

export interface WebFetchResult {
  sourceId?: string
  totalChars?: number
  nextOffset?: number
  id: string
  url: string
  finalUrl: string
  domain: string
  title: string
  text: string
  excerpt: string
  contentType: string
  publishedDate?: string
  retrievedAt: string
  wordCount: number
  truncated: boolean
  untrusted: true
}

export interface WebFetchResponse {
  pages: WebFetchResult[]
  failures: Array<{ url: string; error: string }>
  retrievedAt: string
  partial: boolean
  warnings: string[]
}

export interface CommandOutput {
  stdout: string
  stderr: string
  exitCode: number | null
  exitSignal?: string
  timedOut?: boolean
  aborted?: boolean
  truncated?: boolean
  logPath?: string
  outputBytes?: number
  /** Local termination evidence only; command/remote side effects remain unknown. */
  termination?: {
    status: 'confirmed' | 'unknown'
    scope: 'owned_group_and_observed_descendants' | 'windows_taskkill_tree'
    escalated: boolean
    error?: string
  }
}

export interface RequestOptions {
  signal?: AbortSignal
  streamId?: number
  timeoutMs?: number
  retry?: boolean
  /** Called for each physical transport attempt, including built-in retries. */
  onAttempt?: (index: number) => void
  /** Called before backoff when a physical attempt fails and transport will retry. */
  onRetry?: (httpStatus?: number) => void
}

export interface ListTreeOptions {
  maxDepth?: number
  maxEntriesPerDirectory?: number
  maxNodes?: number
}

export interface PatchPathIdentity {
  /** Native canonical path, preserving real filesystem spelling. */
  path: string
  /** Native path relative to the canonical operation base. */
  relativePath: string
  /** Operation-local identity only; never persist it as a durable file id. */
  identity: string
}

export interface ToolExecutor {
  // File operations
  resolvePatchPaths(paths: string[], basePath: string, signal?: AbortSignal): Promise<Result<PatchPathIdentity[]>>
  readFile(path: string): Promise<Result<string>>
  readFileRange?(path: string, offset?: number, limit?: number, maxBytes?: number): Promise<Result<FileRangeResult>>
  readFileBytes?(path: string, options?: FileByteRangeOptions): Promise<Result<FileByteRangeResult>>
  writeFile(path: string, content: string, metadata?: Record<string, unknown>): Promise<FileMutationResult>
  deleteFile(path: string, options?: Record<string, any>): Promise<FileMutationResult>
  moveFile?(sourcePath: string, destinationPath: string, options?: { expectedHash?: string; expectedDestinationHash?: string }): Promise<Result<void>>
  listTree(path: string, options?: ListTreeOptions): Promise<Result<TreeNode>>

  // Search operations
  searchFiles(pattern: string, basePath: string, options?: SearchFilesOptions): Promise<Result<Pick<SearchFilesPage, 'matches'> & Partial<Omit<SearchFilesPage, 'matches'>>>>
  searchContent(pattern: string, basePath: string, filePattern?: string, caseInsensitive?: boolean): Promise<Result<SearchContentHit[]>>
  searchContentPage?(pattern: string, basePath: string, filePattern?: string, caseInsensitive?: boolean, options?: SearchContentOptions): Promise<Result<SearchContentPage>>
  searchContentBatch?(requests: SearchContentBatchRequest[]): Promise<Array<Result<SearchContentPage>>>
  navigateCode?(request: CodeNavigationRequest): Promise<Result<CodeNavigationResult>>
  webSearch?(query: Record<string, any>): Promise<Result<WebSearchResponse>>
  readWebSource?(query: { source_id: string; offset?: number; limit?: number; query?: string }): Promise<Result<Record<string, unknown>>>
  webFetch?(query: Record<string, any>): Promise<Result<WebFetchResponse>>

  // Memory operations
  memoryQuery(query: Record<string, any>): Promise<Result<any>>
  memoryRemember(data: Record<string, any>): Promise<Result<any>>
  memoryForget(data: Record<string, any>): Promise<Result<void>>
  memoryUpdate(data: Record<string, any>): Promise<Result<void>>
  memoryList(workspacePath: string, forceReload?: boolean, includeInactive?: boolean): Promise<Result<any>>
  memoryGetRelevantInjection?(query: Record<string, any>): Promise<Result<any>>

  // Terminal operations
  runCommand(command: string, cwd: string, env?: Record<string, string>, timeout?: number, approved?: boolean, signal?: AbortSignal, expectedExitCodes?: number[], presentation?: RuntimeTaskPresentation): Promise<Result<CommandOutput>>
  /** Execute a process while resolving its working directory through read access. */
  readOnlyProcess?(command: string, args: string[], cwd: string, env?: Record<string, string>, timeout?: number, signal?: AbortSignal): Promise<Result<CommandOutput>>
  runProcess?(command: string, args: string[], cwd: string, env?: Record<string, string>, timeout?: number, signal?: AbortSignal): Promise<Result<CommandOutput>>
  validateCommand?(command: string, cwd: string): Promise<Result<void>>
  startBackgroundCommand?(command: string, cwd: string, env?: Record<string, string>, approved?: boolean, presentation?: RuntimeTaskPresentation, expectedExitCodes?: number[], signal?: AbortSignal): Promise<Result<TerminalStartCommandResult>>
  ptyCreate?(options?: { shell?: string; cwd?: string; env?: Record<string, string>; presentation?: RuntimeTaskPresentation; expectedExitCodes?: number[]; signal?: AbortSignal }): Promise<Result<{ sessionId: string; session?: TerminalSessionInfo }>>
  ptyWrite?(sessionId: string, data: string): Promise<Result<void>>
  ptyGetBuffer?(sessionId: string, sinceSeq?: number): Promise<Result<string> & TerminalBufferResult>
  ptyInterruptCommand?(sessionId: string): Promise<Result<void>>
  ptyKill?(sessionId: string): Promise<Result<void>>
  ptyList?(): Promise<Result<TerminalSessionInfo[]>>
  ptyKillAll?(): Promise<Result<void>>

  // Stream operations (API calls)
  sendMessage(url: string, headers: Record<string, string>, body: string, options?: RequestOptions): Promise<Result<string>>
  streamMessage(url: string, headers: Record<string, string>, body: string, onLine: (line: string) => void, options?: RequestOptions): Promise<Result<string>>
  streamAbort?(streamId: number): Promise<void>
}
