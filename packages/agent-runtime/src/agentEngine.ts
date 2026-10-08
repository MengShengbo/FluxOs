import { getModelProviderAdapter, exchangeModelRequest } from '@fluxos/models/modelProvider'
import { toolFailure, type ToolDispatchOutput, fileMutationOutput, type ToolDispatchResult } from './runtime/toolDispatchResult'
import { ToolOutputReadError, ToolOutputStore } from './runtime/toolOutputStore'
import type { ToolOperationStore } from '@fluxos/tools/toolOperationStore'
﻿import type {
  AgentMode,
  AgentAttachment,
  AgentTool,
  AgentSession,
  AgentTurn,
  AgentConfig,
  ContextPolicyMode,
  ToolCall,
  ToolResult,
  TaskNode,
  TokenUsage,
  ModelRequestRecord,
  AgentRunState,
  AgentRunPhase,
  AgentRunInterruption,
  ChangeSummary,
} from '@fluxos/contracts/agentTypes'
import { generateSessionId, generateTurnId } from '@fluxos/contracts/agentTypes'
import { existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { MemoryKind, MemoryScope } from '@fluxos/contracts/memoryTypes'
import { describeBrowserPermission, describeBrowserToolActivity, isBuiltInBrowserTool } from '@fluxos/contracts/browserToolPresentation'
import { computerToolApprovalLevel, describeComputerPermission, describeComputerToolActivity, isBuiltInComputerTool } from '@fluxos/contracts/computerToolPresentation'
import { buildActivatedSkillsContext, buildSystemPrompt, invalidateStaticPromptCache } from './systemPrompt'
import { TaskManager, type TaskTreeNode } from './taskManager'
import { WorkExecutionTracker } from './workExecutionTracker'
import type { WorkExecutionSnapshot, WorkStepControlAction } from '@fluxos/contracts/workExecutionTypes'
import { CacheMonitor, type CacheBreakResult } from './cacheMonitor'
import { observeModelCache } from './modelRequestCache'
import { ModelRequestTracker, type ModelRequestHandle } from './runtime/modelRequestTracker'
import { getToolByName, getToolsForMode, validateToolArgs } from '@fluxos/tools/toolRegistry'
import { applyEdit, stripLineNumberPrefix } from '@fluxos/tools/editHelpers'
import { executePatch } from './runtime/patchExecution'
import { canComputeDiff, computeHunks, summarizeHunks } from '@fluxos/presentation/diffCompute'
import { shouldAutoBackgroundCommand } from '@fluxos/tools/commandExecutionPolicy'
import { ContextManager } from './contextManager'
import {
  buildContextHandoff,
  buildContinuationEvidence,
  buildContinuationSummaryPrompt,
  buildContinuationSummaryAnchors,
  buildDeterministicContinuationSummary,
  collectContinuationHandoffFacts,
  CONTINUATION_SUMMARY_SYSTEM_PROMPT,
  continuationSummaryTokenBudget,
  validateContinuationSummary,
  type ContinuationWorkspaceSnapshot,
} from './contextCompaction'
import { autoCompactThreshold, resolveContextPolicyProfile } from './contextPolicy'
import { countMessagesTokens, countTurnishTokens } from '@fluxos/models/tokenCounter'
import { TurnStrategyPlanner, type TurnStrategy } from './turnStrategy'
import { toolCallSignature } from './toolExecutionLedger'
import { createDefaultPipeline, type PermissionPipeline } from '@fluxos/tools/permissions'
import type { TerminalSessionInfo } from '@fluxos/contracts/terminalTypes'
import type { RuntimeTask, RuntimeTaskEvent, RuntimeTaskPresentation, RuntimeTaskPresentationKind } from '@fluxos/contracts/runtimeTaskTypes'
import { isMcpTool, parseMcpToolName, executeMcpTool, getMcpAgentTools, validateMcpToolArgs } from '@fluxos/extensions/mcp/toolBridge'
import type { McpClient } from '@fluxos/extensions/mcp/client'
import type { SubAgentDefinition, SubAgentEvent } from '@fluxos/contracts/subAgentTypes'
import type { WorkflowCheckpointSpec, WorkflowProgressUpdate, WorkflowRunContract, WorkflowSurfaceSpec } from '@fluxos/contracts/workflowSurfaceTypes'
import { resolvePath, toWorkspaceRelative } from '@fluxos/platform/pathUtils'
import {
  ModelProtocolRequestError,
  buildModelProtocolUrl,
  formatProtocolFailure,
  planModelProtocols,
  protocolLabel,
  shouldFallbackProtocol,
  toProtocolAttempt,
  type ModelProtocol,
  type ModelProtocolAttempt,
} from '@fluxos/models/modelProtocol'
import { dispatchTaskTool, type TaskSystemCreationEvent } from './taskToolDispatcher'
import { SubAgentRegistry, getAvailableAgentTypes } from './subAgentRegistry'
import { AgentOrchestrator, type AutomationSubAgentPolicy } from './agentOrchestrator'
import type { ToolExecutor, WebFetchResponse, WebSearchResponse, RequestOptions, Result } from '@fluxos/contracts/toolExecutor'
import type { AgentStateProvider, APIConfig, APIModel, ContextCompactionState, ContextHandoff, ContextHandoffFacts, ContextReservoirEntry, ContextSegment, WorkspaceInfo } from '@fluxos/contracts/stateTypes'
import type { TreeNode } from '@fluxos/contracts/types'
import type { EnhancedToolDef } from '@fluxos/contracts/toolTypes'
import { parseTextToolCalls, stripTextToolCallMarkup } from '@fluxos/contracts/toolCallMarkup'
import {
  detectGitRepo,
  fetchGitDiff,
  fetchGitLog,
  fetchGitShow,
  fetchGitSnapshot,
  formatGitSnapshotForPrompt,
  formatGitSnapshotForTool,
  gitCommit,
  gitCreateBranch,
  gitPush,
  gitRestorePaths,
  gitRevertCommit,
  gitStagePaths,
  gitUnstagePaths,
  gitStash,
  gitSwitchBranch,
  type GitDiffScope,
  type GitIntegrationState,
  type GitOperationResult,
} from '@fluxos/tools/gitService'
import { hashText } from '@fluxos/platform/fileIO'
import { formatWebSources } from '@fluxos/tools/webSourceStore'
import { RuntimeTaskManager } from '@fluxos/tools/runtimeTaskManager'
import { SubAgentTaskManager } from './runtime/subAgentTaskManager'
import { ChildAgentController } from './runtime/childAgentController'
import { type ChildAgentSnapshot } from '@fluxos/contracts/childAgentTypes'
import { injectSubAgentDeliveries } from './subAgentDelivery'
import { childCompletionBlocker, effectiveRequiredChildren, reconcileSubAgentSteps } from './subAgentStepCoordinator'
import { type SubAgentBudgetConfig } from './subAgentBudget'
import { formatIncompleteChildNotice } from './agentJoinCoordinator'
import { ApprovalCoordinator } from './runtime/approvalCoordinator'
import {
  createAgentRunInterruption,
  interruptionMetadata,
  resolveAgentRunInterruption,
  type AgentRunControlSnapshot,
} from './runtime/runControl'
import { ModelStreamControl } from './runtime/modelStreamControl'
import { AgentEventHub } from './runtime/agentEventHub'
import { AgentSessionRehydrator, type PersistedAgentMessage } from './runtime/agentSessionRehydrator'
import { AgentRunLifecycle } from './runtime/agentRunLifecycle'
import { AgentContextCoordinator } from './runtime/agentContextCoordinator'
import { ToolExecutionCoordinator } from './runtime/toolExecutionCoordinator'
import { ToolCallLifecycle } from './runtime/toolCallLifecycle'
import { appendRuntimeContextToLatestUserMessage } from '@fluxos/models/modelMessages'
import {
  COMPUTER_ERROR_REDACTED,
  COMPUTER_RESULT_REDACTED,
  redactComputerContextSegments,
  redactComputerReservoir,
  redactComputerTurns,
} from '@fluxos/contracts/computerPrivacy'
import { runModelRequest } from '@fluxos/models/modelRequestOrchestrator'
import type { ToolCallBatch } from './toolCallOrchestrator'
import {
  planContextCompaction,
  projectTurnsForModelContext,
} from './contextCompactionBoundary'
import { presentRequestError } from '@fluxos/presentation/requestErrorPresentation'
import { normalizeBuiltInToolArguments } from '@fluxos/tools/toolArgumentNormalization'
import { codeNavigationResult, contentSearchResult, fileSearchResult, formatCodeNavigation, formatRetrievalResult } from '@fluxos/tools/retrievalResults'
import type { RetrievalResult, RetrievedResource } from '@fluxos/contracts/retrievalTypes'
import { commandProcessOutcome, toolInvocationKey, toolRecovery, toolResultExecutionStatus, type CommandProcessOutcome, type ToolResultData } from '@fluxos/contracts/toolResultData'
import { ModelSurface } from '@fluxos/models/modelSurface'
import type { ModelSurfaceState } from '@fluxos/contracts/modelSurfaceTypes'

export {
  extractResponsesReasoningEventDelta,
  extractResponsesReasoningSummary,
} from '@fluxos/models/modelStream'
export {
  appendRuntimeContextToLatestUserMessage,
  normalizeAnthropicToolMessages,
} from '@fluxos/models/modelMessages'
export { splitTurnsForCompaction } from './contextCompactionBoundary'

function describeSemanticToolActivity(
  name: string,
  args: Record<string, unknown>,
  status: 'running' | 'completed' | 'failed',
) {
  return describeComputerToolActivity(name, args, status)
    || describeBrowserToolActivity(name, args, status)
}

function describeSemanticToolPermission(name: string, args: Record<string, unknown>) {
  return describeComputerPermission(name, args)
    || describeBrowserPermission(name, args)
}

export function countTurnContextChars(turn: AgentTurn): number {
  let total = turn.content?.length ?? 0
  total += turn.metadata?.runtimeContext?.length ?? 0

  if (turn.toolCalls) {
    for (const toolCall of turn.toolCalls) {
      total += toolCall.name.length + 2
      try {
        total += JSON.stringify(toolCall.arguments).length
      } catch {}
    }
  }
  if (turn.toolResults) {
    for (const toolResult of turn.toolResults) {
      total += toolResult.output.length + 1
      const change = toolResult.changeSummary
      if (change) {
        total += change.path.length + change.operation.length
        total += change.preview?.length ?? 0
        total += change.oldPreview?.length ?? 0
        total += change.before?.length ?? 0
        total += change.after?.length ?? 0
      }
    }
  }

  const rawReasoning = turn.metadata?.rawReasoningPayload
  let rawReasoningChars = rawReasoning?.reasoningContent?.length ?? 0
  if (rawReasoning?.blocks) {
    for (const block of rawReasoning.blocks) {
      rawReasoningChars += block.thinking?.length ?? 0
      rawReasoningChars += block.signature?.length ?? 0
      rawReasoningChars += block.data?.length ?? 0
    }
  }
  total += rawReasoningChars > 0
    ? rawReasoningChars
    : (turn.metadata?.thinking?.content.length ?? 0)
  return total
}

const DEFAULT_MODEL_READ_LINES = 200
const MODEL_READ_MAX_LINES = 2_000
const MODEL_READ_MAX_BYTES = 48 * 1024
const MODEL_READ_FULL_MAX_BYTES = 80 * 1024
const DEFAULT_TOOL_RESULT_MAX_CHARS = 20_000
const MAX_IDENTICAL_TOOL_FAILURES = 3
const DEFAULT_MAX_TOOL_ROUNDS_PER_RUN = 96
const CONTEXT_COMPACTION_REQUEST_TIMEOUT_MS = 45_000
const MODEL_TRANSIENT_RETRY_DELAYS_MS = [1_500, 5_000, 15_000]
const MODEL_TRANSIENT_RETRYABLE_STATUSES = new Set([408, 409, 425, 429])
const MAX_MODEL_TRANSIENT_RETRY_DELAY_MS = 120_000
const MODEL_TRANSIENT_RETRY_BUDGET_MS = 120_000
const MAX_STREAM_TOOL_ARGUMENT_PREVIEW_CHARS = 2_048

function streamToolArgumentPreview(value: string): string {
  if (value.length <= MAX_STREAM_TOOL_ARGUMENT_PREVIEW_CHARS) return value
  return value.slice(-MAX_STREAM_TOOL_ARGUMENT_PREVIEW_CHARS)
}

type PromptModuleSnapshot = {
  id: string
  label: string
  hash: string
  chars: number
  stable: boolean
}

interface WarmRequestPrefix {
  protocol: ModelProtocol
  body: Record<string, unknown>
}

export type AgentEventType =
  | { type: 'run:state'; state: AgentRunState }
  | { type: 'turn:start'; turn: AgentTurn }
  | { type: 'turn:complete'; turn: AgentTurn }
  | { type: 'tool:call'; toolCall: ToolCall }
  | { type: 'tool:result'; toolResult: ToolResult }
  | { type: 'task:update'; taskId: string; status: string; progress: number }
  | { type: 'work:execution'; snapshot: WorkExecutionSnapshot }
  | { type: 'mode:change'; from: AgentMode; to: AgentMode }
  | { type: 'session:complete'; session: AgentSession }
  | { type: 'error'; error: string }
  | { type: 'notification'; message: string; level: 'info' | 'success' | 'warning' | 'error' }
  | { type: 'model:protocol'; phase: 'attempt' | 'fallback' | 'success'; protocol: ModelProtocol; url: string; message?: string }
  | { type: 'stream:delta'; text: string }
  | { type: 'stream:thinking_delta'; text: string }
  | { type: 'stream:tool_call_delta'; toolCallId: string; toolName: string; partialJson: string }
  | { type: 'stream:start' }
  | { type: 'stream:end'; interrupted?: boolean }
  | { type: 'stream:usage'; usage: TokenUsage; requestId?: string; attemptId?: string }
  | { type: 'model:request'; request: ModelRequestRecord }
  | { type: 'ask:user'; question: string; options?: string[]; reason?: string; command?: string; requestId?: string; toolName?: string; path?: string; queuedCount?: number; ui?: WorkflowSurfaceSpec }
  | { type: 'approval:state'; requestId: string; requestKind: 'permission' | 'input'; state: 'requested' | 'resolved' | 'cancelled'; decision?: string; question: string; options?: string[]; reason?: string; toolName?: string; path?: string; ui?: WorkflowSurfaceSpec }
  | { type: 'input:state'; inputId: string; intent: 'steer'; state: 'accepted' | 'committed' | 'rejected'; text: string; reason?: string }
  | { type: 'active:task'; context: import('./taskManager').ActiveTaskContext | null }
  | { type: 'terminal:sessions'; sessions: TerminalSessionInfo[] }
  | { type: 'runtime-task:created'; task: RuntimeTask }
  | { type: 'runtime-task:updated'; task: RuntimeTask }
  | { type: 'runtime-task:finished'; task: RuntimeTask }
  | {
    type: 'task:system'
    context: import('./taskManager').ActiveTaskContext | null
    tree: TaskTreeNode[]
    creation?: TaskSystemCreationEvent | null
  }
  | { type: 'context:segment_created'; segment: ContextSegment }
  | { type: 'context:compaction_started'; state: ContextCompactionState }
  | { type: 'context:compaction_summarizing'; state: ContextCompactionState }
  | { type: 'context:compaction_fallback'; state: ContextCompactionState }
  | { type: 'context:compaction_committing'; state: ContextCompactionState }
  | { type: 'context:compaction_progress'; state: ContextCompactionState }
  | { type: 'context:compaction_completed'; state: ContextCompactionState }
  | { type: 'context:compaction_interrupted'; state: ContextCompactionState }
  | { type: 'context:compaction_failed'; state: ContextCompactionState }
  | { type: 'git:state'; state: GitIntegrationState }
  | { type: 'child-agent:update'; agent: ChildAgentSnapshot }
  | { type: 'subagent:start'; agentId: string; agentType: string; label: string; objective: string }
  | { type: 'subagent:progress'; agentId: string; agentType: string; label: string; event: SubAgentEvent }
  | { type: 'subagent:end'; agentId: string; agentType: string; ok: boolean; elapsedMs: number }
  | { type: 'cache:diagnostic'; result: CacheBreakResult }
  | { type: 'cache:modules'; modules: PromptModuleSnapshot[] }

export type AgentEventListener = (event: AgentEventType) => void
export type AgentEventRecorder = (event: AgentEventType) => void

type AskUserEvent = Extract<AgentEventType, { type: 'ask:user' }>

interface EngineInteractiveRequest {
  id: string
  kind: 'permission' | 'input'
  event: AskUserEvent
}

export { downgradeReasoningEffort } from '@fluxos/models/requestCompatibility'

function stableHash(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>
      const output: Record<string, unknown> = {}
      for (const key of Object.keys(record).sort()) output[key] = normalize(record[key])
      return output
    }
    return input
  }
  const text = JSON.stringify(normalize(value))
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}

function normalizeLocalPreviewUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value.trim())
    const hostname = parsed.hostname.toLowerCase()
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined
    if (hostname === '0.0.0.0') parsed.hostname = 'localhost'
    else if (hostname !== 'localhost' && hostname !== '[::1]' && hostname !== '::1' && !hostname.startsWith('127.')) return undefined
    return parsed.href
  } catch {
    return undefined
  }
}

export class AgentEngine {
  private session: AgentSession
  private taskManager: TaskManager
  private workExecution: WorkExecutionTracker
  private readonly events = new AgentEventHub<AgentEventType>()
  private readonly sessionRehydrator = new AgentSessionRehydrator()
  private readonly runLifecycle: AgentRunLifecycle<AgentTurn[]>
  private destroyed = false
  private shutdownPromise: Promise<void> | null = null
  private get runControl() {
    return this.runLifecycle.control
  }
  private get currentRunPromise(): Promise<AgentTurn[]> | null {
    return this.runLifecycle.getRunPromise()
  }
  private get abortController(): AbortController | null {
    return this.runControl.getRunController()
  }
  private set abortController(controller: AbortController | null) {
    this.runControl.setRunController(controller)
  }
  private get operationAbortController(): AbortController | null {
    return this.runControl.getOperationController()
  }
  private set operationAbortController(controller: AbortController | null) {
    this.runControl.setOperationController(controller)
  }
  private readonly modelStreams = new ModelStreamControl()
  private unsubscribeTaskManager: (() => void) | null = null
  private readonly contextCoordinator: AgentContextCoordinator
  private get contextManager(): ContextManager {
    return this.contextCoordinator.manager
  }
  private get preservedFiles(): Array<{ path: string; content: string }> {
    return this.contextCoordinator.preservedFiles
  }
  private set preservedFiles(files: Array<{ path: string; content: string }>) {
    this.contextCoordinator.preservedFiles = files
  }
  private get compressionPreparedTurnCount(): number {
    return this.contextCoordinator.compressionPreparedTurnCount
  }
  private set compressionPreparedTurnCount(value: number) {
    this.contextCoordinator.compressionPreparedTurnCount = value
  }
  private get forceContextCompactionBeforeNextCall(): boolean {
    return this.contextCoordinator.forceContextCompactionBeforeNextCall
  }
  private set forceContextCompactionBeforeNextCall(value: boolean) {
    this.contextCoordinator.forceContextCompactionBeforeNextCall = value
  }
  private get contextLimitRetryInProgress(): boolean {
    return this.contextCoordinator.contextLimitRetryInProgress
  }
  private set contextLimitRetryInProgress(value: boolean) {
    this.contextCoordinator.contextLimitRetryInProgress = value
  }
  private readonly interactiveRequests: ApprovalCoordinator<EngineInteractiveRequest, string>
  private readonly resolvedAskUserResponses = new Map<string, string>()
  private toolCallTaskMap: Map<string, string> = new Map()
  private commandToolCallSessions = new Map<string, string>()
  private fileBeforeSnapshots: Map<string, string | null> = new Map()
  // Registry of background PTY sessions the agent has spawned via
  // run_command(run_in_background=true). Tracks the command + start time so
  // list_terminals / read_terminal can label them. Foreground commands use
  // the command execution path and do not need a session.
  private agentBackgroundSessions: Map<string, { command: string; startedAt: number; expectedExitCodes: number[] }> = new Map()
  private turnStrategyPlanner: TurnStrategyPlanner = new TurnStrategyPlanner()
  private currentTurnStrategy: TurnStrategy | null = null
  private cachedGitStatus: string | null = null
  private gitDetected: boolean = false
  private gitGeneration = 0
  private gitState: GitIntegrationState = {
    enabled: false,
    phase: 'detecting',
    snapshot: null,
    updatedAt: Date.now(),
  }
  // Workspace long-term memory (M1: static loaders only).
  // Injection text is owned by the main process MemoryService — we just
  // cache the latest copy plus its fingerprint so we don't re-IPC every turn.
  // Re-fetched lazily when (workspacePath, fingerprint) changes; the main
  // process produces the fingerprint from on-disk mtimes so user edits to
  // CLAUDE.md / .cursorrules / etc. propagate without explicit invalidation.
  private workspaceMemoryText: string | null = null
  private workspaceMemoryWorkspace: string | null = null
  private workspaceMemoryBuiltAt: number = 0
  private cacheMonitor = new CacheMonitor()
  private modelSurface = new ModelSurface()
  private readonly warmRequestPrefixes = new Map<ModelProtocol, WarmRequestPrefix>()
  private permissions: PermissionPipeline = createDefaultPipeline()
  private currentRunToolNames: string[] = []
  private currentRunReadFiles: Set<string> = new Set()
  private currentRunSuccessfulReadFiles: Set<string> = new Set()
  private currentRunSearches: Set<string> = new Set()
  private currentRunSuccessfulSearches: Set<string> = new Set()
  private readonly toolCallLifecycle: ToolCallLifecycle
  private readonly agentRegistry = new SubAgentRegistry()
  private readonly toolExecutionCoordinator: ToolExecutionCoordinator
  private conclusionGuardAttempts: number = 0
  private finalDeliveryRetryAttempts: number = 0
  private disabledToolNames: Set<string> = new Set()
  private readonly toolOutputStore = new ToolOutputStore()
  private pendingAssistantMessageId: string | null = null
  private providerTransientRetryAttempt = 0
  private providerTransientRetryStartedAt = 0
  private readonly modelRequestTracker = new ModelRequestTracker(request => this.emit({ type: 'model:request', request }))
  private activeModelAttempt: ModelRequestHandle | undefined
  private lastModelAttempt: ModelRequestRecord | undefined
  private modelRequestId = ''
  private currentModelRequestRound = 0
  private toolExecutor: ToolExecutor
  private stateProvider: AgentStateProvider
  private subAgentTaskManager: SubAgentTaskManager
  private readonly orchestration: AgentOrchestrator
  setChildAgentController(controller: ChildAgentController): void { this.orchestration.setChildAgentController(controller) }
  getChildAgentController(): ChildAgentController | null { return this.orchestration.getChildAgentController() }
  publishChildAgentSnapshot(agent: ChildAgentSnapshot): void { this.emit({ type: 'child-agent:update', agent }) }
  followupChildAgent(agentId: string, message: string): string { return this.orchestration.followupChildAgent(agentId, message) }
  closeChildAgent(agentId: string): Promise<void> { return this.orchestration.close(agentId) }
  retrySubAgentTask(taskId: string): RuntimeTask { return this.orchestration.retrySubAgentTask(taskId) }
  private mcpClient: McpClient | null = null
  private loadedMcpToolNames = new Set<string>()
  private activatedRunSkills = new Map<string, NonNullable<AgentConfig['enabledSkills']>[number]>()
  private activeWorkflowContract: WorkflowRunContract | null = null
  private completedWorkflowStages = new Set<string>()
  private workflowProgressHandler: ((update: WorkflowProgressUpdate) => void) | null = null

  setMcpClient(client: McpClient): void {
    this.toolOutputStore.clear()
    this.mcpClient = client
    this.loadedMcpToolNames.clear()
  }

  enableMcpServerTools(serverName: string): number {
    if (!this.mcpClient) return 0
    const connection = this.mcpClient.getConnection(serverName)
    if (!connection || connection.status !== 'connected') return 0
    const allowedNames = new Set(this.availableMcpTools().map(tool => tool.name))
    const tools = connection.tools.filter(tool => allowedNames.has(tool.name))
    for (const tool of tools) this.loadedMcpToolNames.add(tool.name)
    return tools.length
  }

  private availableMcpTools(): AgentTool[] {
    if (!this.mcpClient) return []
    return getMcpAgentTools(this.mcpClient).filter(tool => !this.disabledToolNames.has(tool.name)
      && (!this.config.allowedTools || this.config.allowedTools.includes(tool.name))
      && ((this.config.mode !== 'plan' && this.config.capabilityProfile !== 'read-only') || tool.isReadOnly))
  }

  private modelMcpTools(): AgentTool[] {
    const tools = this.availableMcpTools()
    const availableNames = new Set(tools.map(tool => tool.name))
    for (const name of this.loadedMcpToolNames) if (!availableNames.has(name)) this.loadedMcpToolNames.delete(name)
    return tools.filter(tool => this.loadedMcpToolNames.has(tool.name))
  }

  setEventRecorder(recorder: AgentEventRecorder | null): void {
    this.events.setRecorder(recorder)
  }

  constructor(
    private config: AgentConfig,
    toolExecutor: ToolExecutor,
    stateProvider: AgentStateProvider,
    subAgentTaskManager?: SubAgentTaskManager,
    operationServices?: { store: ToolOperationStore; memoryRoot?: string },
  ) {
    this.toolExecutor = toolExecutor
    this.stateProvider = stateProvider
    this.contextCoordinator = new AgentContextCoordinator(stateProvider, {
      onCompactionEvent: (eventType, state) => {
        this.emit({ type: eventType, state } as AgentEventType)
      },
    })
    this.subAgentTaskManager = subAgentTaskManager || new SubAgentTaskManager({
      workspacePath: config.workspacePath || '',
      runtimeTaskManager: new RuntimeTaskManager({ defaultOwnerSessionId: config.conversationId }),
      ownerSessionId: config.conversationId,
      storageDir: false,
    })
    this.interactiveRequests = new ApprovalCoordinator(
      (request, queuedCount) => {
        const semanticPermission = request.event.toolName
          ? describeSemanticToolPermission(request.event.toolName, {})
          : null
        this.setRunStateAfterPause(request.kind === 'permission' ? 'awaiting_approval' : 'awaiting_input', {
          detail: request.kind === 'permission'
            ? semanticPermission ? `等待确认：${semanticPermission.title}` : `Reviewing ${request.event.toolName || 'tool'}`
            : 'Waiting for your answer',
          activeTool: request.event.toolName,
        })
        this.emit({ ...request.event, queuedCount })
      },
      ({ request, state, decision }) => {
        this.emit({
          type: 'approval:state',
          requestId: request.id,
          requestKind: request.kind,
          state,
          decision,
          question: request.event.question,
          options: request.event.options,
          reason: request.event.reason,
          toolName: request.event.toolName,
          path: request.event.path,
          ui: request.event.ui,
        })
      },
    )
    this.permissions.setApprovalPolicy(config.approvalPolicy || 'agent')
    const now = Date.now()
    const gitEnabled = config.gitEnabled !== false
    this.gitState = {
      enabled: gitEnabled,
      phase: gitEnabled ? 'detecting' : 'disabled',
      snapshot: null,
      updatedAt: now,
    }
    this.session = {
      id: config.conversationId || generateSessionId(),
      mode: config.mode,
      turns: [],
      currentTaskId: null,
      createdAt: now,
      updatedAt: now,
      workspacePath: config.workspacePath,
      workspaceName: config.workspaceName,
      totalTokens: { input: 0, output: 0 },
      modelSurface: this.modelSurface.getState(),
    }
    this.taskManager = new TaskManager()
    this.taskManager.setCompletionGuard(task => childCompletionBlocker(
      task, this.taskManager, this.orchestration.currentRunSubAgents(),
      new Set(this.subAgentTaskManager.listPendingCompletions(this.config.conversationId, this.workExecution.getCurrentRunId() || undefined).map(result => result.agentId)),
    ))
    this.workExecution = new WorkExecutionTracker(this.session.id)
    this.orchestration = new AgentOrchestrator({
      getConfig: () => this.config,
      getRunId: () => this.workExecution.getCurrentRunId(),
      getParentObjective: () => this.workExecution.getSnapshot(this.taskManager).runs.find(run => run.id === this.workExecution.getCurrentRunId())?.objective,
      getTaskManager: () => this.taskManager,
      stateProvider, toolExecutor, registry: this.agentRegistry, tasks: this.subAgentTaskManager,
      emit: event => this.emit(event),
    })
    this.runLifecycle = new AgentRunLifecycle<AgentTurn[]>({
      onStateChanged: state => {
        this.workExecution.setPhase(state.phase, state.detail)
        this.emit({ type: 'run:state', state })
        this.emitWorkExecution()
      },
      onStateFallback: state => {
        this.workExecution.setPhase(state.phase, state.detail)
      },
      onInputState: (input, state, reason) => {
        this.emit({
          type: 'input:state',
          inputId: input.id,
          intent: 'steer',
          state,
          text: input.text,
          ...(reason ? { reason } : {}),
        })
      },
      onNotification: message => this.emit({ type: 'notification', message, level: 'info' }),
    })
    this.toolCallLifecycle = new ToolCallLifecycle({
      runControl: this.runControl,
      resolveTool: name => this.resolveToolDefinition(name),
      validate: (toolCall, tool) => this.validateToolCall(toolCall, tool),
      authorize: (toolCall, signal) => this.checkToolPermission(toolCall, signal),
      execute: (toolCall, tool, signal) => this.dispatchValidatedTool(toolCall, tool, signal),
      writeScope: () => ({ workspacePath: this.config.workspacePath, sessionId: this.session.id, memoryRoot: operationServices?.memoryRoot }),
      ...(operationServices ? { operations: {
        store: operationServices.store,
        identity: (call: ToolCall) => {
          if (call.operationIdentity) {
            if (call.operationIdentity.sessionId !== this.session.id) throw new Error('Operation belongs to another session')
            return call.operationIdentity
          }
          // Provider call IDs can repeat across requests. The durable assistant
          // turn is part of the identity; arguments belong in a separate digest.
          const turns = this.session.turns
          for (let index = turns.length - 1; index >= 0; index--) {
            const turn = turns[index]
            if (turn.role === 'assistant' && turn.toolCalls?.some(candidate => candidate.id === call.id)) {
              call.operationIdentity = { sessionId: this.session.id, turnId: turn.id, callId: call.id }
              return call.operationIdentity
            }
          }
          throw new Error('No assistant turn owns this durable tool operation')
        },
      } } : {}),
    })
    this.toolExecutionCoordinator = new ToolExecutionCoordinator({
      maxConcurrency: () => this.config.maxParallelToolCalls,
      resolveTool: name => this.resolveToolDefinition(name),
      isWrite: toolCall => this.isWriteToolCall(toolCall),
      isReadAfterWriteSensitive: toolCall => this.isReadAfterWriteSensitiveToolCall(toolCall),
      execute: (toolCall, signal) => this.executeSingleTool(toolCall, signal),
      onCallsStarted: toolCalls => {
        for (const toolCall of toolCalls) this.linkToolCallToActiveTask(toolCall)
        this.emitActiveTaskContext()
        for (const toolCall of toolCalls) this.emit({ type: 'tool:call', toolCall })
      },
      onResult: (toolCall, result) => {
        try {
          this.emit({ type: 'tool:result', toolResult: result })
        } finally {
          this.updateTaskToolCallStatus(result)
        }
      },
      onSettled: () => this.emitActiveTaskContext(),
    })

    // 加载动态代理定义（.fluxagent/agents/*.md）
    if (config.workspacePath) {
      this.agentRegistry.reload(config.workspacePath)
    }
    this.unsubscribeTaskManager = this.taskManager.subscribe(event => {
      if (event.type === 'task:created' || event.type === 'task:updated') {
        this.emit({
          type: 'task:update',
          taskId: event.task.id,
          status: event.task.status,
          progress: event.task.progress,
        })
        this.emitActiveTaskContext()
        this.emitWorkExecution()
      }

      if (event.type === 'tasks:cleared') {
        this.emitActiveTaskContext()
        this.emitWorkExecution()
      }
    })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    const errors: unknown[] = []
    for (const dispose of [
      () => this.unsubscribeTaskManager?.(),
      () => this.runLifecycle.destroy(),
      () => this.contextCoordinator.destroy(),
      () => this.interactiveRequests.cancelAll('deny'),
      () => this.resolvedAskUserResponses.clear(),
      () => this.modelStreams.clear(),
      () => this.toolOutputStore.clear(),
      () => this.subAgentTaskManager.destroy(),
      () => this.events.clear(),
    ]) {
      try { dispose() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Agent destruction failed')
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    // Close admission synchronously; publish cancellation after storing the promise.
    this.shutdownPromise = Promise.resolve().then(async () => {
      const errors: unknown[] = []
      try { this.abort() } catch (error) { errors.push(error) }
      try {
        await this.waitUntilIdle()
        await this.subAgentTaskManager.shutdown()
      } finally {
        this.destroy()
      }
      if (errors.length) throw new AggregateError(errors, 'Agent shutdown failed')
    })
    return this.shutdownPromise
  }

  getMode(): AgentMode {
    return this.session.mode
  }

  setMode(mode: AgentMode, options?: { emitRuntimeEvent?: boolean }): void {
    const oldMode = this.session.mode
    this.session.mode = mode
    this.config.mode = mode
    invalidateStaticPromptCache()
    if (options?.emitRuntimeEvent !== false) this.emit({ type: 'mode:change', from: oldMode, to: mode })
  }

  setAppendSystemPrompt(appendSystemPrompt: string | undefined): void {
    this.config.appendSystemPrompt = appendSystemPrompt
  }

  setConversationId(conversationId: string): void {
    this.config.conversationId = conversationId
    this.session.id = conversationId
    this.stateProvider.setConversationId?.(conversationId)
    this.workExecution.setConversationId(conversationId)
  }

  getConversationId(): string | undefined {
    return this.config.conversationId
  }

  updateRuntimeConfiguration(update: Partial<Pick<AgentConfig,
    'approvalPolicy' | 'capabilityProfile' | 'gitEnabled' | 'contextWindow' | 'maxTokens' | 'profileSystemPrompt' | 'maxToolRounds' | 'maxParallelToolCalls'
  >>): void {
    if (update.approvalPolicy !== undefined && update.approvalPolicy !== this.config.approvalPolicy) {
      this.setApprovalPolicy(update.approvalPolicy)
    }
    if (update.gitEnabled !== undefined && update.gitEnabled !== this.gitState.enabled) {
      this.setGitEnabled(update.gitEnabled)
    }
    if (update.capabilityProfile !== undefined) this.config.capabilityProfile = update.capabilityProfile
    if (update.maxToolRounds !== undefined) this.config.maxToolRounds = update.maxToolRounds
    if (update.maxParallelToolCalls !== undefined) this.config.maxParallelToolCalls = update.maxParallelToolCalls
    if (update.contextWindow !== undefined) this.config.contextWindow = update.contextWindow
    if (update.maxTokens !== undefined) this.config.maxTokens = update.maxTokens
    if (update.profileSystemPrompt !== undefined && update.profileSystemPrompt !== this.config.profileSystemPrompt) {
      this.config.profileSystemPrompt = update.profileSystemPrompt
      this.invalidateStaticPromptCache()
    }
  }

  setEnabledSkills(skills: AgentConfig['enabledSkills']): void {
    this.config.enabledSkills = skills
  }

  /** 热重载动态代理定义 */
  reloadAgents(): void {
    if (this.config.workspacePath) {
      this.agentRegistry.reload(this.config.workspacePath)
    }
  }

  isRunning(): boolean {
    return this.runLifecycle.isRunning()
  }

  getAgentDefinitions(): SubAgentDefinition[] {
    return this.agentRegistry.definitions()
  }

  getRunControlSnapshot(): AgentRunControlSnapshot {
    return this.runLifecycle.getControlSnapshot()
  }

  isContextCompacting(): boolean {
    return this.contextCoordinator.isCompacting()
  }

  setContextPolicy(mode: ContextPolicyMode): void {
    this.config.contextPolicy = mode
    this.compressionPreparedTurnCount = 0
  }

  setApprovalPolicy(policy: NonNullable<AgentConfig['approvalPolicy']>): void {
    this.config.approvalPolicy = policy
    this.permissions.setApprovalPolicy(policy)
  }

  getApprovalPolicy(): NonNullable<AgentConfig['approvalPolicy']> {
    return this.permissions.getApprovalPolicy()
  }

  getGitState(): GitIntegrationState {
    return {
      ...this.gitState,
      snapshot: this.gitState.snapshot
        ? { ...this.gitState.snapshot, files: [...this.gitState.snapshot.files], recentCommits: [...this.gitState.snapshot.recentCommits], branches: [...(this.gitState.snapshot.branches || [])] }
        : null,
      operation: this.gitState.operation ? { ...this.gitState.operation } : undefined,
    }
  }

  setGitEnabled(enabled: boolean): void {
    this.gitGeneration += 1
    this.config.gitEnabled = enabled
    if (!enabled) {
      this.cachedGitStatus = null
      this.updateGitState({ enabled: false, phase: 'disabled', snapshot: null, error: undefined, operation: undefined })
    } else {
      this.gitDetected = false
      this.updateGitState({ enabled: true, phase: 'detecting', snapshot: null, error: undefined })
      void this.initializeGit(true)
    }
    this.invalidateStaticPromptCache()
  }

  async initializeGit(force = false): Promise<boolean> {
    if (!this.gitState.enabled) return false
    const generation = this.gitGeneration
    if (!this.config.workspacePath) {
      this.cachedGitStatus = null
      this.updateGitState({ phase: 'unavailable', snapshot: null, error: undefined, operation: undefined })
      return false
    }
    if (this.gitDetected && !force) return this.gitState.phase === 'ready' || this.gitState.phase === 'syncing'
    this.updateGitState({ phase: 'detecting', error: undefined })
    this.gitDetected = true
    const isRepo = await detectGitRepo(this.config.workspacePath, this.toolExecutor)
    if (generation !== this.gitGeneration || !this.gitState.enabled) return false
    if (!isRepo) {
      this.cachedGitStatus = null
      this.updateGitState({ phase: 'unavailable', snapshot: null, error: undefined, operation: undefined })
      return false
    }
    await this.refreshGitStatus(generation)
    return this.gitState.phase === 'ready'
  }

  private invalidateStaticPromptCache(): void {
    invalidateStaticPromptCache()
  }

  async refreshGitStatus(expectedGeneration = this.gitGeneration): Promise<void> {
    if (!this.gitState.enabled || !this.config.workspacePath) return
    if (this.gitState.phase === 'unavailable' || this.gitState.phase === 'disabled') return
    const snapshot = await fetchGitSnapshot(this.config.workspacePath, this.toolExecutor).catch(() => null)
    if (expectedGeneration !== this.gitGeneration || !this.gitState.enabled) return
    this.cachedGitStatus = snapshot ? formatGitSnapshotForPrompt(snapshot) : null
    this.updateGitState({
      phase: snapshot ? 'ready' : 'error',
      snapshot,
      error: snapshot ? undefined : 'Unable to read Git repository state',
    })
    this.invalidateStaticPromptCache()
  }

  private updateGitState(patch: Partial<GitIntegrationState>): void {
    this.gitState = { ...this.gitState, ...patch, updatedAt: Date.now() }
    this.emit({ type: 'git:state', state: this.getGitState() })
  }

  private async runGitOperation(
    name: string,
    operation: () => Promise<GitOperationResult>,
  ): Promise<GitOperationResult> {
    if (!this.gitState.enabled || !this.config.workspacePath) {
      return { ok: false, error: 'Git integration is not active for this workspace' }
    }
    if (this.gitState.phase === 'syncing') {
      return { ok: false, error: 'Another Git operation is already running' }
    }
    if (this.gitState.phase !== 'ready' && !await this.initializeGit(true)) {
      return { ok: false, error: this.gitState.error || 'Git repository is not ready' }
    }
    this.updateGitState({
      phase: 'syncing',
      error: undefined,
      operation: { name, status: 'running', updatedAt: Date.now() },
    })
    let result: GitOperationResult
    const generation = this.gitGeneration
    try {
      result = await operation()
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const snapshot = await fetchGitSnapshot(this.config.workspacePath, this.toolExecutor).catch(() => null)
    if (generation !== this.gitGeneration || !this.gitState.enabled) return result
    this.cachedGitStatus = snapshot ? formatGitSnapshotForPrompt(snapshot) : null
    this.updateGitState({
      phase: result.ok ? 'ready' : 'error',
      snapshot,
      error: result.ok ? undefined : result.error || `${name} failed`,
      operation: {
        name,
        status: result.ok ? 'success' : 'error',
        message: result.ok ? result.output : result.error,
        hash: result.hash,
        updatedAt: Date.now(),
      },
    })
    this.invalidateStaticPromptCache()
    return result
  }

  async stageGitPaths(paths: string[]): Promise<GitOperationResult> {
    if (!this.config.workspacePath) return { ok: false, error: 'No workspace selected' }
    return this.runGitOperation('stage', () => gitStagePaths(this.config.workspacePath!, paths, this.toolExecutor))
  }

  async unstageGitPaths(paths: string[]): Promise<GitOperationResult> {
    if (!this.config.workspacePath) return { ok: false, error: 'No workspace selected' }
    return this.runGitOperation('unstage', () => gitUnstagePaths(this.config.workspacePath!, paths, this.toolExecutor))
  }

  async commitGit(message: string, paths?: string[]): Promise<GitOperationResult> {
    if (!this.config.workspacePath) return { ok: false, error: 'No workspace selected' }
    return this.runGitOperation('commit', () => gitCommit(this.config.workspacePath!, message, this.toolExecutor, paths))
  }

  async createGitBranch(name: string, startPoint?: string): Promise<GitOperationResult> {
    if (!this.config.workspacePath) return { ok: false, error: 'No workspace selected' }
    return this.runGitOperation('create-branch', () => gitCreateBranch(this.config.workspacePath!, name, this.toolExecutor, startPoint))
  }

  async switchGitBranch(name: string): Promise<GitOperationResult> {
    if (!this.config.workspacePath) return { ok: false, error: 'No workspace selected' }
    return this.runGitOperation('switch-branch', () => gitSwitchBranch(this.config.workspacePath!, name, this.toolExecutor))
  }

  async restoreGitPaths(paths: string[], source = 'HEAD'): Promise<GitOperationResult> {
    if (!this.config.workspacePath) return { ok: false, error: 'No workspace selected' }
    return this.runGitOperation('restore', () => gitRestorePaths(this.config.workspacePath!, paths, this.toolExecutor, source))
  }

  async pushGit(options: { remote?: string; branch?: string; setUpstream?: boolean } = {}): Promise<GitOperationResult> {
    if (!this.config.workspacePath) return { ok: false, error: 'No workspace selected' }
    return this.runGitOperation('push', () => gitPush(this.config.workspacePath!, this.toolExecutor, options))
  }

  async readGitDiff(path?: string, scope: GitDiffScope = 'working'): Promise<GitOperationResult> {
    if (!this.config.workspacePath) return { ok: false, error: 'No workspace selected' }
    return fetchGitDiff(this.config.workspacePath, this.toolExecutor, scope, path)
  }

  async compactContext(): Promise<void> {
    this.assertAvailable()
    await this.performContextCompaction('manual')
  }

  getTokenUsage(): { input: number; output: number } {
    return { ...this.session.totalTokens }
  }

  getContextUsage(): TokenUsage {
    return this.contextManager.getCurrentContextUsage()
  }

  getModelSurfaceState(): ModelSurfaceState {
    this.modelSurface.syncTurns(this.session.turns)
    const state = this.modelSurface.getState()
    this.session.modelSurface = state
    return state
  }

  restoreModelSurfaceState(state: ModelSurfaceState | undefined, fallbackTurns: AgentTurn[] = this.session.turns): void {
    this.modelSurface.restore(state, fallbackTurns)
    this.session.modelSurface = this.modelSurface.getState()
    this.cacheMonitor.resetBaseline()
  }

  getContextSegments(): ContextSegment[] {
    return this.contextCoordinator.getSegments()
  }

  setContextSegments(segments: ContextSegment[]): void {
    this.contextCoordinator.setSegments(segments)
  }

  getContextReservoir(): ContextReservoirEntry[] {
    return this.contextCoordinator.getReservoir()
  }

  setContextReservoir(entries: ContextReservoirEntry[]): void {
    this.contextCoordinator.setReservoir(entries)
  }

  /**
   * Drop native Computer observations and action payloads once a run is over.
   * The persisted/UI projections already redact these values, but keeping the
   * raw screenshots, coordinates, AX values, and typed text in the live
   * session would make a later snapshot or recovery path unnecessarily risky.
   */
  expireComputerToolPayloads(): void {
    const reservoir = this.stateProvider.getContextReservoir()
    const reservoirTurns = reservoir.flatMap(entry => entry.turns)
    const allTurns = [...this.session.turns, ...reservoirTurns]
    this.stateProvider.setContextSegments(
      redactComputerContextSegments(this.stateProvider.getContextSegments(), allTurns),
    )
    this.stateProvider.setContextReservoir(redactComputerReservoir(reservoir))
    this.session.turns = redactComputerTurns(this.session.turns)
  }

  getContextCompactionState(): ContextCompactionState | null {
    return this.contextCoordinator.getCompactionState()
  }

  setContextCompactionState(state: ContextCompactionState | null): void {
    this.contextCoordinator.setCompactionState(state)
  }

  getFullConversationTurns(): AgentTurn[] {
    const systemTurns = this.session.turns.filter(turn => turn.role === 'system')
    const liveTurns = this.session.turns.filter(turn => turn.role !== 'system')
    const orderedIds: string[] = []
    const turnsById = new Map<string, AgentTurn>()
    const addTurn = (turn: AgentTurn) => {
      if (!turnsById.has(turn.id)) orderedIds.push(turn.id)
      turnsById.set(turn.id, turn)
    }
    this.stateProvider.getContextReservoir()
      .slice()
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      .forEach(entry => entry.turns.forEach(addTurn))
    liveTurns.forEach(addTurn)
    return [...systemTurns, ...orderedIds.map(id => turnsById.get(id)!).filter(Boolean)]
  }

  resetSession(): void {
    const now = Date.now()
    this.restoreFromMessages([])
    this.stateProvider.setContextSegments([])
    this.stateProvider.setContextReservoir([])
    this.contextCoordinator.resetSessionState()
    this.session.id = this.config.conversationId || generateSessionId()
    this.workExecution = new WorkExecutionTracker(this.session.id)
    this.session.currentTaskId = null
    this.session.createdAt = now
    this.session.updatedAt = now
    this.session.totalTokens = { input: 0, output: 0 }
    this.modelSurface.reset()
    this.session.modelSurface = this.modelSurface.getState()
    this.fileBeforeSnapshots.clear()
  }

  restoreFromTurns(turns: AgentTurn[], options?: { emitRunState?: boolean; emitRuntimeEvents?: boolean }): void {
    this.restoreFromMessages(this.sessionRehydrator.messagesFromTurns(turns), {
      emitRuntimeEvents: options?.emitRuntimeEvents,
    })

    this.session.id = this.config.conversationId || generateSessionId()
    this.session.createdAt = turns[0]?.timestamp ?? Date.now()
    this.session.updatedAt = turns[turns.length - 1]?.timestamp ?? Date.now()
    this.session.totalTokens = turns.reduce((total, turn) => ({
      input: total.input + (turn.metadata?.tokens?.input ?? 0),
      output: total.output + (turn.metadata?.tokens?.output ?? 0),
    }), { input: 0, output: 0 })
    this.modelSurface.reset(this.session.turns)
    this.session.modelSurface = this.modelSurface.getState()
    if (options?.emitRunState === false) {
      this.runLifecycle.restoreIdle(false)
      this.workExecution.setPhase('idle')
    } else {
      this.runLifecycle.restoreIdle(true)
    }
  }

  setDisabledTools(toolNames: string[]): void {
    this.disabledToolNames = new Set(toolNames)
    this.config.disabledTools = toolNames
  }

  setAllowedTools(toolNames?: string[]): void { this.config.allowedTools = toolNames ? [...toolNames] : undefined }

  getDisabledTools(): string[] {
    return [...this.disabledToolNames]
  }

  setSubAgentBudget(config: Partial<SubAgentBudgetConfig>): SubAgentBudgetConfig { return this.orchestration.setSubAgentBudget(config) }
  getSubAgentBudget(): SubAgentBudgetConfig { return this.orchestration.getSubAgentBudget() }
  private modelRequestGuard?: () => void
  setModelRequestGuard(guard?: () => void): void { this.modelRequestGuard = guard }
  setAutomationSubAgentPolicy(policy: AutomationSubAgentPolicy | null): void { this.orchestration.setAutomationSubAgentPolicy(policy) }

  getAvailableToolNames(): string[] {
    const names = getToolsForMode(this.config.mode).map(tool => tool.name)
    if (this.mcpClient) names.push(...getMcpAgentTools(this.mcpClient).map(tool => tool.name))
    return [...new Set(names)]
  }

  private modelDisabledToolNames(): string[] {
    const disabledTools = new Set(this.disabledToolNames)
    if (this.config.allowedTools) {
      for (const tool of [...getToolsForMode('vibe'), ...(this.mcpClient ? getMcpAgentTools(this.mcpClient) : [])]) if (!this.config.allowedTools.includes(tool.name)) disabledTools.add(tool.name)
    }
    if (this.config.capabilityProfile === 'read-only') {
      for (const tool of [...getToolsForMode('vibe'), ...(this.mcpClient ? getMcpAgentTools(this.mcpClient) : [])]) if (!tool.isReadOnly) disabledTools.add(tool.name)
    }
    if (!this.orchestration.canSpawn() || getAvailableAgentTypes(this.agentRegistry).length === 0) disabledTools.add('spawn_agent')
    return [...disabledTools]
  }

  attachPendingAssistantMessageId(messageId: string): void {
    this.pendingAssistantMessageId = messageId
  }

  getSession(): AgentSession {
    return this.session
  }

  getTaskManager(): TaskManager {
    return this.taskManager
  }

  getWorkExecutionSnapshot(): WorkExecutionSnapshot {
    return this.workExecution.getSnapshot(this.taskManager)
  }

  restoreWorkExecutionSnapshot(snapshot: WorkExecutionSnapshot | undefined, options?: { emitRuntimeEvent?: boolean }): boolean {
    const restored = this.workExecution.restoreSnapshot(snapshot, this.taskManager)
    if (restored && options?.emitRuntimeEvent !== false) this.emitWorkExecution()
    return restored
  }

  controlWorkStep(taskId: string, action: WorkStepControlAction): boolean {
    const updated = this.taskManager.controlTask(taskId, action)
    if (!updated) return false
    this.emitActiveTaskContext()
    this.emitWorkExecution()
    return true
  }

  /**
   * Restore session from persisted ChatMessage data.
   * Reconstructs toolCalls, toolResults, and metadata from the serialized format.
   */
  resetContextTracking(): void {
    this.contextManager.reset()
    this.cacheMonitor.reset()
    this.warmRequestPrefixes.clear()
  }

  restoreFromMessages(messages: PersistedAgentMessage[], options?: { emitRuntimeEvents?: boolean }): void {
    const suppressRuntimeEvents = options?.emitRuntimeEvents === false
    const releaseEventSuppression = suppressRuntimeEvents ? this.events.suppress() : null
    try {
    this.toolOutputStore.clear()
    this.contextManager.reset()
    this.cacheMonitor.reset()
    this.warmRequestPrefixes.clear()
    this.session.turns = this.session.turns.filter(t => t.role === 'system')
    this.taskManager.clear()
    this.toolCallTaskMap.clear()
    this.commandToolCallSessions.clear()
    this.currentRunToolNames = []
    this.currentRunReadFiles.clear()
    this.currentRunSuccessfulReadFiles.clear()
    this.currentRunSearches.clear()
    this.currentRunSuccessfulSearches.clear()
    this.activatedRunSkills.clear()
    this.toolCallLifecycle.beginRun()
    this.conclusionGuardAttempts = 0
    this.finalDeliveryRetryAttempts = 0
    this.compressionPreparedTurnCount = 0
    this.workspaceMemoryText = null
    this.workspaceMemoryWorkspace = null
    this.workspaceMemoryBuiltAt = 0
    this.pendingAssistantMessageId = null
    this.fileBeforeSnapshots.clear()

    this.session.turns = this.sessionRehydrator.rehydrateMessages(messages, {
      systemTurns: this.session.turns,
      taskManager: this.taskManager,
    })

    // Re-establish a token baseline from the rewound turns so the context bar
    // shows the correct occupancy instead of falling back to rough char estimates.
    const baselineSystemPrompt = buildSystemPrompt(this.config.mode, {
      workspacePath: this.config.workspacePath,
      workspaceName: this.config.workspaceName,
      profileSystemPrompt: this.config.profileSystemPrompt,
      enabledSkills: this.config.enabledSkills,
      shell: this.config.shell,
    })
    this.contextManager.restoreBaseline(this.session.turns, baselineSystemPrompt)
    this.workExecution.restoreFromTurns(this.session.turns, this.taskManager)
    this.modelSurface.reset(this.session.turns)
    this.session.modelSurface = this.modelSurface.getState()
    this.emitActiveTaskContext()
    this.emitWorkExecution()
    } finally {
      releaseEventSuppression?.()
    }
  }

  subscribe(listener: AgentEventListener): () => void {
    return this.events.subscribe(listener)
  }

  getRunState(): AgentRunState {
    return this.runLifecycle.getState()
  }

  private setRunState(phase: AgentRunPhase, options?: Pick<AgentRunState, 'detail' | 'activeTool' | 'recoverable'>): void {
    this.runLifecycle.setState(phase, options)
  }

  private setRunStateAfterPause(phase: AgentRunPhase, options?: Pick<AgentRunState, 'detail' | 'activeTool' | 'recoverable'>): void {
    this.runLifecycle.setStateAfterPause(phase, options)
  }

  submitSteeringMessage(message: string, inputId = `steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`): boolean {
    return this.runLifecycle.submitSteering(message, inputId)
  }

  private consumeSteeringMessages(newTurns: AgentTurn[]): boolean {
    return this.runLifecycle.consumeSteering(message => {
      const userTurn = this.createUserTurn(message.text, undefined, message.id)
      this.appendUserTurn(userTurn, newTurns)
    })
  }

  private appendUserTurn(turn: AgentTurn, newTurns: AgentTurn[]): void {
    this.session.turns.push(turn)
    try {
      this.emit({ type: 'turn:start', turn })
    } catch (error) {
      const index = this.session.turns.lastIndexOf(turn)
      if (index >= 0) this.session.turns.splice(index, 1)
      throw error
    }
    newTurns.push(turn)
  }

  private rejectPendingSteeringMessages(reason: string): void {
    this.runLifecycle.rejectPendingSteering(reason)
  }

  publishRuntimeTaskEvent(event: RuntimeTaskEvent): void {
    if (event.type === 'runtime-task:removed') return
    if (event.type === 'runtime-task:finished') {
      const sessionId = event.task.metadata?.sessionId
      if (event.task.kind === 'terminal' && typeof sessionId === 'string') {
        this.agentBackgroundSessions.delete(sessionId)
      }
    }
    this.emit(event)
  }

  publishRuntimeTaskFinished(task: RuntimeTask): void {
    this.publishRuntimeTaskEvent({ type: 'runtime-task:finished', task })
  }

  async stopSubAgentTask(taskId: string): Promise<RuntimeTask> {
    return this.orchestration.stop(taskId, 'Subagent stopped from Desktop')
  }

  abort(): void {
    this.runLifecycle.abort(() => {
      this.contextCoordinator.abortCompaction()
      void this.subAgentTaskManager.stopAll('Parent agent run cancelled', { ownerSessionId: this.config.conversationId, workRunId: this.workExecution.getCurrentRunId() || undefined })
      for (const sessionId of this.agentBackgroundSessions.keys()) {
        const stop = this.toolExecutor.ptyKill?.(sessionId)
        if (stop) void stop.catch(() => {})
      }
      this.agentBackgroundSessions.clear()
      this.modelStreams.abortActive(streamId => this.toolExecutor.streamAbort?.(streamId))
      this.interactiveRequests.cancelAll('deny')
      this.resolvedAskUserResponses.clear()
    })
  }

  submitAskUserResponse(response: string, requestId?: string): boolean {
    const targetId = requestId ?? this.interactiveRequests.getActiveRequest()?.id
    if (!targetId) return false
    return this.interactiveRequests.resolve(targetId, response)
  }

  requestWorkflowSurface(request: { requestId: string; question: string; ui: WorkflowSurfaceSpec }): Promise<string> {
    return this.interactiveRequests.request({
      id: request.requestId,
      kind: 'input',
      event: {
        type: 'ask:user',
        requestId: request.requestId,
        question: request.question,
        options: request.ui.choices?.map(choice => choice.id),
        reason: request.ui.detail,
        ui: request.ui,
      },
    }, { cancelDecision: 'cancelled' })
  }

  getPendingInteractiveRequests(): { active: EngineInteractiveRequest | null; queued: EngineInteractiveRequest[]; pendingCount: number } {
    return this.interactiveRequests.getSnapshot()
  }

  pause(): boolean {
    const hasPendingInteractiveRequest = this.interactiveRequests.getSnapshot().pendingCount > 0
    return this.runLifecycle.pause(hasPendingInteractiveRequest, () => {
      this.modelStreams.abortActive(streamId => this.toolExecutor.streamAbort?.(streamId))
    })
  }

  resume(): boolean {
    return this.runLifecycle.resume()
  }

  private isContextLimitError(message: string): boolean {
    return /context (?:window|length|limit)|maximum context|prompt is too long|input length .*max_tokens.*context limit|tokens?\s*>\s*\d+/i.test(message)
  }

  private async prepareContextWindow(): Promise<void> {
    if (this.forceContextCompactionBeforeNextCall) {
      this.forceContextCompactionBeforeNextCall = false
      await this.ensureContextWindow(true)
      this.compressionPreparedTurnCount = this.session.turns.length
      return
    }

    const currentTurnCount = this.session.turns.length
    if (currentTurnCount === this.compressionPreparedTurnCount) return
    if (this.shouldCompactFromProviderUsage() || this.shouldCompactFromLocalSize()) {
      await this.ensureContextWindow(true)
    }
    this.compressionPreparedTurnCount = this.session.turns.length
  }

  private currentContextWindowSettings(): { contextWindow: number; maxOutputTokens: number; model?: string; provider?: string } {
    const activeConfig = this.stateProvider.getActiveConfig()
    const activeModel = this.stateProvider.getActiveModel()
    return {
      contextWindow: activeModel?.contextWindow || activeConfig?.contextWindow || this.config.contextWindow || 200_000,
      maxOutputTokens: this.config.maxTokens || activeModel?.maxTokens || activeConfig?.maxTokens || 4096,
      model: activeModel?.id || activeConfig?.defaultModel,
      provider: activeModel?.provider || activeConfig?.provider,
    }
  }

  private providerContextTokens(): number {
    const usage = this.contextManager.getCurrentContextUsage()
    if (usage.source !== 'provider' || typeof usage.input !== 'number' || usage.input <= 0) {
      return 0
    }
    return typeof usage.total === 'number' && usage.total > 0
      ? usage.total
      : usage.input + Math.max(0, usage.output ?? 0)
  }

  private shouldCompactFromProviderUsage(): boolean {
    const providerTokens = this.currentContextTokensWithTokenizerTail()
    if (providerTokens <= 0 || !Number.isFinite(providerTokens)) return false
    const settings = this.currentContextWindowSettings()
    return providerTokens >= autoCompactThreshold(settings.contextWindow, settings.maxOutputTokens, this.config.contextPolicy)
  }

  private shouldCompactFromLocalSize(): boolean {
    const settings = this.currentContextWindowSettings()
    const estimatedTokens = this.session.turns.reduce((total, turn) => {
      if (total >= Number.MAX_SAFE_INTEGER) return total
      return total + Math.ceil(this.countTurnChars(turn) / 4)
    }, 0)
    return estimatedTokens >= autoCompactThreshold(settings.contextWindow, settings.maxOutputTokens, this.config.contextPolicy)
  }

  private currentContextTokensWithTokenizerTail(): number {
    const providerTokens = this.providerContextTokens()
    if (providerTokens <= 0) return 0
    const settings = this.currentContextWindowSettings()
    const lastUsageIndex = this.findLastProviderUsageTurnIndex()
    if (lastUsageIndex < 0 || lastUsageIndex >= this.session.turns.length - 1) {
      return providerTokens
    }
    const tailTurns = this.session.turns.slice(lastUsageIndex + 1)
    const tailCount = countTurnishTokens(tailTurns, {
      provider: settings.provider || 'custom',
      model: settings.model,
    })
    return tailCount.source === 'unavailable' ? providerTokens : providerTokens + tailCount.tokens
  }

  private findLastProviderUsageTurnIndex(): number {
    for (let index = this.session.turns.length - 1; index >= 0; index -= 1) {
      const tokens = this.session.turns[index]?.metadata?.tokens
      if (tokens?.source === 'provider' || typeof tokens?.input === 'number') {
        return index
      }
    }
    return -1
  }

  async waitUntilIdle(): Promise<void> {
    while (this.currentRunPromise || this.contextCoordinator.contextCompactionPromise) {
      const pending = [this.currentRunPromise, this.contextCoordinator.contextCompactionPromise]
        .filter(Boolean) as Promise<unknown>[]
      await Promise.allSettled(pending)
    }
  }

  private settleRunFailure(error: unknown, workRunStarted: boolean): void {
    const failure = this.runLifecycle.settleFailure(error)
    if (!failure.aborted && !failure.alreadyReported) {
      try { this.emit({ type: 'error', error: failure.message }) } catch {}
    }
    try { this.expireComputerToolPayloads() } catch {}
    if (workRunStarted) {
      const runError = error instanceof Error ? error.message : String(error)
      try {
        this.workExecution.finishRun(
          failure.aborted ? 'cancelled' : 'failed',
          undefined,
          failure.aborted ? undefined : (error as { userFacing?: boolean })?.userFacing === true ? runError : presentRequestError(runError),
          failure.aborted ? undefined : this.taskManager,
        )
      } catch {}
    }
    this.session.updatedAt = Date.now()
    try { this.taskManager.setCurrentWorkRunId(null) } catch {}
    try { this.subAgentTaskManager.setExecutionContext(null) } catch {}
    try { this.emitWorkExecution() } catch {}
  }

  async run(userMessage: string, options?: { reuseLastUserTurn?: boolean; attachments?: NonNullable<AgentTurn['metadata']>['attachments']; capabilities?: NonNullable<AgentTurn['metadata']>['capabilities']; userTurnId?: string; workflowContext?: string; workflow?: WorkflowRunContract; onWorkflowProgress?: (update: WorkflowProgressUpdate) => void }): Promise<AgentTurn[]> {
    this.assertAvailable()
    if (this.runLifecycle.isRunning()) {
      throw new Error('AgentEngine.run() called while a previous run is still in flight')
    }
    return this.runLifecycle.run(async runAbortController => {
    const lastTurn = this.session.turns[this.session.turns.length - 1]
    const canReuseLastUserTurn = options?.reuseLastUserTurn === true
      && lastTurn?.role === 'user'
      && lastTurn.content === userMessage

    const workRunId = options?.userTurnId || (canReuseLastUserTurn ? lastTurn.id : generateTurnId())
    const newTurns: AgentTurn[] = []
    let workRunStarted = false
    try {
      this.permissions.clearRunGrants()
      this.currentRunToolNames = []
      this.currentRunReadFiles.clear()
      this.currentRunSuccessfulReadFiles.clear()
      this.currentRunSearches.clear()
      this.currentRunSuccessfulSearches.clear()
      this.activeWorkflowContract = options?.workflow ? JSON.parse(JSON.stringify(options.workflow)) as WorkflowRunContract : null
      this.completedWorkflowStages = new Set(options?.workflow?.completedStages || [])
      this.workflowProgressHandler = options?.onWorkflowProgress || null
      this.toolCallLifecycle.beginRun()
      this.conclusionGuardAttempts = 0
      this.finalDeliveryRetryAttempts = 0
      this.contextLimitRetryInProgress = false
      this.providerTransientRetryAttempt = 0
      this.providerTransientRetryStartedAt = 0
      this.currentModelRequestRound = 0
      this.orchestration.joinCoordinator.beginRun()
      this.workspaceMemoryText = null
      this.workspaceMemoryWorkspace = null
      this.workspaceMemoryBuiltAt = 0
      this.workExecution.startRun(workRunId, userMessage, Date.now(), { restart: canReuseLastUserTurn })
      workRunStarted = true
      this.taskManager.setCurrentWorkRunId(workRunId)
      this.taskManager.claimRetryTasks(workRunId)
      this.subAgentTaskManager.setExecutionContext({ runId: workRunId })
      this.setRunState('thinking', { detail: 'Preparing the next step' })
      // Replay tool-call evidence from any turns we just restored so the
      // evidence guard sees prior reads/searches on the first model turn.
      this.replayEvidenceFromExistingTurns()

      let consecutiveToolErrors = 0
      const MAX_CONSECUTIVE_ERRORS = 1
      const identicalToolFailures = new Map<string, number>()
      const maxToolRounds = Number.isFinite(this.config.maxToolRounds)
        ? Math.max(1, Math.min(512, Math.floor(this.config.maxToolRounds!)))
        : DEFAULT_MAX_TOOL_ROUNDS_PER_RUN
      let toolRounds = 0
      if (!canReuseLastUserTurn) {
        const userTurn = this.createUserTurn(userMessage, options?.attachments, workRunId, options?.capabilities)
        if (options?.workflowContext) {
          userTurn.metadata = { ...userTurn.metadata, workflowContext: options.workflowContext }
        }
        this.appendUserTurn(userTurn, newTurns)
      } else {
        this.emit({ type: 'turn:start', turn: lastTurn })
      }

      await this.runControl.raceWithStop(this.initializeGit(), runAbortController.signal)
      if (runAbortController.signal.aborted) throw this.runControl.createStopInterruption()

      while (true) {
        if (runAbortController.signal.aborted) throw this.runControl.createStopInterruption()

        if (toolRounds >= maxToolRounds) {
          const stoppedTurn = this.createAssistantTurn(
            `Stopped after ${maxToolRounds} tool rounds in one request to prevent a runaway loop. Send a follow-up message to continue from the saved state.`,
            undefined,
            { mode: this.config.mode, interrupted: true },
          )
          this.session.turns.push(stoppedTurn)
          newTurns.push(stoppedTurn)
          this.emit({ type: 'turn:complete', turn: stoppedTurn })
          break
        }

        await this.runControl.waitIfPaused()
        if (runAbortController.signal.aborted) throw this.runControl.createStopInterruption()
        this.consumeSteeringMessages(newTurns)
        await this.runControl.runAcrossPause(() => this.prepareContextWindow(), runAbortController.signal)
        if (runAbortController.signal.aborted) throw this.runControl.createStopInterruption()

        this.injectPendingSubAgentCompletions(newTurns)
        reconcileSubAgentSteps(this.taskManager, this.orchestration.currentRunSubAgents())
        this.setRunState('thinking', { detail: 'Planning the next step' })
        const assistantTurn = await this.callModel()

        if (assistantTurn.metadata?.interruption?.kind === 'pause') {
          if (assistantTurn.content.trim() || assistantTurn.metadata.thinking?.content.trim()) {
            this.session.turns.push(assistantTurn)
            newTurns.push(assistantTurn)
            this.emit({ type: 'turn:complete', turn: assistantTurn })
          }
          await this.runControl.waitIfPaused()
          if (runAbortController.signal.aborted) throw this.runControl.createStopInterruption()
          continue
        }

        if (assistantTurn.metadata?.internalKind === 'request_error' && assistantTurn.metadata.internalError) {
          const rawError = assistantTurn.metadata.internalError
          const visibleError = presentRequestError(rawError)
          if (assistantTurn.content.trim() || assistantTurn.metadata.thinking?.content.trim()) {
            this.session.turns.push(assistantTurn)
            newTurns.push(assistantTurn)
            this.emit({ type: 'turn:complete', turn: assistantTurn })
          }
          const reported = new Error(visibleError) as Error & { alreadyReported: boolean; userFacing: boolean }
          reported.alreadyReported = true
          reported.userFacing = true
          throw reported
        }

        if (assistantTurn.toolCalls?.length) {
          assistantTurn.toolCalls = this.toolCallsBeforeUserAnswer(assistantTurn.toolCalls)
          assistantTurn.toolCalls = this.toolCallsBeforeWorkflowCheckpoint(assistantTurn.toolCalls)
          if (assistantTurn.toolCalls.length > 0 && this.workExecution.getResponseMode() !== 'task') {
            this.workExecution.setResponseMode('task')
            this.emitWorkExecution()
          }
        }

        if ((!assistantTurn.toolCalls || assistantTurn.toolCalls.length === 0) && !assistantTurn.content.trim()) {
          const hasReasoning = Boolean(assistantTurn.metadata?.thinking?.content.trim())
          if (assistantTurn.metadata?.interruption?.kind === 'stop') {
            if (hasReasoning) {
              this.session.turns.push(assistantTurn)
              newTurns.push(assistantTurn)
              this.emit({ type: 'turn:complete', turn: assistantTurn })
            }
            throw this.runControl.createStopInterruption()
          }
          if (hasReasoning || assistantTurn.metadata?.interrupted) {
            const outputLimit = this.lastModelAttempt?.requestSettings?.maxOutputTokens
            const outputTokens = this.lastModelAttempt?.usage.output ?? assistantTurn.metadata?.tokens?.output ?? 0
            const exhaustedOutput = typeof outputLimit === 'number' && outputLimit > 0 && outputTokens >= outputLimit
            const chinese = /[\u3400-\u9fff]/.test(userMessage)
            assistantTurn.content = chinese
              ? `${exhaustedOutput ? `模型已达到本次输出上限（${outputLimit} tokens）` : '模型本轮未生成可用的答复或工具调用'}。${hasReasoning ? '仅收到推理，记录已保留。' : '响应已中断。'}已停止自动重试。可降低推理强度或提高输出上限后继续。`
              : `${exhaustedOutput ? `The model reached the output limit for this request (${outputLimit} tokens)` : 'The model returned no usable answer or tool call'}. ${hasReasoning ? 'Only reasoning was received and it was preserved.' : 'The response was interrupted.'} Automatic retry stopped. You can lower reasoning effort or raise the output limit before continuing.`
            assistantTurn.metadata = { ...assistantTurn.metadata, interrupted: true }
            this.session.turns.push(assistantTurn)
            newTurns.push(assistantTurn)
            this.emit({ type: 'turn:complete', turn: assistantTurn })
            break
          }
          if (this.finalDeliveryRetryAttempts === 0) {
            this.finalDeliveryRetryAttempts = 1
            const currentUserTurn = [...this.session.turns].reverse().find(turn => turn.role === 'user' && !turn.metadata?.internal && turn.metadata?.workRunId === workRunId)
            if (currentUserTurn?.metadata) delete currentUserTurn.metadata.runtimeContext
            continue
          }
          const stoppedTurn = this.createAssistantTurn(
            /[\u3400-\u9fff]/.test(userMessage)
              ? '本轮未能生成可用的最终答复。处理过程和已有结果已保留，请重试本轮。'
              : 'This run could not produce a usable final response. The work log and current results were preserved; retry this turn.',
            undefined,
            { mode: this.config.mode, interrupted: true },
          )
          this.session.turns.push(stoppedTurn)
          newTurns.push(stoppedTurn)
          this.emit({ type: 'turn:complete', turn: stoppedTurn })
          break
        }

        const finalCandidate = !assistantTurn.toolCalls?.length
        const unresolvedChildren = finalCandidate ? this.orchestration.unresolvedRunSubAgents() : []
        if (finalCandidate && unresolvedChildren.length === 0) {
          const failedChildren = effectiveRequiredChildren(this.orchestration.currentRunSubAgents()).filter(task => task.runtimeTask.status !== 'completed')
          assistantTurn.content += formatIncompleteChildNotice(failedChildren.map(task => ({
            id: task.id, agentType: task.agentType, objective: task.objective,
            status: task.runtimeTask.status, startedAt: task.startedAt, error: task.runtimeTask.error,
          })), /[\u3400-\u9fff]/.test(userMessage))
        }
        if (unresolvedChildren.length > 0) {
          assistantTurn.metadata = { ...assistantTurn.metadata, internal: true, internalKind: 'subagent_candidate' }
        }
        // Bind before publishing the turn/tool proposal. A crash can occur after
        // intent or side effect but before any tool result reaches the transcript.
        for (const call of assistantTurn.toolCalls ?? []) {
          call.operationIdentity = { sessionId: this.session.id, turnId: assistantTurn.id, callId: call.id }
        }
        this.session.turns.push(assistantTurn)
        newTurns.push(assistantTurn)
        this.emit({ type: 'turn:complete', turn: assistantTurn })

        if (assistantTurn.metadata?.interruption?.kind === 'stop') {
          throw this.runControl.createStopInterruption()
        }

        if (!assistantTurn.toolCalls || assistantTurn.toolCalls.length === 0) {
          if (unresolvedChildren.length > 0) {
            if (this.orchestration.joinCoordinator.tryBeginContinuation()) {
              const joinTurn = this.createUserTurn('')
              joinTurn.metadata = {
                ...joinTurn.metadata, internal: true, internalKind: 'subagent_join',
                runtimeContext: '<runtime_context>\n' + this.orchestration.joinCoordinator.formatRequiredContext(unresolvedChildren.map(task => ({
                  id: task.id, agentType: task.agentType, status: task.runtimeTask.status,
                  objective: task.objective, startedAt: task.startedAt,
                }))) + '\n</runtime_context>',
              }
              // Runtime context has its own identity; never reuse the actual
              // user turn ID or publish this as another user submission.
              this.session.turns.push(joinTurn)
              newTurns.push(joinTurn)
              continue
            }
            const summary = unresolvedChildren.map(task => task.id + ' (' + task.agentType + ', ' + task.runtimeTask.status + ')').join(', ')
            const partialTurn = this.createAssistantTurn(
              assistantTurn.content + '\n\n' + (/[\u3400-\u9fff]/.test(userMessage)
                ? '本轮仅部分完成：以下子任务尚未完成验收或结果汇合：' + summary + '。已有结果已保存，可继续等待或重试。'
                : 'Partial result: required child work remains unresolved after the join budget: ' + summary + '. Results are persisted; wait, retry or explicitly detach obsolete work before claiming completion.'),
              undefined, { mode: this.config.mode, interrupted: true },
            )
            this.session.turns.push(partialTurn)
            newTurns.push(partialTurn)
            this.emit({ type: 'turn:complete', turn: partialTurn })
            break
          }
          if (this.consumeSteeringMessages(newTurns)) continue
          break
        }

        const semanticActivities = assistantTurn.toolCalls
          .map(toolCall => describeSemanticToolActivity(toolCall.name, toolCall.arguments, 'running'))
        const allSemanticActivities = semanticActivities.every(Boolean)
        const semanticGroup = assistantTurn.toolCalls.every(toolCall => isBuiltInBrowserTool(toolCall.name))
          ? '网页'
          : assistantTurn.toolCalls.every(toolCall => isBuiltInComputerTool(toolCall.name))
            ? '电脑'
            : '操作'
        this.setRunState('tool_running', {
          detail: allSemanticActivities
            ? semanticActivities.length === 1
              ? semanticActivities[0]!.detail
              : `正在处理 ${semanticActivities.length} 个${semanticGroup}步骤`
            : `Running ${assistantTurn.toolCalls.length} tool${assistantTurn.toolCalls.length === 1 ? '' : 's'}`,
          activeTool: assistantTurn.toolCalls[0]?.name,
        })
        const interactiveCalls = assistantTurn.toolCalls.filter(toolCall => toolCall.name === 'ask_user' || toolCall.name === 'present_workflow')
        let toolResults = await this.executeToolCalls(assistantTurn.toolCalls)

        const errorCount = toolResults.filter(result => toolResultExecutionStatus(result) === 'failed').length
        if (errorCount > 0) {
          consecutiveToolErrors++
          if (consecutiveToolErrors >= MAX_CONSECUTIVE_ERRORS) {
            const toolRetryHint = this.buildToolRetryHint(assistantTurn.toolCalls!, toolResults)
            if (toolRetryHint) {
              toolResults = this.attachToolRetryHint(toolResults, toolRetryHint)
              consecutiveToolErrors = 0
            }
          }
        } else {
          consecutiveToolErrors = Math.max(0, consecutiveToolErrors - 1)
        }
        let repeatedFailure: { toolCall: ToolCall; result: ToolResult; count: number } | null = null
        for (const toolCall of assistantTurn.toolCalls) {
          const result = toolResults.find(item => item.toolCallId === toolCall.id)
          if (!result || toolResultExecutionStatus(result) !== 'failed') continue
          const deterministicFailure = result.errorKind === 'validation'
            || (result.data?.kind === 'command' && result.data.process.state === 'exited')
          if (!deterministicFailure) continue
          const signature = toolCallSignature(toolCall)
          const count = (identicalToolFailures.get(signature) || 0) + 1
          identicalToolFailures.set(signature, count)
          if (count >= MAX_IDENTICAL_TOOL_FAILURES) repeatedFailure = { toolCall, result, count }
        }
        const resultTurn = this.createToolResultTurn(toolResults)
        this.session.turns.push(resultTurn)
        newTurns.push(resultTurn)
        toolRounds += 1

        if (repeatedFailure) {
          const lastError = repeatedFailure.result.output
            .replace(/\s+/g, ' ')
            .slice(0, 300)
          const stoppedTurn = this.createAssistantTurn(
            `Stopped a repeated tool-call loop after ${repeatedFailure.count} identical failures of \`${repeatedFailure.toolCall.name}\`. Last error: ${lastError}`,
            undefined,
            { mode: this.config.mode, interrupted: true },
          )
          this.session.turns.push(stoppedTurn)
          newTurns.push(stoppedTurn)
          this.emit({ type: 'turn:complete', turn: stoppedTurn })
          break
        }

        const automaticCheckpoint = this.triggeredWorkflowCheckpoint(assistantTurn.toolCalls, toolResults)
        if (automaticCheckpoint) {
          await this.presentAutomaticWorkflowCheckpoint(automaticCheckpoint, workRunId)
          continue
        }

          if (interactiveCalls.length > 0) {
            const responses: string[] = []
            for (const interactiveCall of interactiveCalls) {
              const resolved = this.resolvedAskUserResponses.get(interactiveCall.id)
              if (resolved !== undefined) {
                this.resolvedAskUserResponses.delete(interactiveCall.id)
                responses.push(resolved)
              } else if (this.interactiveRequests.has(interactiveCall.id)) {
                responses.push(await this.interactiveRequests.wait(interactiveCall.id))
              } else {
                const toolResult = toolResults.find(result => result.toolCallId === interactiveCall.id)
                responses.push(toolResult?.output.replace(/^\[(?:User response|Workflow response)\]\s*/, '') || 'deny')
              }
              if (interactiveCall.name === 'present_workflow') {
                if (responses[responses.length - 1] === 'cancelled') {
                  this.reportWorkflowCancellation(
                    String(interactiveCall.arguments.workflow || ''),
                    String(interactiveCall.arguments.stage || ''),
                  )
                  throw this.runControl.createStopInterruption()
                }
                this.recordWorkflowStageResponse(
                  String(interactiveCall.arguments.workflow || ''),
                  String(interactiveCall.arguments.stage || ''),
                  responses[responses.length - 1]!,
                  workRunId,
                )
              }
          }
          const responseTurn = this.createUserTurn(responses.join('\n\n'))
          this.appendUserTurn(responseTurn, newTurns)
          continue
        }
      }

      this.runLifecycle.closeSteering('Current turn finished before guidance was committed')
      this.session.updatedAt = Date.now()
      const lastAssistantTurn = [...newTurns].reverse().find(turn => turn.role === 'assistant')
      const internallyInterrupted = lastAssistantTurn?.metadata?.interrupted === true
      // A normal model conclusion is an explicit run-level success signal.
      // Settle open leaves then; loop guards and other interrupted conclusions
      // deliberately leave them open so the run remains partial and retryable.
      reconcileSubAgentSteps(this.taskManager, this.orchestration.currentRunSubAgents())
      const finalized = internallyInterrupted ? [] : this.taskManager.finalizeOrphanedLeaves(workRunId)
      if (finalized.length > 0) {
        this.emit({ type: 'active:task', context: this.taskManager.getActiveTaskContext() })
      }
      // Context preparation already runs before every model call. Preparing
      // again after final delivery delays completion (and may request another
      // model summary) even though there is no further input to send yet.
      if (runAbortController.signal.aborted && lastAssistantTurn?.metadata?.interrupted !== true) {
        throw this.runControl.createStopInterruption()
      }
      this.expireComputerToolPayloads()
      const tasks = this.taskManager.getTasksForWorkRun(workRunId)
      const cancelledTasks = tasks.filter(task => task.metadata?.workControlOutcome === 'cancel')
      const failedTasks = tasks.filter(task => task.status === 'failed' && task.metadata?.workControlOutcome !== 'cancel')
      const unfinishedTasks = tasks.filter(task => task.status === 'pending' || task.status === 'in_progress')
      const successfulTasks = tasks.filter(task => task.status === 'completed')
      const incompleteChildren = effectiveRequiredChildren(this.orchestration.currentRunSubAgents()).filter(task => task.runtimeTask.status !== 'completed')
      const workStatus = incompleteChildren.length > 0 ? 'partial' : cancelledTasks.length > 0
        ? successfulTasks.length > 0 ? 'partial' : 'cancelled'
        : failedTasks.length > 0
        ? successfulTasks.length > 0 ? 'partial' : 'failed'
        : internallyInterrupted || unfinishedTasks.length > 0 ? 'partial' : 'completed'
      this.workExecution.finishRun(workStatus, lastAssistantTurn?.content, failedTasks[0]?.error)
      this.taskManager.setCurrentWorkRunId(null)
      this.subAgentTaskManager.setExecutionContext(null)
      this.setRunState('completed', { detail: 'Run completed' })
      this.emit({ type: 'session:complete', session: this.session })
      return redactComputerTurns(newTurns)
    } catch (error) {
      this.settleRunFailure(error, workRunStarted)
      throw error
    } finally {
      try { this.permissions.clearRunGrants() } catch {}
      try { this.runLifecycle.closeSteering('Current run ended before guidance was committed') } catch {}
      try { this.taskManager.setCurrentWorkRunId(null) } catch {}
      try { this.subAgentTaskManager.setExecutionContext(null) } catch {}
      this.activeWorkflowContract = null
      this.completedWorkflowStages.clear()
      this.workflowProgressHandler = null
    }
    })
  }

  private assertAvailable(): void {
    if (this.destroyed || this.shutdownPromise) throw new Error('Agent engine is shutting down or has been destroyed')
  }

  /**
   * Check if the session is approaching the context window limit.
   * If so, generate a model-produced continuation summary and emit a
   * context:segment_created event so the store can persist it.
   *
   * The user never sees a conversation break — they can still scroll back,
   * edit old messages, and continue from compacted context.
   */
  private async ensureContextWindow(force = false): Promise<void> {
    const activeConfig = this.stateProvider.getActiveConfig()
    if (!force) return

    if (activeConfig?.apiKey && this.contextManager.getCurrentContextUsage().source === 'provider') {
      this.emit({
        type: 'notification',
        message: 'Context usage is high; compacting older conversation before the next model call.',
        level: 'info',
      })
    }

    await this.performContextCompaction('compact')
  }

  private async performContextCompaction(source: ContextReservoirEntry['source']): Promise<boolean> {
    return this.contextCoordinator.runCompaction(() => this.performContextCompactionInternal(
      source,
      Boolean(this.currentRunPromise) && this.runLifecycle.getState().phase !== 'completed',
    ))
  }

  private async performContextCompactionInternal(
    source: ContextReservoirEntry['source'],
    partOfRun: boolean,
  ): Promise<boolean> {
    const keepRecent = resolveContextPolicyProfile(this.config.contextPolicy).keepRecentTurns
    const plan = planContextCompaction({
      turns: this.session.turns,
      keepRecent,
      segments: this.stateProvider.getContextSegments(),
      countTurnChars: turn => this.countTurnChars(turn),
    })
    if (!plan) return false
    const {
      oldTurns,
      recentTurns,
      startMessageId,
      endMessageId,
      originalCharCount,
      existingSegment,
    } = plan

    const compactionId = `context-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const startedAt = Date.now()
    const scope = this.contextCoordinator.beginCompaction({
      id: compactionId,
      phase: 'started',
      source,
      startedAt,
      updatedAt: startedAt,
      elapsedMs: 0,
      startMessageId,
      endMessageId,
      oldTurnCount: oldTurns.length,
      originalCharCount,
      progress: 0,
      recoverable: true,
    }, partOfRun ? controller => this.runControl.linkOperation(controller) : undefined)
    if (partOfRun) this.setRunState('compacting', { detail: 'Preparing a durable context handoff' })

    const signal = scope.signal
    try {
      this.contextCoordinator.updateCompactionState('summarizing', {
        progress: 0.12,
        detail: existingSegment ? 'Restoring the previous handoff' : 'Summarizing older turns',
      }, 'context:compaction_summarizing')
      const previousHandoff = this.getLatestContextHandoff()
      const workspace = await this.collectContinuationWorkspaceSnapshot()
      if (signal.aborted) throw this.contextCoordinator.createCompactionAbortError()
      const facts = collectContinuationHandoffFacts(oldTurns, recentTurns, workspace, previousHandoff?.facts)
      const summaryResult = existingSegment
        ? { text: existingSegment.summary, source: 'reused' as const }
        : await this.generateContinuationSummary(oldTurns, recentTurns, workspace, previousHandoff, facts)
      if (signal.aborted) throw this.contextCoordinator.createCompactionAbortError()
      if (summaryResult.source === 'deterministic') {
        this.contextCoordinator.updateCompactionState('fallback', {
          progress: 0.58,
          summarySource: summaryResult.source,
          detail: 'Model summary unavailable; using deterministic handoff',
        }, 'context:compaction_fallback')
      }

      let nextSegment = existingSegment
      if (!existingSegment) {
        const handoff = buildContextHandoff({
          oldTurns,
          recentTurns,
          workspace,
          previous: previousHandoff,
          modelSummary: summaryResult.text,
          startMessageId,
          endMessageId,
          source,
          summarySource: summaryResult.source,
          facts,
        })
        nextSegment = {
          startMessageId,
          endMessageId,
          summary: summaryResult.text,
          isModelGenerated: summaryResult.source === 'model',
          kind: 'compact',
          originalCharCount,
          isValid: true,
          createdAt: Date.now(),
          coveredTurnIds: oldTurns.map(turn => turn.id),
          handoff,
        }
      } else if (!existingSegment.handoff) {
        const handoff = buildContextHandoff({
          oldTurns,
          recentTurns,
          workspace,
          previous: previousHandoff,
          modelSummary: existingSegment.summary,
          startMessageId,
          endMessageId,
          source,
          summarySource: 'reused',
          facts,
        })
        nextSegment = { ...existingSegment, handoff }
      }

      this.contextCoordinator.updateCompactionState('committing', {
        progress: 0.72,
        summarySource: summaryResult.source,
        detail: 'Writing the compacted context checkpoint',
      }, 'context:compaction_committing')
      if (signal.aborted) throw this.contextCoordinator.createCompactionAbortError()

      if (!existingSegment || !existingSegment.handoff) {
        this.stateProvider.setContextSegments(this.stateProvider.getContextSegments().map(segment =>
          segment.startMessageId === startMessageId && segment.endMessageId === endMessageId
            ? nextSegment!
            : segment
        ).concat(existingSegment ? [] : [nextSegment!]))
        this.emit({ type: 'context:segment_created', segment: nextSegment! })
      }

      this.contextCoordinator.addReservoirEntry(
        startMessageId,
        endMessageId,
        oldTurns,
        source,
        turn => this.countTurnChars(turn),
        originalCharCount,
      )
      this.preservedFiles = this.contextCoordinator.collectPreservedFiles(oldTurns)

      const systemTurns = this.session.turns.filter(turn => turn.role === 'system')
      this.session.turns = [...systemTurns, ...recentTurns]
      this.modelSurface.replaceConversationTurns(this.session.turns, 'context_compaction')
      this.toolCallLifecycle.invalidateReadResults()
      this.session.modelSurface = this.modelSurface.getState()
      this.contextManager.reset()
      this.cacheMonitor.resetBaseline()
      this.contextCoordinator.updateCompactionState('completed', {
        progress: 1,
        summarySource: summaryResult.source,
        detail: 'Context handoff committed; original turns remain in history',
        recoverable: false,
      }, 'context:compaction_completed')
      if (partOfRun) this.setRunState('thinking', { detail: 'Continuing after context compaction' })
      return true
    } catch (error) {
      const interrupted = signal.aborted || (error as { aborted?: boolean })?.aborted === true
      const paused = this.runControl.isPauseSignal(signal) || this.runControl.isPauseInterruption(error)
      const message = error instanceof Error ? error.message : String(error)
      this.contextCoordinator.updateCompactionState(interrupted ? 'interrupted' : 'failed', {
        detail: interrupted ? 'Compaction interrupted; original turns were preserved' : 'Compaction failed; retry is available',
        error: interrupted ? undefined : message.slice(0, 500),
        recoverable: true,
      }, interrupted ? 'context:compaction_interrupted' : 'context:compaction_failed')
      if (interrupted && partOfRun) {
        if (!paused) this.setRunState('aborting', { detail: 'Context compaction interrupted; original turns preserved' })
      }
      if (paused) throw signal.reason instanceof Error ? signal.reason : createAgentRunInterruption('pause')
      if (interrupted) throw this.contextCoordinator.createCompactionAbortError()
      throw error
    } finally {
      scope.close()
    }
  }

  private createPausedAssistantTurn(
    textContent: string,
    reasoningContent: string,
    model: APIModel | null,
    startTime: number,
  ): AgentTurn {
    const interruptedTurn = this.finishInterruptedStream(textContent, reasoningContent, model, startTime)
      || this.createAssistantTurn('', undefined, {
        model: model?.name,
        duration: Date.now() - startTime,
        mode: this.config.mode,
        interrupted: true,
      })
    interruptedTurn.metadata = {
      ...interruptedTurn.metadata,
      interrupted: true,
      interruption: interruptionMetadata('pause'),
    }
    return interruptedTurn
  }

  /**
   * Ask the model to generate a continuation summary for the next context window.
   * This is a hidden API call — the user does not see it as a regular message.
   */
  private getLatestContextHandoff(): ContextHandoff | null {
    return this.stateProvider.getContextSegments()
      .filter(segment => segment.isValid && segment.handoff)
      .sort((a, b) => (b.handoff?.createdAt ?? b.createdAt ?? 0) - (a.handoff?.createdAt ?? a.createdAt ?? 0))[0]?.handoff ?? null
  }

  private async collectContinuationWorkspaceSnapshot(): Promise<ContinuationWorkspaceSnapshot> {
    const workspacePath = this.config.workspacePath || ''
    await Promise.all([
      this.maybeRefreshWorkspaceMemory(),
      this.gitState.enabled ? this.refreshGitStatus() : Promise.resolve(),
    ])
    return {
      workspacePath,
      gitStatus: this.cachedGitStatus,
      workspaceMemory: this.workspaceMemoryText,
      taskTree: this.taskManager.getFullTree(),
      activeTask: this.taskManager.getActiveTaskContext(),
    }
  }

  private async generateContinuationSummary(
    oldTurns: AgentTurn[],
    recentTurns: AgentTurn[],
    workspace: ContinuationWorkspaceSnapshot,
    previousHandoff: ContextHandoff | null,
    facts: ContextHandoffFacts,
  ): Promise<{ text: string; source: 'model' | 'deterministic' }> {
    const activeConfig = this.stateProvider.getActiveConfig()
    const deterministic = (): { text: string; source: 'deterministic' } => ({
      text: buildDeterministicContinuationSummary(facts, previousHandoff?.modelSummary),
      source: 'deterministic',
    })

    if (!activeConfig || !activeConfig.apiKey) return deterministic()

    const evidence = buildContinuationEvidence(oldTurns, recentTurns, workspace, previousHandoff)
    const anchors = buildContinuationSummaryAnchors(facts)
    const summaryMaxTokens = continuationSummaryTokenBudget(
      evidence.length,
      this.config.contextPolicy,
      this.config.contextPolicy === 'qualityFirst' ? 8_000 : 6_000,
    )

    try {
      const firstCandidate = await this.requestContinuationSummary(
        activeConfig,
        buildContinuationSummaryPrompt(evidence),
        summaryMaxTokens,
      )
      let validation = validateContinuationSummary(firstCandidate, anchors)
      if (!validation.valid) {
        const repaired = await this.requestContinuationSummary(
          activeConfig,
          buildContinuationSummaryPrompt(evidence, `${firstCandidate.slice(0, 20_000)}\nMissing requirements: ${validation.missing.join(', ')}`),
          summaryMaxTokens,
        )
        validation = validateContinuationSummary(repaired, anchors)
      }
      if (validation.valid) return { text: validation.text, source: 'model' }
    } catch (error) {
      if (this.contextCoordinator.getCompactionSignal()?.aborted || (error as { aborted?: boolean })?.aborted === true) {
        throw this.contextCoordinator.createCompactionAbortError()
      }
      return deterministic()
    }
    return deterministic()
  }

  private async requestContinuationSummary(config: APIConfig, prompt: string, maxTokens: number): Promise<string> {
    const requestId = randomUUID()
    const protocols = planModelProtocols(config.provider, config.defaultModel, config.modelCapabilities?.supportedEndpoints)
    const attempts: ModelProtocolAttempt[] = []
    for (const protocol of protocols) {
      const adapter = getModelProviderAdapter(protocol)
      const { url, headers, body } = adapter.prepareSummary({ config, prompt, maxTokens,
        systemPrompt: CONTINUATION_SUMMARY_SYSTEM_PROMPT, warmPrefix: this.warmRequestPrefixes.get(protocol)?.body })

      const result = await this.sendCompactionAttempt(requestId, protocol, config, url, headers, JSON.stringify(body), {
        signal: this.contextCoordinator.getCompactionSignal() || this.abortController?.signal,
        timeoutMs: CONTEXT_COMPACTION_REQUEST_TIMEOUT_MS,
      })
      if (result.success && result.data) {
        const text = adapter.readSummary(result.data).text
        if (text.trim()) return text
        const shapeError = new ModelProtocolRequestError('Continuation summary response omitted text content', {
          protocol,
          url,
          kind: 'response_shape',
        })
        attempts.push(toProtocolAttempt(shapeError))
        continue
      }

      const error = new ModelProtocolRequestError(result.error || 'Continuation summary request failed', {
        protocol,
        url,
        status: result.status,
        retryAfterMs: result.retryAfterMs,
      })
      attempts.push(toProtocolAttempt(error))
      if (!shouldFallbackProtocol(error)) break
    }
    throw new Error(formatProtocolFailure(attempts))
  }

  private rememberWarmRequestPrefix(protocol: ModelProtocol, body: Record<string, unknown>): void {
    this.warmRequestPrefixes.set(protocol, {
      protocol,
      body: JSON.parse(JSON.stringify(body)) as Record<string, unknown>,
    })
  }

  private countTurnChars(turn: AgentTurn): number {
    return countTurnContextChars(turn)
  }

  private buildToolRetryHint(failedToolCalls: ToolCall[], toolResults: ToolResult[]): string | null {
    const errors = toolResults.filter(result => toolResultExecutionStatus(result) === 'failed')
    if (errors.length === 0) return null

    const errorSummary = errors.map(e => `- ${e.name}: kind=${e.errorKind ?? 'execution'}; effects=${e.recovery?.effects ?? 'unknown'}; retry=${e.recovery?.retry ?? 'after_inspection'}; ${e.output.slice(0, 120)}`).join('\n')
    const toolNames = [...new Set(failedToolCalls.map(tc => tc.name))].join(', ')
    const editMatchFailed = errors.some(e =>
      (e.name === 'edit_file' || e.name === 'multi_edit')
      && e.errorKind === 'validation'
    )
    const editGuidance = editMatchFailed
      ? `
Edit validation failed. Do not retry another similar edit_file/multi_edit call against the same snippet without inspecting the cause.
Use one of these safer paths:
- For small changes: read the nearest surrounding lines, then use a longer unique old_string with stable context.
- For broad or fragile changes: use replace_file with the complete final file content.
`
      : ''
    const directoryGuidance = errors.some(error => error.name === 'list_directory')
      ? '\nFor list_directory, pass a directory path. Use {"path":"."} for the workspace root; never pass an empty path.\n'
      : ''
    const searchGuidance = errors.some(error => error.name === 'search_content')
      ? '\nFor search_content, path accepts a file or directory. Preserve the intended query; invalid regex can be corrected or explicitly searched as literal text with fixed_strings=true.\n'
      : ''
    return `<tool_retry_hint>
The last tool call(s) failed: ${toolNames}.
Errors:
${errorSummary}
${editGuidance}
${directoryGuidance}${searchGuidance}

Before retrying:
1. Identify the root cause of each failure (wrong path? missing file? syntax error?)
2. Propose a concrete alternative approach — do NOT repeat the same failing call
3. If a file path was wrong, use search_files or list_directory to find the correct path first
4. If the error is environmental (missing dependency, permission), report it to the user instead of retrying
5. Respect each structured recovery condition. Committed, partial or unknown effects require inspection before preparing remaining work; never blindly replay or roll back the original call. A retry hint does not grant permission or override a stop.
</tool_retry_hint>`
  }

  private attachToolRetryHint(results: ToolResult[], guidance: string): ToolResult[] {
    let target = -1
    for (let index = results.length - 1; index >= 0; index--) {
      if (toolResultExecutionStatus(results[index]) === 'failed') { target = index; break }
    }
    return results.map((result, index) => index === target
      ? { ...result, recovery: { ...(result.recovery ?? toolRecovery(result.errorKind ?? 'execution', 'unknown')), guidance } }
      : result)
  }

  private async captureBeforeSnapshot(filePath: string): Promise<void> {
    if (this.fileBeforeSnapshots.has(filePath)) return
    try {
      const readResult = await this.toolExecutor.readFile(filePath)
      this.fileBeforeSnapshots.set(filePath, readResult.success ? (readResult.data ?? null) : null)
    } catch {
      this.fileBeforeSnapshots.set(filePath, null)
    }
  }

  private buildDiffSnapshot(before: string, after: string): Partial<ChangeSummary> {
    if (!canComputeDiff(before, after)) {
      return {
        diffStatus: 'snapshot-too-large',
        beforeBytes: before.length,
        afterBytes: after.length,
      }
    }
    const stats = summarizeHunks(computeHunks(before, after))
    return {
      diffStatus: 'complete',
      beforeBytes: before.length,
      afterBytes: after.length,
      addedLines: stats.added,
      removedLines: stats.removed,
      before,
      after,
    }
  }

  private shouldRetryModelTransient(error: ModelProtocolRequestError): boolean {
    if (error.receivedStreamData || error.kind === 'stream' || error.kind === 'response_shape') return false
    const retryStartedAt = this.providerTransientRetryStartedAt
    const withinBudget = retryStartedAt > 0 && Date.now() - retryStartedAt < MODEL_TRANSIENT_RETRY_BUDGET_MS
    if (!withinBudget) return false
    if (error.kind === 'network') {
      return this.providerTransientRetryAttempt < MODEL_TRANSIENT_RETRY_DELAYS_MS.length
    }
    const transientStatus = error.status !== undefined && (
      MODEL_TRANSIENT_RETRYABLE_STATUSES.has(error.status)
      || (error.status >= 500 && error.status <= 599)
    )
    return transientStatus && this.providerTransientRetryAttempt < MODEL_TRANSIENT_RETRY_DELAYS_MS.length
  }

  private async waitForModelTransientRetry(error: ModelProtocolRequestError): Promise<void> {
    const retryAttempt = this.providerTransientRetryAttempt + 1
    this.providerTransientRetryAttempt = retryAttempt
    const configuredDelay = MODEL_TRANSIENT_RETRY_DELAYS_MS[retryAttempt - 1]
      ?? MODEL_TRANSIENT_RETRY_DELAYS_MS.at(-1)
      ?? 1_000
    const delayMs = Math.min(
      MAX_MODEL_TRANSIENT_RETRY_DELAY_MS,
      Math.max(configuredDelay, error.retryAfterMs ?? 0),
    )
    const retryStartedAt = this.providerTransientRetryStartedAt || Date.now()
    const remainingBudgetMs = Math.max(0, MODEL_TRANSIENT_RETRY_BUDGET_MS - (Date.now() - retryStartedAt))
    const boundedDelayMs = Math.min(delayMs, Math.max(0, remainingBudgetMs - 1))
    const maxRetries = MODEL_TRANSIENT_RETRY_DELAYS_MS.length
    const signal = this.runControl.getOperationSignal()
    const protocol = protocolLabel(error.protocol)
    const reason = error.status !== undefined
      ? `HTTP ${error.status}`
      : error.kind === 'network' ? 'network interruption' : 'temporary provider failure'

    return new Promise<void>((resolve, reject) => {
      const startedAt = Date.now()
      let timer: ReturnType<typeof setTimeout> | null = null
      let settled = false
      let notified = false
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        timer = null
        signal?.removeEventListener('abort', onAbort)
      }
      const abort = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(this.runControl.isPauseInterruption(signal?.reason) ? signal!.reason : this.runControl.createStopInterruption())
      }
      const onAbort = () => abort()
      const tick = () => {
        if (settled) return
        if (signal?.aborted) {
          abort()
          return
        }
        const remainingMs = Math.max(0, boundedDelayMs - (Date.now() - startedAt))
        if (remainingMs === 0) {
          settled = true
          cleanup()
          resolve()
          return
        }
        const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1_000))
        const detail = error.status === 429
          ? `Provider rate limited ${protocol}; retrying the same protocol in ${remainingSeconds}s (attempt ${retryAttempt}/${maxRetries}).`
          : `Provider returned ${reason} from ${protocol}; retrying the same protocol in ${remainingSeconds}s (attempt ${retryAttempt}/${maxRetries}).`
        this.setRunState('thinking', { detail })
        if (!notified) {
          notified = true
          this.emit({ type: 'notification', message: detail, level: 'warning' })
        }
        timer = setTimeout(tick, Math.min(1_000, remainingMs))
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      tick()
    })
  }

  private async callModel(): Promise<AgentTurn> {
    const activeConfig = this.stateProvider.getActiveConfig()
    const activeModel = this.stateProvider.getActiveModel()

    if (!activeConfig || !activeConfig.apiKey) {
      return this.createMockTurn()
    }

    this.ensureScheduledWorkStep()

    const turnStrategy = this.turnStrategyPlanner.plan(this.session, this.config.mode)
    this.currentTurnStrategy = turnStrategy
    const currentUserTurn = [...this.session.turns].reverse().find(turn => turn.role === 'user' && !turn.metadata?.internal)
    const needsRuntimePreparation = typeof currentUserTurn?.metadata?.runtimeContext !== 'string'
    if (needsRuntimePreparation) {
      await Promise.all([
        this.maybeRefreshWorkspaceMemory(),
        this.refreshGitStatus(),
      ])
    }
    // Long-conversation persona drift reminder — empty string when below threshold.
    const voiceReminderContext: string | null = null
    const selectedCapabilities = currentUserTurn?.metadata?.capabilities?.items || []
    const capabilityContext = selectedCapabilities.length > 0
      ? this.wrapRuntimeContextSection('emphasized_capabilities', [
          'All installed Skills and connected plugins remain available. The user emphasized these capabilities for this turn, so prefer them when relevant without treating unlisted capabilities as unavailable:',
          ...selectedCapabilities.map(item => `- ${item.type === 'skill' ? 'Skill' : 'Plugin'}: ${item.name} (${item.id})`),
        ].join('\n'))
      : null
    const runtimeContextCandidate = [
      this.config.appendSystemPrompt,
      this.finalDeliveryRetryAttempts > 0
        ? this.wrapRuntimeContextSection('final_delivery_contract', 'The previous model response was empty. Return one visible, self-contained final answer now. Do not call tools unless new work is strictly required.')
        : null,
      this.wrapRuntimeContextSection('available_subagents', this.getAgentDefinitions().map(agent => agent.id + ': ' + agent.description).join('\n')),
      currentUserTurn?.metadata?.workflowContext
        ? this.wrapRuntimeContextSection('workflow_checkpoint', currentUserTurn.metadata.workflowContext)
        : null,
      capabilityContext,
      voiceReminderContext,
      this.cachedGitStatus ? this.wrapRuntimeContextSection('git_status', this.cachedGitStatus) : null,
      this.workspaceMemoryText ? this.wrapRuntimeContextSection('workspace_memory', this.workspaceMemoryText) : null,
    ].filter(Boolean).join('\n\n') || undefined
    this.captureRuntimeContext(currentUserTurn, runtimeContextCandidate || '')

    const systemPrompt = buildSystemPrompt(this.config.mode, {
      workspacePath: this.config.workspacePath,
      workspaceName: this.config.workspaceName,
      systemPromptOverride: this.config.systemPromptOverride,
      profileSystemPrompt: this.config.profileSystemPrompt,
      enabledSkills: this.config.enabledSkills,
      provider: activeConfig.provider,
      modelId: activeConfig.defaultModel,
      shell: this.config.shell,
    })

    const startTime = Date.now()
    this.providerTransientRetryAttempt = 0
    this.providerTransientRetryStartedAt = startTime
    const protocolCandidates = planModelProtocols(
      activeConfig.provider,
      activeConfig.defaultModel,
      activeConfig.modelCapabilities?.supportedEndpoints,
    )
    const preservedFiles = this.preservedFiles.map(file => ({ ...file }))
    const activatedSkills = [...this.activatedRunSkills.values()].map(skill => ({
      id: skill.id,
      content: buildActivatedSkillsContext([skill]),
    }))
    const requestSurfaceTurns = this.prepareModelSurfaceForRequest(activeConfig, activeModel, preservedFiles, activatedSkills)
    const messagesByProvider = new Map<'openai' | 'anthropic', Array<Record<string, unknown>>>()
    const messagesFor = (provider: 'openai' | 'anthropic') => {
      const cached = messagesByProvider.get(provider)
      if (cached) return cached
      const messages = this.buildApiMessages(systemPrompt, provider, requestSurfaceTurns)
      messagesByProvider.set(provider, messages)
      return messages
    }
    if (preservedFiles.length > 0) {
      this.preservedFiles = []
      this.modelSurface.appendSnapshot('compaction_files', null)
      this.session.modelSurface = this.modelSurface.getState()
    }

    this.modelRequestId = randomUUID()
    this.lastModelAttempt = undefined
    try {
      const turn = await runModelRequest({
        protocols: protocolCandidates,
        urlFor: protocol => buildModelProtocolUrl(activeConfig.baseUrl, protocol, activeConfig.provider),
        invoke: protocol => this.callModelProvider(protocol, activeConfig, activeModel,
          messagesFor(getModelProviderAdapter(protocol).messageFormat), startTime, turnStrategy),
        isAborted: error => (error as { aborted?: boolean })?.aborted === true
          || this.abortController?.signal.aborted === true
          || this.runControl.isPauseInterruption(error),
        shouldRetry: error => this.shouldRetryModelTransient(error),
        waitForRetry: error => this.waitForModelTransientRetry(error),
        onAttempt: (protocol, url) => {
          this.emit({ type: 'model:protocol', phase: 'attempt', protocol, url })
        },
        onSuccess: (protocol, url) => {
          this.emit({ type: 'model:protocol', phase: 'success', protocol, url })
          this.providerTransientRetryAttempt = 0
          this.providerTransientRetryStartedAt = 0
        },
        onFallback: ({ nextProtocol, nextUrl, message }) => {
          this.emit({ type: 'stream:end' })
          this.emit({
            type: 'model:protocol',
            phase: 'fallback',
            protocol: nextProtocol,
            url: nextUrl,
            message,
          })
        },
      })
      const measuredAttempt = this.latestModelAttempt()
      if (measuredAttempt) {
        turn.metadata = { ...turn.metadata, modelRequestId: measuredAttempt.requestId, modelAttemptId: measuredAttempt.id,
          tokens: { ...measuredAttempt.usage } }
      }
      return turn
    } catch (error) {
      if (this.runControl.isPauseInterruption(error)) {
        return this.createPausedAssistantTurn('', '', activeModel, startTime)
      }
      const errAborted = (error as { aborted?: boolean })?.aborted === true
        || this.abortController?.signal.aborted === true
      if (errAborted) {
        throw error
      }
      const errorMsg = error instanceof Error ? error.message : 'API call failed'
      if (this.isContextLimitError(errorMsg) && !this.contextLimitRetryInProgress) {
        this.contextLimitRetryInProgress = true
        this.forceContextCompactionBeforeNextCall = true
        this.emit({
          type: 'notification',
          message: 'Provider reported context limit; compacting conversation and retrying once.',
          level: 'warning',
        })
        await this.prepareContextWindow()
        return await this.callModel()
      }
      this.emit({ type: 'error', error: errorMsg })
      return this.createAssistantTurn(`**Request Error**\n\n${errorMsg}`, undefined, {
        internal: true,
        internalKind: 'request_error',
        internalError: errorMsg,
      })
    }
  }

  private latestModelAttempt(): ModelRequestRecord | undefined { return this.lastModelAttempt }

  private publishModelUsage(usage: TokenUsage): void {
    this.activeModelAttempt?.usage(usage)
    this.emit({ type: 'stream:usage', usage,
      ...(this.activeModelAttempt ? { requestId: this.activeModelAttempt.record.requestId, attemptId: this.activeModelAttempt.record.id } : {}),
    })
  }

  private publishCacheDiagnostic(result: CacheBreakResult): void {
    if (this.lastModelAttempt) {
      this.lastModelAttempt = { ...this.lastModelAttempt, cacheDiagnostic: {
        broken: result.broken, reason: result.reason, tokenDrop: result.tokenDrop, likelyTtlExpiry: result.likelyTtlExpiry,
        ...(result.requestTiming ? { requestTiming: result.requestTiming } : {}),
      }, updatedAt: Date.now() }
      this.emit({ type: 'model:request', request: structuredClone(this.lastModelAttempt) })
    }
    this.emit({ type: 'cache:diagnostic', result })
  }

  private async streamModelAttempt(
    protocol: ModelProtocol, config: APIConfig, url: string, headers: Record<string, string>, serializedBody: string,
    onLine: (line: string) => void, options: RequestOptions,
    state: () => { sawTerminalEvent: boolean; interrupted?: boolean; streamFailure?: string },
  ): Promise<Result<string>> {
    const previous = this.activeModelAttempt
    const beginAttempt = () => this.modelRequestTracker.begin({
      requestId: this.modelRequestId || randomUUID(), runId: this.workExecution.getCurrentRunId() || undefined,
      protocol, provider: config.provider, model: config.defaultModel, purpose: 'turn', serializedBody,
    })
    let attempt = beginAttempt()
    this.activeModelAttempt = attempt
    try {
      this.modelRequestGuard?.()
      const result = await this.toolExecutor.streamMessage(url, headers, serializedBody, onLine, {
        ...options,
        onAttempt: index => {
          if (index > 0) {
            attempt.finish('failed')
            attempt = beginAttempt()
            this.activeModelAttempt = attempt
            this.modelRequestGuard?.()
          }
          options.onAttempt?.(index)
        },
        onRetry: httpStatus => {
          this.lastModelAttempt = attempt.finish('failed', httpStatus)
          options.onRetry?.(httpStatus)
        },
      })
      const stream = state()
      const status = options.signal?.aborted ? 'interrupted'
        : !result.success || stream.streamFailure ? 'failed'
        : !stream.sawTerminalEvent || stream.interrupted ? 'interrupted' : 'completed'
      this.lastModelAttempt = attempt.finish(status, result.status)
      return result
    } catch (error) {
      this.lastModelAttempt = attempt.finish(options.signal?.aborted ? 'interrupted' : 'failed')
      throw error
    } finally {
      this.activeModelAttempt = previous
    }
  }

  private async sendCompactionAttempt(
    requestId: string, protocol: ModelProtocol, config: APIConfig, url: string,
    headers: Record<string, string>, serializedBody: string, options: RequestOptions,
  ): Promise<Result<string>> {
    const beginAttempt = () => this.modelRequestTracker.begin({ requestId, protocol, provider: config.provider, model: config.defaultModel,
      runId: this.workExecution.getCurrentRunId() || undefined, purpose: 'compaction', serializedBody })
    let attempt = beginAttempt()
    const onUsage = (usage: TokenUsage) => {
      attempt.usage(usage)
      this.emit({ type: 'stream:usage', usage, requestId, attemptId: attempt.record.id })
    }
    try {
      this.modelRequestGuard?.()
      const result = await this.toolExecutor.sendMessage(url, headers, serializedBody, {
        ...options,
        onAttempt: index => {
          if (index > 0) { attempt.finish('failed'); attempt = beginAttempt(); this.modelRequestGuard?.() }
          options.onAttempt?.(index)
        },
        onRetry: httpStatus => {
          attempt.finish('failed', httpStatus)
          options.onRetry?.(httpStatus)
        },
      })
      let status: ModelRequestRecord['status'] = options.signal?.aborted ? 'interrupted' : result.success ? 'completed' : 'failed'
      if (result.success && result.data) {
        try {
          const response = getModelProviderAdapter(protocol).readSummary(result.data)
          if (response.responseId) attempt.responseId(response.responseId)
          for (const usage of response.usage) onUsage(usage)
          if (!response.structured || !response.text.trim()) status = 'failed'
        } catch { status = 'failed' }
      }
      attempt.finish(status, result.status)
      return result
    } catch (error) {
      attempt.finish(options.signal?.aborted ? 'interrupted' : 'failed')
      throw error
    }
  }

  private nextModelRequestTraceHeaders(protocol: ModelProtocol): Record<string, string> {
    this.currentModelRequestRound += 1
    const conversationId = this.config.conversationId || this.stateProvider.getConversationId()
    const workRunId = this.workExecution.getCurrentRunId()
    return {
      ...(conversationId ? { 'x-fluxagent-conversation-id': conversationId } : {}),
      ...(workRunId ? { 'x-fluxagent-run-id': workRunId } : {}),
      'x-fluxagent-round': String(this.currentModelRequestRound),
      'x-fluxagent-protocol': protocol,
    }
  }

  private async callModelProvider(
    protocol: ModelProtocol,
    config: APIConfig,
    model: APIModel | null,
    messages: Array<Record<string, unknown>>,
    startTime: number,
    turnStrategy?: TurnStrategy | null,
  ): Promise<AgentTurn> {
    const adapter = getModelProviderAdapter(protocol)
    const request = adapter.prepare({
      config, model, settings: this.config, messages,
      systemPrompt: (messages.find(message => message.role === 'system' && typeof message.content === 'string')?.content as string) || '',
      tools: getToolsForMode(this.config.mode, { disabledTools: this.modelDisabledToolNames() }),
      externalTools: this.mcpClient ? this.modelMcpTools() : [],
      traceHeaders: this.nextModelRequestTraceHeaders(protocol),
      promptCacheKey: (name, tools) => this.buildPromptCacheKey(name, tools),
    })
    this.emitPromptModuleSnapshot(request.prompt.system, request.prompt.tools, request.prompt.messages)
    this.emit({ type: 'stream:start' })
    const operationSignal = this.runControl.getOperationSignal()
    const exchange = await this.modelStreams.run(operationSignal, streamId => exchangeModelRequest(adapter, request, {
      signal: operationSignal, streamId,
      callbacks: {
        onTextDelta: text => {
          this.activeModelAttempt?.outputChunk('answer', text.length > 0)
          this.emit({ type: 'stream:delta', text })
        },
        onReasoningDelta: text => {
          this.activeModelAttempt?.outputChunk('reasoning', text.length > 0)
          this.emit({ type: 'stream:thinking_delta', text })
        },
        onToolCallDelta: call => {
          this.activeModelAttempt?.outputChunk('tool', Boolean(call.name || call.argumentsJson))
          this.emit({ type: 'stream:tool_call_delta', toolCallId: call.id, toolName: call.name,
            partialJson: streamToolArgumentPreview(call.argumentsJson) })
        },
        onUsage: usage => this.publishModelUsage(usage),
        onResponseId: id => this.activeModelAttempt?.responseId(id),
      },
      notify: message => this.emit({ type: 'notification', level: 'warning', message }),
      send: (prepared, serialized, onLine, options, state) => this.streamModelAttempt(
        protocol, config, prepared.url, prepared.headers, serialized, onLine, options, state),
    }))
    const { stream, result } = exchange
    if (!result.success) {
      if (this.runControl.isPauseSignal(operationSignal)) {
        return this.createPausedAssistantTurn(stream.text, stream.reasoning, model, startTime)
      }
      if (this.abortController?.signal.aborted) {
        const turn = this.finishInterruptedStream(stream.text, stream.reasoning, model, startTime,
          resolveAgentRunInterruption(operationSignal) || interruptionMetadata('stop'))
        if (turn) return turn
        const error = new Error('aborted') as Error & { aborted?: boolean }
        error.aborted = true
        throw error
      }
    }
    const completion = adapter.complete(exchange)
    if (completion.rememberRequest) this.rememberWarmRequestPrefix(protocol, request.body)
    if (completion.failure) {
      const { error, reportAsRequestError, preservePartial } = completion.failure
      const turn = preservePartial ? this.finishInterruptedStream(completion.text, completion.reasoning, model, startTime) : null
      if (turn) {
        if (reportAsRequestError) turn.metadata = { ...turn.metadata, internalKind: 'request_error', internalError: error.message }
        return turn
      }
      throw error
    }
    const { tokens, interrupted, reasoning, toolCalls, text } = completion
    this.session.totalTokens.input += tokens.input
    this.session.totalTokens.output += tokens.output
    this.contextManager.updateCurrentContextUsage(tokens.input, tokens.output, tokens.cached)
    if (completion.shouldRecordUsage) this.stateProvider.recordTokenUsage({ provider: config.provider, model: config.defaultModel, ...completion.usage })
    const cacheDiagnosis = observeModelCache(this.cacheMonitor, {
      protocol, provider: config.provider, serializedBody: exchange.serializedBody, headers: request.headers, strategy: turnStrategy?.intent,
      requestStartedAt: exchange.requestStartedAt, responseReceivedAt: exchange.responseReceivedAt,
    }, completion.cache)
    if (cacheDiagnosis?.broken) this.publishCacheDiagnostic(cacheDiagnosis)
    this.emit(interrupted ? { type: 'stream:end', interrupted: true } : { type: 'stream:end' })
    const effort = request.reasoning?.reasoningEffort ?? request.reasoning?.outputConfig?.effort
    return this.createAssistantTurn(text, toolCalls, {
      model: model?.name, tokens, duration: Date.now() - startTime, mode: this.config.mode,
      ...(interrupted ? { interrupted: true } : {}),
      reasoningEnabled: request.reasoning?.enabled, reasoningEffort: effort,
      thinking: reasoning ? { content: reasoning, source: 'provider', status: interrupted ? 'interrupted' : 'complete',
        durationMs: Date.now() - startTime, tokenCount: completion.reasoningTokenCount, effort } : undefined,
      rawReasoningPayload: completion.rawReasoningPayload,
    })
  }

  private injectPendingSubAgentCompletions(newTurns: AgentTurn[] = []): void {
    const ownerSessionId = this.config.conversationId
    const workRunId = this.workExecution.getCurrentRunId()
    if (!ownerSessionId || !workRunId) return
    injectSubAgentDeliveries({
      manager: this.subAgentTaskManager, ownerSessionId, workRunId,
      turns: this.session.turns, knownTurns: this.getFullConversationTurns(), newTurns,
      compactedTurnIds: this.stateProvider.getContextSegments().filter(segment => segment.isValid).flatMap(segment => segment.coveredTurnIds || []),
    })
  }

  private wrapRuntimeContextSection(tag: string, content: string): string {
    const trimmed = content.trim()
    return trimmed ? `<${tag}>\n${trimmed}\n</${tag}>` : ''
  }

  private captureRuntimeContext(turn: AgentTurn | undefined, candidate: string): void {
    if (!turn || typeof turn.metadata?.runtimeContext === 'string') return
    const runtimeContext = candidate.trim()
      ? [
          '<runtime_context>',
          'Internal execution context for this turn. Do not acknowledge, quote, translate, or roleplay this block.',
          candidate,
          '</runtime_context>',
        ].join('\n')
      : ''
    turn.metadata = { ...turn.metadata, runtimeContext }
  }

  private buildPromptCacheKey(model: string, tools: unknown[]): string {
    // This is a routing hint, not a conversation identifier. Identical static
    // prefixes in one workspace should reach the same cache across tasks;
    // providers still match the actual prompt before reusing any tokens.
    const workspaceKey = stableHash(this.config.workspacePath || '')
    const toolHash = stableHash(tools)
    const mode = this.config.mode || 'vibe'
    return `tf:${model}:${mode}:${workspaceKey}:${toolHash}`.slice(0, 240)
  }

  private emitPromptModuleSnapshot(systemPrompt: string, tools: unknown[], messages: Array<Record<string, unknown>>): void {
    const contextChars = this.stateProvider.getContextSegments().reduce((sum, segment) => sum + segment.summary.length, 0)
    const moduleText = (value: unknown) => {
      try {
        return typeof value === 'string' ? value : JSON.stringify(value)
      } catch {
        return ''
      }
    }
    const modules: PromptModuleSnapshot[] = [
      {
        id: 'system',
        label: 'System',
        hash: stableHash(systemPrompt),
        chars: systemPrompt.length,
        stable: true,
      },
      {
        id: 'tools',
        label: 'Tools',
        hash: stableHash(tools),
        chars: moduleText(tools).length,
        stable: true,
      },
      {
        id: 'workspace',
        label: 'Workspace',
        hash: stableHash({
          workspace: this.config.workspacePath,
          memory: this.workspaceMemoryText,
        }),
        chars: this.workspaceMemoryText?.length || 0,
        stable: true,
      },
      {
        id: 'context',
        label: 'Context',
        hash: stableHash(this.stateProvider.getContextSegments().map(segment => ({
          start: segment.startMessageId,
          end: segment.endMessageId,
          summary: segment.summary,
        }))),
        chars: contextChars,
        stable: false,
      },
      {
        id: 'tail',
        label: 'Tail',
        hash: stableHash(messages.slice(-4)),
        chars: moduleText(messages.slice(-4)).length,
        stable: false,
      },
    ]
    this.emit({ type: 'cache:modules', modules })
  }

  private ensureScheduledWorkStep(): void {
    const runId = this.workExecution.getCurrentRunId()
    if (!runId) return
    const running = this.taskManager.getActiveTaskContexts().some(task => this.taskManager.getTask(task.taskId)?.metadata?.workRunId === runId)
    if (running) return
    const next = this.taskManager.getFirstPendingLeafTask(runId)
    if (next) this.taskManager.updateTask(next.id, { status: 'in_progress' })
  }

  private buildWorkExecutionContext(): string {
    const runId = this.workExecution.getCurrentRunId()
    if (!runId) return ''
    const tasks = this.taskManager.getTasksForWorkRun(runId)
    if (tasks.length === 0) return ''
    const activeIds = new Set(this.taskManager.getActiveTaskContexts().map(task => task.taskId))
    const lines = [
      '<work_execution>',
      `run_id: ${runId}`,
      'The runtime owns dependency scheduling. Work only on running steps or explicitly start another ready step when genuine parallelism is useful.',
      'A failed tool call is an attempt, not a failed step. Retry or choose another method, then set the final step outcome explicitly.',
    ]
    for (const task of tasks.sort((left, right) => left.order - right.order)) {
      const dependencyState = task.dependencies.length > 0 ? ` deps=[${task.dependencies.join(',')}]` : ''
      lines.push(`- ${task.id} [${activeIds.has(task.id) ? 'running' : task.status}] ${task.title}${dependencyState}`)
    }
    const blocked = this.taskManager.getBlockedTasks(runId)
    if (blocked.length > 0) lines.push(`blocked: ${blocked.map(task => task.id).join(', ')}`)
    lines.push('</work_execution>')
    return lines.join('\n')
  }

  private buildPreservedFilesContext(sourceFiles: Array<{ path: string; content: string }>): string {
    const recentReadPaths = new Set<string>()
    for (const turn of this.session.turns) {
      for (const toolCall of turn.toolCalls ?? []) {
        if ((toolCall.name === 'read_file' || toolCall.name === 'read_file_full') && typeof toolCall.arguments.path === 'string') {
          recentReadPaths.add(toolCall.arguments.path)
        }
      }
    }
    const filesToInclude = sourceFiles.filter(file => !recentReadPaths.has(file.path))
    if (filesToInclude.length === 0) return ''
    const parts: string[] = [
      '<recent_files>',
      'These files were recently accessed before context compression and remain relevant:',
    ]
    for (const file of filesToInclude) parts.push(`<file path="${file.path}">\n${file.content}\n</file>`)
    parts.push('</recent_files>')
    return parts.join('\n\n')
  }

  private prepareModelSurfaceForRequest(
    activeConfig: APIConfig,
    activeModel: APIModel | null,
    preservedFiles: Array<{ path: string; content: string }>,
    activatedSkills?: Array<{ id: string; content: string }>,
  ): AgentTurn[] {
    const maxOutputTokens = this.config.maxTokens || activeModel?.maxTokens || 4096
    const contextWindow = activeModel?.contextWindow || activeConfig.contextWindow || this.config.contextWindow || 200_000
    const prepared = this.contextCoordinator.prepareModelSurface({
      modelSurface: this.modelSurface,
      candidateTurns: this.buildContextCandidateTurns(contextWindow, maxOutputTokens),
      workExecutionContext: this.buildWorkExecutionContext(),
      activatedSkills,
      preservedFilesContext: preservedFiles.length > 0
        ? this.buildPreservedFilesContext(preservedFiles)
        : undefined,
      currentRunId: this.workExecution.getCurrentRunId() || undefined,
      // Unknown models must not receive local attachments unless the active
      // model metadata explicitly advertises vision input.
      supportsVision: activeConfig.modelCapabilities?.vision ?? activeModel?.supportsVision ?? false,
    })
    this.session.modelSurface = prepared.state
    return prepared.turns
  }

  private buildApiMessages(
    systemPrompt: string,
    provider: 'openai' | 'anthropic',
    surfaceTurns: readonly AgentTurn[] = this.modelSurface.projectTurns(),
  ): Array<Record<string, unknown>> {
    const activeConfig = this.stateProvider.getActiveConfig()
    const activeModel = this.stateProvider.getActiveModel()
    const maxOutputTokens = this.config.maxTokens || activeModel?.maxTokens || 4096
    const contextWindow = activeModel?.contextWindow || activeConfig?.contextWindow || this.config.contextWindow || 200_000
    const policyProfile = resolveContextPolicyProfile(this.config.contextPolicy)
    const candidateTurns = projectTurnsForModelContext(surfaceTurns)

    // Fetch valid context segments from the current conversation
    let contextSegments: ContextSegment[] | undefined
    const convId = this.config.conversationId || this.stateProvider.getConversationId()
    if (convId) {
      contextSegments = this.stateProvider.getContextSegments()
    }

    return this.contextManager.buildMessages(
      candidateTurns,
      systemPrompt,
      contextWindow,
      provider,
      maxOutputTokens,
      contextSegments,
      policyProfile,
      activeModel?.id || activeConfig?.defaultModel,
      activeConfig?.modelCapabilities?.vision ?? activeModel?.supportsVision ?? false,
    )
  }

  private buildContextCandidateTurns(_contextWindow: number, _maxOutputTokens: number): AgentTurn[] {
    return this.session.turns
  }


  /**
   * Pull the latest workspace memory snapshot from the main process.
   *
   * Caching strategy: the main MemoryService keys its own cache by file
   * mtimes, so calling memoryList every turn is cheap when nothing changed
   * (one stat per known rule file, no parsing). We additionally short-
   * circuit on `builtAt` to avoid even the IPC round-trip on back-to-back
   * turns within ~10s of each other; if the user was actively editing a
   * rule file we want the new content fast, so the TTL is intentionally
   * short.
   *
   * Failure mode: any IPC error leaves the previous text intact rather
   * than nulling it out. Stale-but-present is strictly better than
   * losing the user's project rules just because a stat call hiccupped.
   */
  private async maybeRefreshWorkspaceMemory(): Promise<void> {
    const workspace = this.stateProvider.getWorkspace()
    const wsPath = workspace?.path || ''
    if (!wsPath) {
      this.workspaceMemoryText = null
      this.workspaceMemoryWorkspace = null
      this.workspaceMemoryBuiltAt = 0
      return
    }

    const now = Date.now()
    const sameWorkspace = this.workspaceMemoryWorkspace === wsPath
    const fresh = sameWorkspace && (now - this.workspaceMemoryBuiltAt) < 10_000
    if (fresh) return

    // Query-aware path: if we have a recent user message, ask the main
    // process to rank rules by relevance and trim to a tighter budget.
    // Falls back to full snapshot on any error or when no message yet.
    const latestUserMessage = (() => {
      for (let i = this.session.turns.length - 1; i >= 0; i--) {
        const t = this.session.turns[i]
        if (t.role === 'user' && t.content.trim()) return t.content
      }
      return ''
    })()

    if (latestUserMessage && typeof this.toolExecutor.memoryGetRelevantInjection === 'function') {
      try {
        const resp = await this.toolExecutor.memoryGetRelevantInjection({
          workspacePath: wsPath,
          query: latestUserMessage,
        })
        const injectedText = resp?.data?.text
        if (resp?.success && typeof injectedText === 'string') {
          this.workspaceMemoryText = injectedText.trim() || null
          this.workspaceMemoryWorkspace = wsPath
          this.workspaceMemoryBuiltAt = now
          return
        }
      } catch {
        // fall through to full snapshot
      }
    }

    try {
      const response = await this.toolExecutor.memoryList(wsPath)
      if (!response?.success || !response.data?.snapshot) {
        if (!sameWorkspace) {
          this.workspaceMemoryText = null
          this.workspaceMemoryWorkspace = wsPath
          this.workspaceMemoryBuiltAt = now
        }
        return
      }
      const text = response.data.snapshot.injectionText.trim()
      this.workspaceMemoryText = text.length > 0 ? text : null
      this.workspaceMemoryWorkspace = wsPath
      this.workspaceMemoryBuiltAt = now
    } catch {
      // Keep prior text on transient IPC failure.
    }
  }

  private buildEvidenceGuardHint(): string | null {
    // If the model already performed any read operations (read_file,
    // list_directory, search_*), it has gathered evidence.
    // Don't force a retry — trust the model's judgment on when to conclude.
    if (this.currentRunReadFiles.size > 0) return null
    if (this.currentRunSuccessfulSearches.size > 0) return null
    if (this.currentRunToolNames.some(n => n === 'list_directory')) return null
    return this.buildEvidencePolicyContext(this.currentTurnStrategy, 'retry')
  }

  private buildEvidencePolicyContext(strategy?: TurnStrategy | null, phase: 'pre' | 'retry' = 'pre'): string | null {
    if (!strategy?.requiresEvidence) return null
    const maxAttempts = 1
    if (phase === 'retry' && this.conclusionGuardAttempts >= maxAttempts) return null

    const hasSearchEvidence = this.currentRunSuccessfulSearches.size > 0
    const hasDirectRead = this.currentRunSuccessfulReadFiles.size > 0
    if (hasSearchEvidence && hasDirectRead) return null

    const tag = phase === 'retry' ? 'evidence_guard' : 'evidence_policy'
    if (phase === 'retry') {
      return `<${tag} intent="${strategy.intent}" scope="${strategy.scope}">
Resolve the remaining uncertainty using relevant source ranges. Search again only when the prior evidence leaves a concrete gap; explain any unresolved limits in the answer.
</${tag}>`
    }
    return `<${tag} intent="${strategy.intent}" scope="${strategy.scope}">
Support claims with inspected source text. Use known paths directly, or locate candidates with search_files/search_content and read the relevant ranges. State residual uncertainty plainly.
</${tag}>`
  }

  private recordToolUsage(name: string, args: Record<string, unknown>): void {
    this.currentRunToolNames.push(name)
    if ((name === 'read_file' || name === 'read_file_full') && typeof args.path === 'string') {
      this.currentRunReadFiles.add(args.path)
    }
    if (name.startsWith('search_')) {
      const query = (args.query || args.pattern || '') as string
      this.currentRunSearches.add(`${name}:${query}`)
    }
  }

  private recordSuccessfulToolUsage(name: string, args: Record<string, unknown>, output: string): void {
    if ((name === 'read_file' || name === 'read_file_full') && typeof args.path === 'string') {
      this.currentRunSuccessfulReadFiles.add(args.path)
    }
    // Bug 1 fix: search_files was excluded here while recordToolUsage()
    // already adds it to currentRunSearches via the name.startsWith('search_')
    // branch. The asymmetry meant evidence_guard's hasSearchEvidence
    // (currentRunSuccessfulSearches.size > 0) could never be satisfied by a
    // pure search_files-driven run, so the model was forced to retry even
    // after a successful filename scan. Treat search_files exactly like the
    // other search_* tools and gate "no hits" output the same way.
    if (
      name === 'search_files'
      || name === 'search_content'
    ) {
      if (/No results in this page\./.test(output) || /^(No matches found|No matching files found)$/i.test(output.trim())) return
      const query = (args.query || args.pattern || '') as string
      this.currentRunSuccessfulSearches.add(`${name}:${query}`)
    }
  }


  /**
   * Walk the existing session.turns and re-record each historical tool call
   * + result into currentRun* sets so the evidence guard treats restored
   * reads/searches as valid evidence in the new run (Bug #19).
   */
  private replayEvidenceFromExistingTurns(): void {
    const resultsByCallId = new Map<string, ToolResult>()
    for (const turn of this.session.turns) {
      if (turn.role !== 'tool_result' || !turn.toolResults) continue
      for (const result of turn.toolResults) {
        resultsByCallId.set(toolInvocationKey(result.toolCallId, result.operationIdentity), result)
      }
    }

    for (const turn of this.session.turns) {
      if (turn.role !== 'assistant' || !turn.toolCalls || turn.toolCalls.length === 0) continue
      for (const tc of turn.toolCalls) {
        this.recordToolUsage(tc.name, tc.arguments)
        const result = resultsByCallId.get(toolInvocationKey(tc.id, tc.operationIdentity))
        if (result && !result.isError) {
          this.recordSuccessfulToolUsage(tc.name, tc.arguments, result.output || '')
        }
      }
    }
  }

  private async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    if (toolCalls.length === 0) return []
    const operationSignal = this.runControl.getOperationSignal()

    for (const toolCall of toolCalls) {
      toolCall.arguments = normalizeBuiltInToolArguments(toolCall.name, toolCall.arguments)
    }

    try {
      return await this.toolExecutionCoordinator.execute(toolCalls, operationSignal)
    } finally {
      this.fileBeforeSnapshots.clear()
    }
  }

  private toolCallsBeforeUserAnswer(toolCalls: ToolCall[]): ToolCall[] {
    const interactiveCall = toolCalls.find(toolCall => toolCall.name === 'ask_user' || toolCall.name === 'present_workflow')
    return interactiveCall ? [interactiveCall] : toolCalls
  }

  private pendingAutomaticWorkflowCheckpoint(): WorkflowCheckpointSpec | undefined {
    const workflow = this.activeWorkflowContract
    if (!workflow) return undefined
    const stageOrder = workflow.stages || workflow.checkpoints.map(checkpoint => checkpoint.stage)
    for (const stage of stageOrder) {
      const checkpoint = workflow.checkpoints.find(candidate => candidate.stage === stage)
      if (checkpoint && !this.completedWorkflowStages.has(stage)) return checkpoint
    }
    return workflow.checkpoints.find(checkpoint => !this.completedWorkflowStages.has(checkpoint.stage))
  }

  private workflowCheckpointTriggerMatches(checkpoint: WorkflowCheckpointSpec, toolCall: ToolCall): boolean {
    const trigger = checkpoint.trigger
    const triggerTools = [trigger.tool, ...(trigger.tools || [])].filter((tool): tool is string => Boolean(tool))
    if (!triggerTools.includes(toolCall.name)) return false
    if (!trigger.argument) return true
    const value = String(toolCall.arguments[trigger.argument] ?? '')
    if (trigger.equals !== undefined && value !== trigger.equals) return false
    if (trigger.includes !== undefined && !value.includes(trigger.includes)) return false
    if (trigger.endsWith !== undefined && !value.replaceAll('\\', '/').endsWith(trigger.endsWith.replaceAll('\\', '/'))) return false
    return true
  }

  private toolCallsBeforeWorkflowCheckpoint(toolCalls: ToolCall[]): ToolCall[] {
    const checkpoint = this.pendingAutomaticWorkflowCheckpoint()
    if (!checkpoint) return toolCalls
    const triggerIndex = toolCalls.findIndex(toolCall => this.workflowCheckpointTriggerMatches(checkpoint, toolCall))
    return triggerIndex >= 0 ? toolCalls.slice(0, triggerIndex + 1) : toolCalls
  }

  private workflowBlockedToolMessage(toolCall: ToolCall): string | undefined {
    const checkpoint = this.pendingAutomaticWorkflowCheckpoint()
    if (!checkpoint?.blockBeforeTrigger?.includes(toolCall.name)) return undefined
    const trigger = checkpoint.trigger
    const triggerTools = [trigger.tool, ...(trigger.tools || [])].filter((tool): tool is string => Boolean(tool))
    const matchers = [
      trigger.argument ? `argument ${trigger.argument}` : '',
      trigger.includes ? `including ${JSON.stringify(trigger.includes)}` : '',
      trigger.endsWith ? `ending with ${JSON.stringify(trigger.endsWith)}` : '',
      trigger.equals ? `equal to ${JSON.stringify(trigger.equals)}` : '',
    ].filter(Boolean).join(', ')
    return `Error: workflow checkpoint "${checkpoint.stage}" must be prepared before using "${toolCall.name}". Complete one of the required ${triggerTools.join(' or ')} calls${matchers ? ` (${matchers})` : ''}; the host will then open the checkpoint automatically.`
  }

  private triggeredWorkflowCheckpoint(toolCalls: ToolCall[], toolResults: ToolResult[]): WorkflowCheckpointSpec | undefined {
    const checkpoint = this.pendingAutomaticWorkflowCheckpoint()
    if (!checkpoint) return undefined
    const triggerCall = toolCalls.find(toolCall => this.workflowCheckpointTriggerMatches(checkpoint, toolCall))
    if (!triggerCall) return undefined
    const result = toolResults.find(candidate => candidate.toolCallId === triggerCall.id)
    return result && toolResultExecutionStatus(result) === 'completed' ? checkpoint : undefined
  }

  private async presentAutomaticWorkflowCheckpoint(checkpoint: WorkflowCheckpointSpec, workRunId: string): Promise<void> {
    const workflow = this.activeWorkflowContract
    if (!workflow) return
    const response = await this.requestWorkflowSurface({
      requestId: `workflow-auto-${workRunId}-${workflow.workflow}-${checkpoint.stage}`,
      question: checkpoint.question,
      ui: {
        workflow: workflow.workflow,
        stage: checkpoint.stage,
        renderer: checkpoint.renderer,
        title: checkpoint.title,
        detail: checkpoint.detail,
        explorationId: checkpoint.explorationId,
        choices: checkpoint.choices?.map(choice => ({ ...choice })),
        directions: checkpoint.directions?.map(direction => ({ ...direction })),
        input: checkpoint.input ? { ...checkpoint.input } : undefined,
      },
    })
    if (response === 'cancelled') {
      this.reportWorkflowCancellation(workflow.workflow, checkpoint.stage)
      throw this.runControl.createStopInterruption()
    }
    this.recordWorkflowStageResponse(workflow.workflow, checkpoint.stage, response, workRunId)
  }

  private recordWorkflowStageResponse(workflowId: string, stage: string, response: string, workRunId: string): void {
    const workflow = this.activeWorkflowContract
    if (!workflow || workflow.workflow !== workflowId || !stage) return
    this.completedWorkflowStages.add(stage)
    this.workflowProgressHandler?.({
      instanceId: workflow.instanceId,
      workflow: workflowId,
      stage,
      status: 'resolved',
      response,
    })
    const userTurn = [...this.session.turns].reverse().find(turn => (
      turn.role === 'user' && !turn.metadata?.internal && (turn.metadata?.workRunId === workRunId || !turn.metadata?.workRunId)
    ))
    if (!userTurn) return
    const selection = `Workflow ${workflowId} entered stage ${stage}. The user selected ${JSON.stringify(response)}. Treat this as the resolved checkpoint, continue from the selected branch, and do not ask this decision again.`
    const workflowContext = [userTurn.metadata?.workflowContext, selection].filter(Boolean).join('\n')
    userTurn.metadata = { ...userTurn.metadata, workflowContext }
    delete userTurn.metadata.runtimeContext
  }

  private reportWorkflowCancellation(workflowId: string, stage: string): void {
    const workflow = this.activeWorkflowContract
    if (!workflow || workflow.workflow !== workflowId || !stage) return
    this.workflowProgressHandler?.({
      instanceId: workflow.instanceId,
      workflow: workflowId,
      stage,
      status: 'cancelled',
    })
  }

  private linkToolCallToActiveTask(toolCall: ToolCall): void {
    const path = this.extractToolCallPath(toolCall)
    const invocationId = toolInvocationKey(toolCall.id, toolCall.operationIdentity)
    const linkedTaskId = this.taskManager.addToolCallToActiveTask({
      toolCallId: invocationId,
      toolName: toolCall.name,
      status: 'running',
      path,
    })
    if (linkedTaskId) {
      this.toolCallTaskMap.set(invocationId, linkedTaskId)
    }
    this.workExecution.startTool(toolCall, linkedTaskId || undefined, path)
    this.emitWorkExecution()
  }

  private updateTaskToolCallStatus(result: ToolResult): void {
    const { name: toolName } = result
    const toolCallId = toolInvocationKey(result.toolCallId, result.operationIdentity)
    const executionStatus = toolResultExecutionStatus(result)
    const status = executionStatus === 'failed' ? 'error' : executionStatus
    const safeResult = isBuiltInComputerTool(toolName)
      ? status === 'completed' ? COMPUTER_RESULT_REDACTED : COMPUTER_ERROR_REDACTED
      : result.output
    const taskId = this.toolCallTaskMap.get(toolCallId)
    if (result.data?.kind === 'command' && result.data.sessionId) {
      this.commandToolCallSessions.set(toolCallId, result.data.sessionId)
    }
    try {
      if (taskId) {
        this.taskManager.updateToolCallStatus(taskId, toolCallId, status, safeResult)
      } else {
        const activeCtx = this.taskManager.getActiveTaskContext()
        if (activeCtx) this.taskManager.updateToolCallStatus(activeCtx.taskId, toolCallId, status, safeResult)
      }
      if (result.data?.kind === 'command' && result.data.sessionId) {
        for (const [priorId, sessionId] of this.commandToolCallSessions) {
          if (priorId === toolCallId || sessionId !== result.data.sessionId) continue
          const priorTaskId = this.toolCallTaskMap.get(priorId)
          if (priorTaskId) this.taskManager.updateToolCallStatus(priorTaskId, priorId, status, safeResult)
        }
      }
    } finally {
      this.workExecution.finishTool({ ...result, output: safeResult })
      this.emitWorkExecution()
    }
  }

  private emitActiveTaskContext(): void {
    const ctx = this.taskManager.getActiveTaskContext()
    this.emit({ type: 'active:task', context: ctx })
    this.emitTaskSystem()
  }

  private emitWorkExecution(): void {
    this.emit({ type: 'work:execution', snapshot: this.workExecution.getSnapshot(this.taskManager) })
  }

  private async emitTerminalSessions(): Promise<void> {
    const result = await this.toolExecutor.ptyList?.()
    if (!result?.success) {
      this.emit({ type: 'terminal:sessions', sessions: [] })
      return
    }
    const rawSessions = (result.sessions || result.data || []) as TerminalSessionInfo[]
    const sessions = rawSessions.filter(s => s.isAgentSession || this.agentBackgroundSessions.has(s.id))
    this.emit({ type: 'terminal:sessions', sessions })
  }

  private async getTerminalSession(sessionId: string): Promise<TerminalSessionInfo | undefined> {
    const result = await this.toolExecutor.ptyList?.()
    if (!result?.success) return undefined
    const rawSessions = (result.sessions || result.data || []) as TerminalSessionInfo[]
    return rawSessions.find(s => s.id === sessionId)
  }

  private emitTaskSystem(creation?: TaskSystemCreationEvent | null): void {
    this.emit({
      type: 'task:system',
      context: this.taskManager.getActiveTaskContext(),
      tree: this.taskManager.getFullTree(),
      creation,
    })
  }

  private extractToolCallPath(toolCall: ToolCall): string | undefined {
    const args = toolCall.arguments
    return args.path as string | undefined
      || args.cwd as string | undefined
      || args.directory as string | undefined
      || args.file_path as string | undefined
  }

  private isWriteToolCall(toolCall: ToolCall): boolean {
    return this.resolveToolDefinition(toolCall.name)?.isReadOnly === false
  }

  private resolveToolDefinition(name: string): AgentTool | undefined {
    return getToolByName(name) || (this.mcpClient ? getMcpAgentTools(this.mcpClient).find(tool => tool.name === name) : undefined)
  }

  private isReadAfterWriteSensitiveToolCall(toolCall: ToolCall): boolean {
    return ['read_file', 'read_file_full', 'list_directory', 'search_files', 'search_content', 'web_search', 'web_fetch'].includes(toolCall.name)
  }

  private partitionToolCalls(toolCalls: ToolCall[]): ToolCallBatch[] {
    return this.toolExecutionCoordinator.partition(toolCalls)
  }

  private async executeSingleTool(toolCall: ToolCall, operationSignal = this.runControl.getOperationSignal()): Promise<ToolResult> {
    const result = this.boundToolResult(toolCall, await this.toolCallLifecycle.execute(toolCall, operationSignal))
    if (toolResultExecutionStatus(result) === 'completed') {
      this.recordSuccessfulToolUsage(toolCall.name, toolCall.arguments, result.output)
    }
    return result
  }

  private validateToolCall(toolCall: ToolCall, tool: AgentTool): ToolResult | undefined {
    const denied = this.permissions.getExplicitDeny(toolCall.name, toolCall.arguments)
    if (denied) return { toolCallId: toolCall.id, name: toolCall.name,
      output: `Error: Blocked by permission policy. ${denied.reason || 'Operation not permitted'}`, isError: true, errorKind: 'permission' }
    const workflowGuard = this.workflowBlockedToolMessage(toolCall)
    if (workflowGuard) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: workflowGuard,
        isError: true,
        errorKind: 'validation',
      }
    }

    if ((this.config.mode === 'plan' || this.config.capabilityProfile === 'read-only') && !tool.isReadOnly) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: plan mode is read-only; switch to vibe mode before using "${toolCall.name}".`,
        isError: true,
        errorKind: 'permission',
      }
    }

    if (this.config.allowedTools && !this.config.allowedTools.includes(toolCall.name)) {
      return { toolCallId: toolCall.id, name: toolCall.name, output: 'Error: tool is outside this child capability allowlist.', isError: true, errorKind: 'permission' }
    }
    if (this.disabledToolNames.has(toolCall.name)) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: tool "${toolCall.name}" is disabled for this request by the user's instruction.`,
        isError: true,
        errorKind: 'permission',
      }
    }

    if (tool.requiredMode && !tool.requiredMode.includes(this.config.mode)) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: tool "${toolCall.name}" is not available in ${this.config.mode} mode. Switch to ${tool.requiredMode.join(' or ')} mode.`,
        isError: true,
        errorKind: 'validation',
      }
    }

    // Validate tool arguments
    const validation = isMcpTool(toolCall.name) && tool.inputSchema
      ? validateMcpToolArgs(tool.inputSchema, toolCall.arguments)
      : validateToolArgs(toolCall.name, toolCall.arguments)
    if (!validation.valid) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: ${validation.error}`,
        isError: true,
        errorKind: 'validation',
      }
    }
  }

  private boundToolResult(toolCall: ToolCall, result: ToolResult): ToolResult {
    const { output, data } = result
    const configuredResultLimit = (this.resolveToolDefinition(toolCall.name) as EnhancedToolDef | undefined)?.maxResultSizeChars
    const maxResultChars = Number.isFinite(configuredResultLimit)
      ? Math.max(2_000, Number(configuredResultLimit))
      : DEFAULT_TOOL_RESULT_MAX_CHARS
    if (output.length <= maxResultChars) return result
    // Computer evidence has a stricter persistence policy. A generic reader
    // must not turn its ephemeral payload into an ordinary persisted result.
    const privateComputerOutput = isBuiltInComputerTool(toolCall.name)
    const storedSource = !privateComputerOutput ? this.toolOutputStore.save(output, toolCall, this.outputSourceScope()) : undefined
    const sourceNotice = storedSource
      ? ` Read the immutable original using read_tool_result(source_id="${storedSource.id}", offset=0); expiresAt=${storedSource.expiresAt}.`
      : privateComputerOutput ? ' Computer evidence is ephemeral and is not retained by the generic source reader. Observe the application again.'
      : ' No full output snapshot was retained within the source budget. Use a narrower query or the original file/log reader.'
    const truncationNotice = data?.kind === 'patch'
      ? `\n… <patch path listing truncated: ${output.length} chars total; full receipt retained in the tool result. Counts and status above are complete. Inspect files before preparing remaining changes; do not blindly retry this patch.${sourceNotice}>`
      : `\n… <output truncated: ${output.length} UTF-16 chars total; model result budget is ${maxResultChars} chars.${sourceNotice}>`
    let previewChars = Math.max(1, maxResultChars - truncationNotice.length)
    if (output.charCodeAt(previewChars - 1) >= 0xd800 && output.charCodeAt(previewChars - 1) <= 0xdbff
      && output.charCodeAt(previewChars) >= 0xdc00 && output.charCodeAt(previewChars) <= 0xdfff) previewChars -= 1
    if (storedSource) { storedSource.endOffset = previewChars; storedSource.nextOffset = previewChars }
    return { ...result, output: `${output.slice(0, previewChars)}${truncationNotice}`, ...(storedSource ? { outputSource: storedSource } : {}) }
  }

  private async dispatchValidatedTool(toolCall: ToolCall, _tool: AgentTool, operationSignal?: AbortSignal): Promise<ToolResult> {
    this.recordToolUsage(toolCall.name, toolCall.arguments)

    const executionArgs = toolCall.name === 'run_command'
      ? { ...toolCall.arguments, approved: true }
      : toolCall.arguments
    const dispatchResult = await this.dispatchTool(toolCall.name, executionArgs, toolCall.id, operationSignal)
    const output = typeof dispatchResult === 'string' ? dispatchResult : dispatchResult.output
    const attachments = typeof dispatchResult === 'string' ? undefined : dispatchResult.attachments
    const retrieval = typeof dispatchResult === 'string' ? undefined : dispatchResult.retrieval
    const data = typeof dispatchResult === 'string' ? undefined : dispatchResult.data

    const isOutputFailure = typeof dispatchResult === 'string' ? false : dispatchResult.isError
    const result: ToolResult = {
      toolCallId: toolCall.id,
      name: toolCall.name,
      output,
      isError: isOutputFailure,
      ...(retrieval ? { retrieval } : {}),
      ...(data ? { data } : {}),
      ...(attachments?.length ? { attachments: attachments.map(attachment => ({ ...attachment })) } : {}),
      ...(typeof dispatchResult !== 'string' && dispatchResult.outputSource ? { outputSource: dispatchResult.outputSource } : {}),
      ...(typeof dispatchResult === 'string' ? {} : {
        ...(dispatchResult.errorKind ? { errorKind: dispatchResult.errorKind } : {}),
        ...(dispatchResult.recovery ? { recovery: dispatchResult.recovery } : {}),
      }),
    }

    // Build change summary for file write/edit/delete operations.
    // Attach size-capped before/after snapshots so the UI can render
    // real unified diffs lazily (folded card = zero diff work).
    const workspacePath = this.stateProvider.getWorkspace()?.path || ''
    const resolvedPath = (toolCall.arguments.path as string)
      ? this.resolvePath(workspacePath, toolCall.arguments.path as string)
      : ''

    if (toolCall.name === 'write_file' && !isOutputFailure) {
      const content = (toolCall.arguments.content as string) || ''
      const lines = content.split('\n')
      const before = this.fileBeforeSnapshots.get(resolvedPath) ?? ''
      const after = content
      result.changeSummary = {
        path: (toolCall.arguments.path as string) || '',
        operation: 'write',
        totalLines: lines.length,
        preview: lines.slice(0, 20).join('\n'),
        ...this.buildDiffSnapshot(before, after),
      }
    }

    if (toolCall.name === 'replace_file' && !isOutputFailure) {
      const content = (toolCall.arguments.content as string) || ''
      const lines = content.split('\n')
      const before = this.fileBeforeSnapshots.get(resolvedPath) ?? ''
      const after = content
      result.changeSummary = {
        path: (toolCall.arguments.path as string) || '',
        operation: 'edit',
        totalLines: lines.length,
        preview: lines.slice(0, 20).join('\n'),
        ...this.buildDiffSnapshot(before, after),
      }
    }

    if (toolCall.name === 'edit_file' && !isOutputFailure) {
      const oldContent = (toolCall.arguments.old_content as string) || ''
      const newContent = (toolCall.arguments.new_content as string) || ''
      const oldLines = oldContent.split('\n').length
      const newLines = newContent.split('\n').length
      let totalLines = newLines
      let afterFileContent = ''
      let hasAfterSnapshot = false
      try {
        const editedPath = this.resolvePath(
          this.stateProvider.getWorkspace()?.path || '',
          (toolCall.arguments.path as string) || '',
        )
        const reread = await this.toolExecutor.readFile(editedPath)
        if (reread.success && typeof reread.data === 'string') {
          totalLines = reread.data.split('\n').length
          afterFileContent = reread.data
          hasAfterSnapshot = true
        }
      } catch {
      }
      const before = this.fileBeforeSnapshots.get(resolvedPath) ?? ''
      const after = afterFileContent
      result.changeSummary = {
        path: (toolCall.arguments.path as string) || '',
        operation: 'edit',
        totalLines,
        oldPreview: oldContent.split('\n').slice(0, 5).join('\n'),
        preview: newContent.split('\n').slice(0, 5).join('\n'),
        ...(hasAfterSnapshot
          ? this.buildDiffSnapshot(before, after)
          : { diffStatus: 'postimage-unavailable' as const, beforeBytes: before.length }),
      }
    }

    if (toolCall.name === 'multi_edit' && !isOutputFailure) {
      const before = this.fileBeforeSnapshots.get(resolvedPath) ?? ''
      let after = ''
      let hasAfterSnapshot = false
      try {
        const reread = await this.toolExecutor.readFile(resolvedPath)
        if (reread.success && typeof reread.data === 'string') {
          after = reread.data
          hasAfterSnapshot = true
        }
      } catch {
      }
      const afterLines = hasAfterSnapshot ? after.split('\n').length : undefined
      result.changeSummary = {
        path: (toolCall.arguments.path as string) || '',
        operation: 'edit',
        totalLines: afterLines,
        ...(hasAfterSnapshot
          ? this.buildDiffSnapshot(before, after)
          : { diffStatus: 'postimage-unavailable' as const, beforeBytes: before.length }),
      }
    }

    if (toolCall.name === 'delete_file' && !isOutputFailure) {
      const before = this.fileBeforeSnapshots.get(resolvedPath) ?? ''
      result.changeSummary = {
        path: (toolCall.arguments.path as string) || '',
        operation: 'delete',
        ...this.buildDiffSnapshot(before, ''),
      }
    }

    return result
  }

  private async checkToolPermission(toolCall: ToolCall, operationSignal = this.runControl.getOperationSignal()): Promise<ToolResult | null> {
    const context = { trustedHostTool: this.resolveToolDefinition(toolCall.name)?.access.source === 'host' }
    const computerApprovalLevel = context.trustedHostTool ? computerToolApprovalLevel(toolCall.name, toolCall.arguments) : null
    const permissionArgs = toolCall.name === 'run_command'
      ? { ...toolCall.arguments, approved: false }
      : toolCall.arguments
    const result = this.permissions.check(toolCall.name, permissionArgs, context)

    if (result.verdict === 'allow') return null

    if (result.verdict === 'deny') {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: Blocked by permission policy [${result.decisionId || 'unknown'}]. ${result.reason || 'Operation not permitted'}`,
        isError: true,
        errorKind: 'permission',
      }
    }

    const command = typeof toolCall.arguments.command === 'string'
      ? toolCall.arguments.command
      : undefined
    const semanticPermission = context.trustedHostTool ? describeSemanticToolPermission(toolCall.name, toolCall.arguments) : undefined
    const isComputerAction = context.trustedHostTool && isBuiltInComputerTool(toolCall.name)
    const response = await this.interactiveRequests.request({
      id: toolCall.id,
      kind: 'permission',
      event: {
        type: 'ask:user',
        requestId: toolCall.id,
        toolName: toolCall.name,
        path: this.extractToolCallPath(toolCall),
        question: semanticPermission?.question || (command
          ? `允许执行这个命令吗？`
          : `允许执行 ${toolCall.name} 吗？`),
        options: isComputerAction || computerApprovalLevel === 'always'
          ? ['allow-once', 'deny']
          : ['allow-once', 'allow-run', 'allow-session', 'deny'],
        reason: semanticPermission?.reason || result.reason || 'Operation requires approval',
        command,
      },
    }, { signal: operationSignal, cancelDecision: 'deny' })
    if (this.runControl.getSnapshot().paused) await this.runControl.waitIfPaused()
    if (this.runControl.getRunSignal()?.aborted) throw this.runControl.createStopInterruption()
    const decision = this.parsePermissionDecision(response)
    if (isComputerAction && decision !== 'allow-once' && decision !== 'deny') {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: 'Error: Computer actions can only be approved for this single action.',
        isError: true,
        errorKind: 'permission',
      }
    }
    if (decision === 'deny') {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error: User denied permission. ${result.reason || 'Operation requires approval'}`,
        isError: true,
        errorKind: 'permission',
      }
    }

    if (decision === 'allow-run') {
      this.permissions.grantRun(toolCall.name, toolCall.arguments, context)
    } else if (decision === 'allow-session') {
      this.permissions.grantSession(toolCall.name, toolCall.arguments, context)
    }

    if (this.interactiveRequests.getSnapshot().pendingCount === 0) {
      const semanticActivity = describeSemanticToolActivity(toolCall.name, toolCall.arguments, 'running')
      this.setRunState('tool_running', {
        detail: semanticActivity?.detail || `Running ${toolCall.name}`,
        activeTool: toolCall.name,
      })
    }

    return null
  }

  private parsePermissionDecision(response: string): 'allow-once' | 'allow-run' | 'allow-session' | 'deny' {
    const normalized = response.trim().toLowerCase()
    if (['allow-run', 'run', 'this-run', '本轮允许', '本次任务允许', '2'].includes(normalized)) {
      return 'allow-run'
    }
    if (['allow-session', 'always', 'all', 'a', 'session', '一直允许', '本次会话允许'].includes(normalized)) {
      return 'allow-session'
    }
    if (['deny', 'no', 'n', 'false', '拒绝', '不允许', '否'].includes(normalized)) {
      return 'deny'
    }
    if (['allow-once', 'yes', 'y', '1', 'once', '本次允许'].includes(normalized)) return 'allow-once'
    return 'deny'
  }

  private outputSourceScope(): string {
    return JSON.stringify([this.session.id, this.stateProvider.getWorkspace()?.path ?? this.config.workspacePath])
  }

  private async dispatchTool(name: string, args: Record<string, unknown>, toolCallId: string, operationSignal = this.runControl.getOperationSignal()): Promise<ToolDispatchOutput> {
    if (this.orchestration.handles(name)) return this.orchestration.dispatchTool(name, args, operationSignal)
    const workspace = this.stateProvider.getWorkspace()
    const basePath = workspace?.path || ''

    const taskResult = dispatchTaskTool(name, args, {
      taskManager: this.taskManager,
      emitTaskSystem: creation => this.emitTaskSystem(creation),
      emitActiveTask: () => this.emit({ type: 'active:task', context: this.taskManager.getActiveTaskContext() }),
    })
    if (taskResult !== undefined) return taskResult

    switch (name) {
      case 'read_tool_result': {
        try {
          const page = this.toolOutputStore.read(String(args.source_id), Number(args.offset ?? 0), Number(args.limit ?? 12_000), this.outputSourceScope(), sourceCall => {
            const sourceTool = this.resolveToolDefinition(sourceCall.name)
            if (!sourceTool) throw new ToolOutputReadError('permission', 'The source tool is no longer available')
            const denied = this.validateToolCall(sourceCall, sourceTool)
            if (denied) throw new ToolOutputReadError(denied.errorKind ?? 'permission', denied.output)
          })
          return { ...page, isError: false }
        } catch (error) {
          if (error instanceof ToolOutputReadError) return toolFailure(error.message, error.errorKind, 'none')
          throw error
        }
      }
      case 'read_file':
      case 'read_file_full': {
        const filePath = this.resolvePath(basePath, args.path as string)
        const isFullRead = name === 'read_file_full'
        if (!isFullRead && args.byte_offset != null) {
          if (!this.toolExecutor.readFileBytes) return toolFailure('This executor does not support bounded byte reads', 'environment', 'none')
          const result = await this.toolExecutor.readFileBytes(filePath, {
            offset: Number(args.byte_offset), maxBytes: Number(args.byte_limit ?? 16 * 1024),
            ...(args.source_version != null ? { version: String(args.source_version) } : {}), signal: operationSignal,
          })
          if (!result.success || !result.data) return toolFailure(result.error || 'Unable to read byte range', result.errorKind ?? 'environment', 'none')
          const { content, ...byteRange } = result.data
          const scope = this.toWorkspaceRelative(basePath, filePath)
          const retrieval: RetrievalResult = { operation: 'read_file', scope,
            resources: [{ path: scope, kind: 'file', state: 'read', preview: content }],
            totalIsExact: true, truncated: byteRange.nextOffset !== undefined, byteRange }
          return { isError: false, retrieval, output: `[UTF-8 bytes ${byteRange.offset}..${byteRange.endOffset} of ${byteRange.totalBytes}; end exclusive; source_version=${byteRange.version}${byteRange.nextOffset === undefined ? '; end of source' : `; continue read_file byte_offset=${byteRange.nextOffset} with the same source_version`}]\n${content}` }
        }
        const offset = isFullRead ? 1 : args.offset as number | undefined
        const requestedLimit = isFullRead ? undefined : args.limit as number | undefined
        const limit = Math.max(1, Math.min(MODEL_READ_MAX_LINES, Math.floor(requestedLimit ?? (isFullRead ? MODEL_READ_MAX_LINES : DEFAULT_MODEL_READ_LINES))))
        const maxBytes = isFullRead ? MODEL_READ_FULL_MAX_BYTES : MODEL_READ_MAX_BYTES
        // with_line_numbers defaults true: cat -n style output makes
        // edit_file / multi_edit far more reliable because the model can
        // see exact line positions when planning targeted edits.
        const withLineNumbers = isFullRead
          ? args.with_line_numbers === true
          : args.with_line_numbers !== false

        const startLine = offset || 1
        const start = Math.max(0, startLine - 1)
        let slice: string[]
        let truncated = false
        let partialLine = false
        let totalLines: number | undefined
        if (this.toolExecutor.readFileRange) {
          const result = await this.toolExecutor.readFileRange(filePath, start, limit, maxBytes)
          if (!result.success) {
            const relPath = this.toWorkspaceRelative(basePath, filePath)
            throw new Error(`${result.error || 'Unable to read file'} — resolved path: ${relPath}. Use search_files or list_directory to verify the correct path.`)
          }
          const rangeContent = result.data?.content ?? ''
          slice = rangeContent ? rangeContent.split('\n') : []
          truncated = result.data?.truncated === true
          partialLine = result.data?.partialLine === true
        } else {
          const result = await this.toolExecutor.readFile(filePath)
          if (!result.success) {
            const relPath = this.toWorkspaceRelative(basePath, filePath)
            throw new Error(`${result.error || 'Unable to read file'} — resolved path: ${relPath}. Use search_files or list_directory to verify the correct path.`)
          }
          const allLines = (result.data ?? '').split('\n')
          totalLines = allLines.length
          const selectedLines = allLines.slice(start, start + limit)
          slice = []
          let bytes = 0
          for (const line of selectedLines) {
            const remaining = maxBytes - bytes
            if (remaining <= 0) {
              truncated = true
              break
            }
            const buffer = Buffer.from(line, 'utf8')
            if (buffer.length > remaining && slice.length > 0) {
              truncated = true
              break
            }
            const bounded = buffer.length > remaining
              ? buffer.subarray(0, remaining).toString('utf8').replace(/�$/, '')
              : line
            bytes += Buffer.byteLength(bounded, 'utf8') + 1
            slice.push(bounded)
            if (buffer.length > remaining) {
              truncated = true
              partialLine = true
              break
            }
          }
          truncated ||= start + slice.length < totalLines
        }
        const returnedLines = slice.length

        // Render with line numbers in cat -n format
        const formatLine = (lineText: string, idx: number) =>
          `${String(start + idx + 1).padStart(6, ' ')}→${lineText}`
        const content = withLineNumbers
          ? slice.map(formatLine).join('\n')
          : slice.join('\n')

        const retrieval: RetrievalResult = {
          operation: 'read_file', scope: this.toWorkspaceRelative(basePath, filePath),
          resources: [{ path: this.toWorkspaceRelative(basePath, filePath), kind: 'file', state: 'read',
            ...(returnedLines > 0 ? { line: startLine, endLine: startLine + returnedLines - 1 } : {}),
            preview: slice.join('\n'), textTruncated: partialLine }],
          totalIsExact: !truncated, truncated,
          ...(!partialLine && truncated ? { nextOffset: startLine + returnedLines } : {}),
          ...(partialLine ? { warning: 'The returned line is only a preview; restart with read_file byte_offset=0, then use returned byte offsets and source_version.' } : {}),
        }

        // Moderate files should fit in one model round. Very large files retain
        // an explicit continuation hint so callers can jump to a searched range.
        if (truncated) {
          if (partialLine) {
            return { isError: false, retrieval, output: `[line ${startLine} exceeds the ${Math.floor(maxBytes / 1024)} KiB model read budget; showing a bounded preview only. Restart raw text reading with read_file byte_offset=0, then use returned byte offsets and source_version. Do not use line offsets to continue inside a line.]\n${content}` }
          }
          const nextOffset = startLine + returnedLines
          const knownTotal = totalLines ? ` of ${totalLines}` : ''
          return { isError: false, retrieval, output: `[lines ${startLine}-${startLine - 1 + returnedLines}${knownTotal}; bounded to ${limit} lines / ${Math.floor(maxBytes / 1024)} KiB; call read_file with offset=${nextOffset}, limit=${Math.min(limit, 400)} to continue, or search for a precise range]\n${content}` }
        }
        return { isError: false, retrieval, output: content }
      }

      case 'write_file': {
        const filePath = this.resolvePath(basePath, args.path as string)
        await this.captureBeforeSnapshot(filePath)
        const result = await this.toolExecutor.writeFile(filePath, args.content as string, {
          source: 'ai',
          label: 'AI write_file',
        })
        return fileMutationOutput(result, `File written: ${args.path}`)
      }

      case 'replace_file': {
        const filePath = this.resolvePath(basePath, args.path as string)
        const existing = await this.toolExecutor.readFile(filePath)
        if (!existing.success) {
          return toolFailure(`Error: replace_file requires an existing file - ${existing.error || 'file not found'}`, 'validation', 'none')
        }
        await this.captureBeforeSnapshot(filePath)
        const result = await this.toolExecutor.writeFile(filePath, args.content as string, {
          source: 'ai',
          label: 'AI replace_file',
          expectedHash: hashText(existing.data || ''),
        })
        return fileMutationOutput(result, `File replaced: ${args.path}`)
      }

      case 'edit_file': {
        const filePath = this.resolvePath(basePath, args.path as string)
        await this.captureBeforeSnapshot(filePath)
        const readResult = await this.toolExecutor.readFile(filePath)
        if (!readResult.success) return toolFailure(`Error: unable to read file - ${readResult.error}`, 'execution', 'none')

        let content = readResult.data!
        const oldContent = stripLineNumberPrefix(args.old_content as string)
        const newContent = stripLineNumberPrefix(args.new_content as string)
        const replaceAll = args.replace_all === true

        const editResult = applyEdit(content, oldContent, newContent, replaceAll, args.path as string)
        if ('error' in editResult) return toolFailure(`Error: ${editResult.error}`, 'validation', 'none')
        content = editResult.content

        const writeResult = await this.toolExecutor.writeFile(filePath, content, {
          source: 'ai',
          label: 'AI edit_file',
          expectedHash: hashText(readResult.data || ''),
        })
        return fileMutationOutput(writeResult, `File edited: ${args.path}${replaceAll ? ` (${editResult.replacements} replacements)` : ''}`)
      }

      case 'multi_edit': {
        const filePath = this.resolvePath(basePath, args.path as string)
        const rawEdits = args.edits
        if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
          return toolFailure(`Error: edits must be a non-empty array`, 'validation', 'none')
        }
        await this.captureBeforeSnapshot(filePath)
        const readResult = await this.toolExecutor.readFile(filePath)
        if (!readResult.success) return toolFailure(`Error: unable to read file - ${readResult.error}`, 'execution', 'none')

        let content = readResult.data!
        const summary: string[] = []
        for (let i = 0; i < rawEdits.length; i += 1) {
          const edit = rawEdits[i] as Record<string, unknown>
          if (!edit || typeof edit !== 'object') {
            return toolFailure(`Error: edit #${i + 1} is not an object`, 'validation', 'none')
          }
          if (typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') {
            return toolFailure(`Error: edit #${i + 1} requires string old_string and new_string`, 'validation', 'none')
          }
          const oldContent = stripLineNumberPrefix(edit.old_string)
          const newContent = stripLineNumberPrefix(edit.new_string)
          const replaceAll = edit.replace_all === true
          const stepResult = applyEdit(content, oldContent, newContent, replaceAll, `${args.path} (edit #${i + 1})`)
          if ('error' in stepResult) {
            return toolFailure(`Error: ${stepResult.error}. No edits applied (multi_edit is atomic).`, 'validation', 'none')
          }
          content = stepResult.content
          summary.push(`#${i + 1}${replaceAll ? ` ×${stepResult.replacements}` : ''}`)
        }

        const writeResult = await this.toolExecutor.writeFile(filePath, content, {
          source: 'ai',
          label: 'AI multi_edit',
          expectedHash: hashText(readResult.data || ''),
        })
        return fileMutationOutput(writeResult, `File edited: ${args.path} (${rawEdits.length} edits applied: ${summary.join(', ')})`)
      }

      case 'apply_patch':
        return executePatch(args.patch as string, basePath, this.toolExecutor, path => this.captureBeforeSnapshot(path), operationSignal)

      case 'list_directory': {
        const dirPath = this.resolvePath(basePath, args.path as string)
        const result = await this.toolExecutor.listTree(dirPath, { maxDepth: args.recursive ? 3 : 1, maxEntriesPerDirectory: 100, maxNodes: 300 })
        if (!result.success) return toolFailure(`Error: ${result.error}`, 'execution', 'none')

        const formatTree = (node: TreeNode, depth = 0): string => {
          const indent = '  '.repeat(depth)
          const lines = [`${indent}[${node.type === 'file' ? 'FILE' : 'DIR'}] ${node.name}`]
          if (node.children && (args.recursive || depth === 0)) {
            for (const child of node.children) {
              lines.push(formatTree(child, depth + 1))
            }
          }
          return lines.join('\n')
        }

        const resources: RetrievedResource[] = []
        const collect = (node: TreeNode, path: string): void => {
          for (const child of node.children || []) {
            const childPath = this.resolvePath(path, child.name)
            resources.push({ path: this.toWorkspaceRelative(basePath, childPath), kind: child.type === 'file' ? 'file' : 'directory', state: 'found' })
            if (args.recursive) collect(child, childPath)
          }
        }
        if (result.data) collect(result.data, dirPath)
        const retrieval: RetrievalResult = {
          operation: 'list_directory', scope: this.toWorkspaceRelative(basePath, dirPath) || '.', resources,
          totalIsExact: !result.data?.truncated, truncated: result.data?.truncated === true,
        }
        return { isError: false, retrieval, output: `${result.data ? formatTree(result.data) : 'Empty directory'}${retrieval.truncated ? '\nListing is bounded; inspect a specific subdirectory for remaining entries.' : ''}` }
      }

      case 'search_files': {
        const dirPath = args.path ? this.resolvePath(basePath, args.path as string) : basePath
        const result = await this.toolExecutor.searchFiles(args.pattern as string, dirPath, {
          cursor: (args.cursor ?? undefined) as string | undefined, offset: (args.offset ?? undefined) as number | undefined, limit: (args.head_limit ?? undefined) as number | undefined,
          includeIgnored: args.include_ignored === true, signal: operationSignal,
        })
        if (!result.success) return toolFailure(`Error: ${result.error}`, result.errorKind ?? 'execution', 'none')
        const retrieval = fileSearchResult(result.data || { matches: [] }, this.toWorkspaceRelative(basePath, dirPath) || '.', String(args.pattern), path => this.toWorkspaceRelative(basePath, path))
        return { isError: false, retrieval, output: formatRetrievalResult(retrieval) }
      }

      case 'code_navigation': {
        if (!this.toolExecutor.navigateCode) return toolFailure('Semantic navigation is not available in this executor; use search_content for text evidence', 'environment', 'none')
        const response = await this.toolExecutor.navigateCode({ operation: args.operation as 'definition' | 'references' | 'diagnostics',
          path: this.resolvePath(basePath, args.path as string),
          line: (args.line ?? undefined) as number | undefined, column: (args.column ?? undefined) as number | undefined,
          projectPath: args.project_path ? this.resolvePath(basePath, args.project_path as string) : undefined,
          sourceVersion: (args.source_version ?? undefined) as string | undefined, projectVersion: (args.project_version ?? undefined) as string | undefined,
          offset: (args.offset ?? undefined) as number | undefined, limit: (args.limit ?? undefined) as number | undefined, signal: operationSignal })
        if (!response.success || !response.data) return toolFailure(response.error ?? 'Navigation returned no result', response.errorKind ?? 'environment', 'none')
        const retrieval = codeNavigationResult(response.data, path => this.toWorkspaceRelative(response.data!.workspaceRoot, path))
        return { isError: false, retrieval, output: formatCodeNavigation(retrieval) }
      }

      case 'search_content': {
        if (args.cursor && !this.toolExecutor.searchContentPage) return toolFailure('Search cursor continuation is not supported by this executor', 'environment', 'none')
        const dirPath = args.path ? this.resolvePath(basePath, args.path as string) : basePath
        const filePattern = (args.file_pattern || args.glob) as string | undefined
        // Default to case-insensitive (grep -i ergonomics). Models can opt back
        // into case sensitivity when needed.
        const caseSensitive = args.case_sensitive === true
        const result = this.toolExecutor.searchContentPage
          ? await this.toolExecutor.searchContentPage(args.pattern as string, dirPath, filePattern, !caseSensitive, {
              cursor: (args.cursor ?? undefined) as string | undefined, offset: (args.offset ?? undefined) as number | undefined,
              limit: (args.head_limit ?? undefined) as number | undefined,
              contextBefore: (args.context_before ?? undefined) as number | undefined,
              contextAfter: (args.context_after ?? undefined) as number | undefined,
              multiline: args.multiline === true,
              fileType: (args.file_type ?? undefined) as string | undefined,
              fixedStrings: args.fixed_strings === true,
              includeIgnored: args.include_ignored === true,
              outputMode: (args.output_mode ?? undefined) as 'content' | 'files' | 'count' | undefined,
              signal: operationSignal,
            })
          : await this.toolExecutor.searchContent(args.pattern as string, dirPath, filePattern, !caseSensitive)
        if (!result.success) return toolFailure(`Error: ${result.error}`, result.errorKind ?? 'execution', 'none')
        const page = this.toolExecutor.searchContentPage
          ? result.data as import('@fluxos/contracts/toolExecutor').SearchContentPage
          : { hits: Array.isArray(result.data) ? result.data : [], truncated: false, offset: 0, limit: 50, totalMatches: Array.isArray(result.data) ? result.data.length : 0 }
        const retrieval = contentSearchResult(page, this.toWorkspaceRelative(basePath, dirPath) || '.', String(args.pattern), path => this.toWorkspaceRelative(basePath, path))
        return { isError: false, retrieval, output: formatRetrievalResult(retrieval) }
      }


      case 'web_search': {
        if (typeof this.toolExecutor.webSearch !== 'function') {
          return toolFailure('Error: web_search is not available in this runtime', 'environment', 'none')
        }
        const query = String(args.query || '').trim()
        if (!query) return toolFailure('Error: query is required', 'validation', 'none')
        const response = await this.toolExecutor.webSearch({
          query,
          additional_queries: args.additional_queries,
          limit: args.limit,
          region: args.region,
          freshness: args.freshness,
          domains: args.domains,
          exclude_domains: args.exclude_domains,
          depth: args.depth,
        })
        if (!response.success) return toolFailure(`Error: ${response.error || 'web search failed'}`, 'execution', 'none')
        const data = response.data
        if (!data) return toolFailure(`Error: web search returned no data`, 'execution', 'none')
        return { isError: false, output: this.formatWebSearchResults(data), data: { kind: 'web_search', response: data } }
      }

      case 'read_web_source': {
        if (!this.toolExecutor.readWebSource) return toolFailure('Error: saved webpage access is unavailable', 'environment', 'none')
        const result = await this.toolExecutor.readWebSource({ source_id: String(args.source_id), offset: args.offset as number | undefined, limit: args.limit as number | undefined, query: args.query as string | undefined })
        return result.success ? JSON.stringify(result.data) : toolFailure('Error: ' + result.error, 'execution', 'none')
      }
      case 'web_fetch': {
        if (typeof this.toolExecutor.webFetch !== 'function') {
          return toolFailure('Error: web_fetch is not available in this runtime', 'environment', 'none')
        }
        const urls = Array.isArray(args.urls) ? args.urls.map(String).filter(Boolean) : []
        if (urls.length === 0) return toolFailure('Error: urls is required', 'validation', 'none')
        const response = await this.toolExecutor.webFetch({ urls, max_chars: args.max_chars, signal: this.runControl.getOperationSignal() })
        if (!response.success) return toolFailure(`Error: ${response.error || 'web page fetch failed'}`, 'execution', 'none')
        if (!response.data) return toolFailure('Error: web page fetch returned no data', 'execution', 'none')
        return { isError: false, output: this.formatWebFetchResults(response.data), data: { kind: 'web_fetch', response: response.data } }
      }

      case 'tool_search': {
        if (!this.mcpClient) return 'No MCP tools are connected.'
        const query = String(args.query || '').trim()
        if (!query) return toolFailure('Error: query is required', 'validation', 'none')
        const limit = typeof args.limit === 'number' ? args.limit : 8
        const allowedNames = new Set(this.availableMcpTools().map(tool => tool.name))
        const matches = this.mcpClient.searchTools(query, limit, { allowedNames }).filter(tool => allowedNames.has(tool.name))
        for (const match of matches) this.loadedMcpToolNames.add(match.name)
        const data: ToolResultData = { kind: 'items', items: matches.map(tool => ({ title: tool.name, description: tool.description, path: tool.serverName })) }
        if (matches.length === 0) return { isError: false, data, output: `No connected tool metadata matched ${JSON.stringify(query)}. Try the provider's tool name, terminology, or an English translation. Do not assume unrelated tools are relevant.` }
        return { isError: false, data, output: JSON.stringify({
          matching: 'lexical_with_curated_aliases',
          guidance: 'Metadata matches are candidates, not semantic confidence or authorization. Verify the description and schema before calling; use provider terminology to refine weak matches.',
          tools: matches.map(tool => ({
            name: tool.name,
            server: tool.serverName,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }) }
      }

      case 'list_memories': {
        if (!basePath) return toolFailure('Error: no workspace selected', 'environment', 'none')
        const limit = typeof args.limit === 'number' ? args.limit : undefined
        const response = await this.toolExecutor.memoryQuery({
          workspacePath: basePath,
          query: typeof args.query === 'string' ? args.query : undefined,
          kind: typeof args.kind === 'string'
            ? (args.kind as MemoryKind)
            : undefined,
          scope: typeof args.scope === 'string'
            ? (args.scope as MemoryScope)
            : undefined,
          limit,
        })
        if (!response.success) return toolFailure(`Error: ${response.error || 'memory query failed'}`, 'execution', 'none')
        const items = response.data?.items || []
        if (items.length === 0) return { isError: false, output: 'No memories matched the filter.', data: { kind: 'items', items: [] } }
        const lines = items.map((item: { id: string; kind: string; confidence: string | number; text: string; source: string; tags?: string[] }) => {
          const tagBits = item.tags?.length ? ` [${item.tags.slice(0, 3).join(', ')}]` : ''
          return `- ${item.id} (${item.kind}, ${item.confidence}) ${item.text}\n  source: ${item.source}${tagBits}`
        })
        return { isError: false, output: `Found ${items.length} memor${items.length === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}`, data: { kind: 'items', items: items.map((item: { text: string; source: string }) => ({ title: item.text, path: item.source })) } }
      }

      case 'remember': {
        if (!basePath) return toolFailure('Error: no workspace selected', 'environment', 'none')
        const text = args.text as string
        if (!text || typeof text !== 'string') return toolFailure('Error: text parameter is required', 'validation', 'none')
        // Handle tags: accept array or comma-separated string
        let tags: string[] | undefined
        if (Array.isArray(args.tags)) {
          tags = args.tags.filter((t: unknown) => typeof t === 'string')
        } else if (typeof args.tags === 'string') {
          tags = args.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        }
        const result = await this.toolExecutor.memoryRemember({
          workspacePath: basePath,
          text,
          kind: typeof args.kind === 'string' ? args.kind : undefined,
          tags,
          confidence: typeof args.confidence === 'string' ? args.confidence : undefined,
          conversationId: this.config.conversationId || this.stateProvider.getConversationId() || undefined,
        })
        if (!result.success) return toolFailure(`Error: ${result.error || 'remember failed'}`, 'execution', 'unknown')
        if (result.data?.deduplicated) return `Memory updated (deduplicated with existing entry): ${result.data.id}`
        return `Memory stored: ${result.data?.id}`
      }

      case 'forget': {
        if (!basePath) return toolFailure('Error: no workspace selected', 'environment', 'none')
        const id = args.id as string
        if (!id || typeof id !== 'string') return toolFailure('Error: id parameter is required', 'validation', 'none')
        const reason = typeof args.reason === 'string' ? args.reason : undefined
        const result = await this.toolExecutor.memoryForget({
          workspacePath: basePath,
          id,
          reason,
        })
        if (!result.success) return toolFailure(`Error: ${result.error || 'forget failed'}`, 'execution', 'unknown')
        return `Memory forgotten: ${id}`
      }

      case 'git_status': {
        if (!basePath) return toolFailure('Error: no workspace selected', 'environment', 'none')
        const ready = await this.initializeGit(true)
        if (!ready || !this.gitState.snapshot) {
          return toolFailure(`Error: ${this.gitState.error || 'workspace is not a readable Git repository'}`, 'environment', 'none')
        }
        return { isError: false, output: formatGitSnapshotForTool(this.gitState.snapshot), data: { kind: 'repository', snapshot: structuredClone(this.gitState.snapshot) } }
      }

      case 'git_diff': {
        if (!basePath) return toolFailure('Error: no workspace selected', 'environment', 'none')
        const result = await fetchGitDiff(
          basePath,
          this.toolExecutor,
          (args.scope as GitDiffScope | undefined) || 'working',
          args.path as string | undefined,
          args.context_lines as number | undefined,
        )
        return result.ok ? result.output || 'No tracked changes.' : toolFailure(`Error: ${result.error}`, 'execution', 'none')
      }

      case 'git_log': {
        if (!basePath) return toolFailure('Error: no workspace selected', 'environment', 'none')
        const result = await fetchGitLog(basePath, this.toolExecutor, args.limit as number | undefined, args.path as string | undefined)
        return result.ok ? result.output || 'No commits found.' : toolFailure(`Error: ${result.error}`, 'execution', 'none')
      }

      case 'git_show': {
        if (!basePath) return toolFailure('Error: no workspace selected', 'environment', 'none')
        const result = await fetchGitShow(basePath, this.toolExecutor, args.revision as string, args.path as string | undefined)
        return result.ok ? result.output || 'No output.' : toolFailure(`Error: ${result.error}`, 'execution', 'none')
      }

      case 'git_stage': {
        if (!basePath) return toolFailure('Error: no workspace selected', 'environment', 'none')
        const result = await this.runGitOperation('stage', () => gitStagePaths(basePath, args.paths as string[], this.toolExecutor))
        return result.ok ? result.output || 'Paths staged.' : toolFailure(`Error: ${result.error}`, 'execution', 'unknown')
      }

      case 'git_commit': {
        if (!basePath) return toolFailure('Error: no workspace selected', 'environment', 'none')
        const result = await this.runGitOperation('commit', () => gitCommit(basePath, args.message as string, this.toolExecutor, args.paths as string[] | undefined))
        if (!result.ok) return toolFailure(`Error: ${result.error}`, 'execution', 'unknown')
        if (result.nothingToCommit) return 'Nothing to commit.'
        return `${result.hash ? `Commit ${result.hash}` : 'Commit created'}${result.output ? `\n${result.output}` : ''}`
      }

      case 'git_create_branch': {
        if (!basePath) return toolFailure('Error: no workspace selected', 'environment', 'none')
        const result = await this.runGitOperation('create-branch', () => gitCreateBranch(basePath, args.name as string, this.toolExecutor, args.start_point as string | undefined))
        return result.ok ? result.output || 'Branch created.' : toolFailure(`Error: ${result.error}`, 'execution', 'unknown')
      }

      case 'git_switch_branch': {
        if (!basePath) return toolFailure('Error: no workspace selected', 'environment', 'none')
        const result = await this.runGitOperation('switch-branch', () => gitSwitchBranch(basePath, args.name as string, this.toolExecutor))
        return result.ok ? result.output || 'Branch switched.' : toolFailure(`Error: ${result.error}`, 'execution', 'unknown')
      }

      case 'git_stash': {
        if (!basePath) return toolFailure('Error: no workspace selected', 'environment', 'none')
        const action = args.action as 'list' | 'push' | 'apply' | 'pop'
        const operation = () => gitStash(basePath, action, this.toolExecutor, {
          message: args.message as string | undefined,
          includeUntracked: args.include_untracked === true,
          stash: args.stash as string | undefined,
        })
        const result = action === 'list' ? await operation() : await this.runGitOperation(`stash-${action}`, operation)
        return result.ok ? result.output || 'Stash operation completed.' : toolFailure(`Error: ${result.error}`, 'execution', 'unknown')
      }

      case 'git_push': {
        if (!basePath) return toolFailure('Error: no workspace selected', 'environment', 'none')
        const result = await this.runGitOperation('push', () => gitPush(basePath, this.toolExecutor, {
          remote: args.remote as string | undefined,
          branch: args.branch as string | undefined,
          setUpstream: args.set_upstream === true,
        }))
        return result.ok ? result.output || 'Push completed.' : toolFailure(`Error: ${result.error}`, 'execution', 'unknown')
      }

      case 'git_restore': {
        if (!basePath) return toolFailure('Error: no workspace selected', 'environment', 'none')
        const result = await this.runGitOperation('restore', () => gitRestorePaths(
          basePath,
          args.paths as string[],
          this.toolExecutor,
          args.source as string | undefined,
        ))
        return result.ok ? result.output || 'Paths restored.' : toolFailure(`Error: ${result.error}`, 'execution', 'unknown')
      }

      case 'git_revert': {
        if (!basePath) return toolFailure('Error: no workspace selected', 'environment', 'none')
        const result = await this.runGitOperation('revert', () => gitRevertCommit(basePath, args.revision as string, this.toolExecutor))
        if (!result.ok) return toolFailure(`Error: ${result.error}`, 'execution', 'unknown')
        return `${result.hash ? `Revert commit ${result.hash}` : 'Revert commit created'}${result.output ? `\n${result.output}` : ''}`
      }

      case 'run_command': {
        const expectedExitCodes = Array.isArray(args.expected_exit_codes) ? args.expected_exit_codes as number[] : [0]
        const cwd = args.cwd ? this.resolvePath(basePath, args.cwd as string) : basePath
        const env = args.env == null ? undefined : Object.fromEntries(
          (args.env as Array<{ name: string; value: string }>).map(entry => [entry.name, entry.value]),
        )
        const timeout = args.timeout as number | undefined
        const approved = args.approved === true
        const runInBackground = args.run_in_background === true
        const foregroundCommand = args.command as string
        const commandFailure = (output: string, errorKind: NonNullable<ToolResult['errorKind']> = 'execution'): ToolDispatchResult => ({
          ...toolFailure(output, errorKind, errorKind === 'validation' ? 'none' : 'unknown'),
          data: { kind: 'command', command: foregroundCommand, cwd, stdout: '', process: { state: 'execution_failed' }, expectedExitCodes },
        })
        const foregroundWasExplicit = Object.prototype.hasOwnProperty.call(args, 'run_in_background')
          && args.run_in_background === false
        const autoBackground = !runInBackground
          && !foregroundWasExplicit
          && shouldAutoBackgroundCommand(foregroundCommand)
        const useBackground = runInBackground || autoBackground
        const displayTitle = typeof args.display_title === 'string' ? args.display_title.trim() : ''
        const displayDetail = typeof args.display_detail === 'string' ? args.display_detail.trim() : undefined
        const previewUrl = typeof args.preview_url === 'string' ? normalizeLocalPreviewUrl(args.preview_url) : undefined
        if (args.preview_url && !previewUrl) {
          return commandFailure('Error: preview_url must be an http(s) localhost URL.', 'validation')
        }
        const displayKind = (args.display_kind as RuntimeTaskPresentationKind | undefined) || (previewUrl ? 'service' : 'work')
        const defaultTitles: Record<RuntimeTaskPresentationKind, string> = {
          work: '执行工作步骤', install: '安装项目依赖', build: '构建项目', check: '检查执行结果', service: '运行本地服务', export: '导出工作结果',
        }
        const presentation: RuntimeTaskPresentation = {
          kind: displayKind,
          title: displayTitle || defaultTitles[displayKind],
          detail: displayDetail,
          previewUrl,
        }

        if (useBackground) {
          const command = foregroundCommand
          const validation = await this.toolExecutor.validateCommand?.(command, cwd)
          if (validation && !validation.success) {
            return { ...commandFailure(`Error: ${validation.error || 'command validation failed'}`, validation.errorKind ?? 'validation'),
              recovery: validation.recovery ?? toolRecovery(validation.errorKind ?? 'validation', 'none') }
          }

          const directResult = this.toolExecutor.startBackgroundCommand
            ? await this.toolExecutor.startBackgroundCommand(command, cwd, env, approved, presentation, expectedExitCodes, operationSignal)
            : undefined
          const ptyResult = directResult || await this.toolExecutor.ptyCreate?.({ cwd, env, presentation, expectedExitCodes, signal: operationSignal })
          const sessionId = ptyResult?.data?.sessionId
          if (!sessionId) {
            return { ...commandFailure(`Error: failed to spawn agent terminal${ptyResult?.error ? ` — ${ptyResult.error}` : ''}`, ptyResult?.errorKind ?? 'execution'),
              ...(ptyResult?.recovery ? { recovery: ptyResult.recovery } : {}) }
          }
          const terminalLogPath = ptyResult.data?.session?.logPath
          if (!directResult) {
            if (operationSignal?.aborted) {
              await this.toolExecutor.ptyKill?.(sessionId)
              return { ...commandFailure('Background launch cancelled before stdin dispatch', 'abort'), recovery: toolRecovery('abort', 'unknown') }
            }
            const writeResult = await this.toolExecutor.ptyWrite?.(sessionId, `${command}\n`)
            if (!writeResult?.success) {
              await this.toolExecutor.ptyKill?.(sessionId)
              await this.emitTerminalSessions()
              return commandFailure(`Error: failed to start background command — ${writeResult?.error || 'unknown error'}`)
            }
          }
          this.agentBackgroundSessions.set(sessionId, { command, startedAt: Date.now(), expectedExitCodes: [...expectedExitCodes] })
          await this.emitTerminalSessions()
          const prefix = autoBackground
            ? 'Long-running command automatically moved to the background.'
            : 'Background command started.'
          const waitHint = autoBackground
            ? `\nWait for an exited session with an expected code (${expectedExitCodes.join(', ')}) before running dependent commands.`
            : ''
          return {
            isError: false,
            output: `${prefix} Agent terminal: ${sessionId}\nCommand: ${command}${terminalLogPath ? `\nLog: ${terminalLogPath}` : ''}\nUse read_terminal(session_id="${sessionId}") to view output, write_terminal to send stdin, or kill_terminal to stop.${waitHint}`,
            data: { kind: 'command', command, cwd, stdout: '', sessionId, process: { state: 'running' }, expectedExitCodes },
          }
        }

        // Foreground: exec-based path for one-shot commands
        try {
          const result = await this.toolExecutor.runCommand(foregroundCommand, cwd, env, timeout, approved, operationSignal, expectedExitCodes, presentation)
          const commandOutput = result.data
          const data: ToolResultData = { kind: 'command', command: foregroundCommand, cwd,
            stdout: commandOutput?.stdout || '', stderr: commandOutput?.stderr, error: result.error,
            process: commandProcessOutcome(result), expectedExitCodes, truncated: commandOutput?.truncated }
          const outputSections: string[] = []
          if (commandOutput?.stdout) outputSections.push(`stdout:\n${commandOutput.stdout}`)
          if (commandOutput?.stderr) outputSections.push(`stderr:\n${commandOutput.stderr}`)
          if (commandOutput?.truncated) outputSections.push('[command output truncated]')
          if (commandOutput?.logPath) outputSections.push(`log: ${commandOutput.logPath}`)
          const formattedOutput = outputSections.join('\n\n') || 'No output'
          const statusDetails = [
            `code ${commandOutput?.exitCode ?? 'unknown'}`,
            commandOutput?.timedOut ? 'timed out' : '',
            commandOutput?.aborted ? 'aborted' : '',
          ].filter(Boolean).join(', ')
          if (!result.success) {
            return { data, isError: true, errorKind: commandOutput?.aborted ? 'abort' : commandOutput?.timedOut ? 'timeout' : result.errorKind ?? 'execution',
              ...(result.recovery ? { recovery: result.recovery } : {}), output: `Error (${statusDetails})${result.error ? `: ${result.error}` : ''}\n${formattedOutput}` }
          }
          const exitStatus = typeof commandOutput?.exitCode === 'number'
            ? `Process exited with code ${commandOutput.exitCode}`
            : commandOutput?.exitSignal ? `Process exited with signal ${commandOutput.exitSignal}`
            : 'Process finished without an exit code'
          return { data, isError: false, output: `${exitStatus}\n${formattedOutput}` }
        } catch (e) {
          return commandFailure(`Error executing command: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      case 'read_terminal': {
        const sessionId = args.session_id as string
        if (!sessionId) return toolFailure(`Error: session_id is required`, 'validation', 'none')
        const tail = typeof args.tail_lines === 'number' ? args.tail_lines : 200
        const sinceSeq = typeof args.since_seq === 'number' ? args.since_seq : 0
        const result = await this.toolExecutor.ptyGetBuffer?.(sessionId, sinceSeq)
        if (!result?.success) return toolFailure(`Error: ${result?.error || 'failed to read terminal buffer'}`, 'execution', 'none')
        await this.emitTerminalSessions()
        const session = result.session
        const chunks = (result.chunks || []) as Array<{ seq: number; data: string }>
        const combined = chunks.map((c: { data: string }) => c.data).join('')
        // Strip ANSI escapes for model readability — terminal UI keeps them.
        // eslint-disable-next-line no-control-regex
        const stripped = combined.replace(/\u001B(?:[@-Z\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, '')
        const lines = stripped.split('\n')
        const tailed = tail > 0 ? lines.slice(-tail) : lines
        const truncatedNotice = tail > 0 && lines.length > tail
          ? `[showing last ${tailed.length} of ${lines.length} lines]\n`
          : ''
        const lastSeq = typeof result.lastSeq === 'number'
          ? result.lastSeq
          : chunks.length > 0 ? chunks[chunks.length - 1].seq : sinceSeq
        const sinceNotice = sinceSeq > 0
          ? ` • since_seq=${sinceSeq} • new_chunks=${chunks.length}`
          : ''
        const statusLine = session
          ? `[session ${sessionId} • status=${session.status}${typeof session.exitCode === 'number' ? ` • exit=${session.exitCode}` : ''}${session.exitSignal ? ` • signal=${session.exitSignal}` : ''}${session.stopped ? ' • stopped' : ''} • cwd=${session.cwd}${session.logPath ? ` • log=${session.logPath}` : ''} • last_seq=${lastSeq}${sinceNotice}]`
          : `[session ${sessionId} • last_seq=${lastSeq}${sinceNotice}]`
        const omittedNotice = (result.omittedBytes || 0) > 0
          ? `[${result.omittedBytes} earlier output byte(s) omitted from memory; full output remains in the session log]\n`
          : ''
        const body = chunks.length === 0 && sinceSeq > 0
          ? '[no new output since last read]'
          : `${omittedNotice}${truncatedNotice}${tailed.join('\n')}`
        const process: CommandProcessOutcome = session?.stopped
          ? { state: 'aborted', exitCode: session.exitCode ?? null, ...(session.exitSignal ? { signal: session.exitSignal } : {}) }
          : session?.status === 'running' || session?.status === 'starting'
          ? { state: 'running' }
          : session?.exitSignal ? { state: 'signaled', signal: session.exitSignal }
          : typeof session?.exitCode === 'number' ? { state: 'exited', exitCode: session.exitCode }
          : { state: 'unknown' }
        const launchData = [...this.session.turns].reverse().flatMap(turn => turn.toolResults || [])
          .map(result => result.data).find(data => data?.kind === 'command' && data.sessionId === sessionId)
        const expectedExitCodes = this.agentBackgroundSessions.get(sessionId)?.expectedExitCodes
          ?? (launchData?.kind === 'command' ? launchData.expectedExitCodes : session?.expectedExitCodes ?? [0])
        return { isError: false, output: `${statusLine}\n${body}`, data: { kind: 'command', sessionId, command: this.agentBackgroundSessions.get(sessionId)?.command ?? session?.command ?? (launchData?.kind === 'command' ? launchData.command : undefined),
          cwd: session?.cwd, stdout: tailed.join('\n'), process, expectedExitCodes,
          truncated: Boolean(truncatedNotice || omittedNotice) } }
      }

      case 'write_terminal': {
        const sessionId = args.session_id as string
        const data = args.data as string
        if (!sessionId) return toolFailure(`Error: session_id is required`, 'validation', 'none')
        if (typeof data !== 'string' || data.length === 0) return toolFailure(`Error: data is required`, 'validation', 'none')
        const result = await this.toolExecutor.ptyWrite?.(sessionId, data)
        if (!result?.success) return toolFailure(`Error: ${result?.error || 'failed to write terminal stdin'}`, 'execution', 'unknown')
        await this.emitTerminalSessions()
        return `Wrote ${Buffer.byteLength(data)} byte(s) to terminal ${sessionId}.`
      }

      case 'kill_terminal': {
        const sessionId = args.session_id as string
        if (!sessionId) return toolFailure(`Error: session_id is required`, 'validation', 'none')
        // Try interrupting the current command first (Ctrl+C semantics);
        // fall back to killing the session entirely if the model passes
        // hard=true (or interrupt fails).
        const hard = args.hard === true
        if (!hard) {
          const interrupt = await this.toolExecutor.ptyInterruptCommand?.(sessionId)
          if (interrupt && interrupt.success) {
            await new Promise(resolve => setTimeout(resolve, 750))
            const session = await this.getTerminalSession(sessionId)
            if (!session || session.status !== 'running') {
              this.agentBackgroundSessions.delete(sessionId)
              await this.emitTerminalSessions()
              return `Terminal ${sessionId} interrupted and exited.`
            }
            // A plain stdin Ctrl+C is not reliable without a real PTY, so
            // fall through to process-tree termination when the shell is
            // still alive after the graceful attempt.
            await this.emitTerminalSessions()
          }
        }
        const killed = await this.toolExecutor.ptyKill?.(sessionId)
        if (killed && killed.success) {
          this.agentBackgroundSessions.delete(sessionId)
          await this.emitTerminalSessions()
          return `Terminal ${sessionId} terminated.`
        }
        return toolFailure(`Error: failed to kill terminal ${sessionId} — ${killed?.error || 'unknown error'}`, 'execution', 'unknown')
      }

      case 'list_terminals': {
        const result = await this.toolExecutor.ptyList?.()
        if (!result?.success) return toolFailure(`Error: ${result?.error || 'failed to list terminals'}`, 'execution', 'none')
        const rawSessions = (result.sessions || []) as Array<{ isAgentSession?: boolean; id: string; status: string; exitCode?: number; cwd: string; logPath?: string; command?: string; title?: string }>
        const sessions = rawSessions.filter(s => s.isAgentSession || this.agentBackgroundSessions.has(s.id))
        await this.emitTerminalSessions()
        if (sessions.length === 0) return { isError: false, output: 'No agent terminal sessions active.', data: { kind: 'items', items: [] } }
        const lines = sessions.map(s => {
          const meta = this.agentBackgroundSessions.get(s.id)
          const command = meta?.command || s.command || s.title
          const cmd = command ? ` • command: ${command}` : ''
          const exit = typeof s.exitCode === 'number' ? ` • exit=${s.exitCode}` : ''
          const log = s.logPath ? ` • log=${s.logPath}` : ''
          return `- ${s.id} • ${s.status}${exit} • cwd=${s.cwd}${log}${cmd}`
        })
        return { isError: false, output: `${sessions.length} agent terminal session(s):\n${lines.join('\n')}`, data: { kind: 'items', items: sessions.map(session => ({
          title: this.agentBackgroundSessions.get(session.id)?.command || session.command || session.title || session.id,
          status: session.status, path: session.cwd,
        })) } }
      }

      case 'delete_file': {
        const filePath = this.resolvePath(basePath, args.path as string)
        const existing = await this.toolExecutor.readFile(filePath)
        if (!existing.success) return toolFailure(`Error: unable to read file before deletion - ${existing.error}`, 'execution', 'none')
        await this.captureBeforeSnapshot(filePath)
        const result = await this.toolExecutor.deleteFile(filePath, {
          source: 'ai',
          label: 'AI delete_file',
          expectedHash: hashText(existing.data || ''),
        })
        return fileMutationOutput(result, `File deleted: ${args.path}`)
      }

      case 'present_workflow': {
        const workflow = String(args.workflow || '').trim()
        const stage = String(args.stage || '').trim()
        const title = String(args.title || '').trim()
        const question = String(args.question || '').trim()
        if (!workflow || !stage || !title || !question) return toolFailure('Error: workflow, stage, title, and question are required', 'validation', 'none')
        if (workflow.length > 160 || stage.length > 160 || title.length > 240 || question.length > 2_000) return toolFailure('Error: workflow surface text exceeds the allowed length', 'validation', 'none')
        if (String(args.detail || '').length > 2_000 || String(args.exploration_id || '').length > 160) return toolFailure('Error: workflow surface metadata exceeds the allowed length', 'validation', 'none')
        const contract = this.activeWorkflowContract
        if (!contract) return toolFailure('Error: no active plugin workflow is available for this run', 'environment', 'none')
        if (contract.workflow !== workflow) return toolFailure(`Error: workflow ${workflow} is not active for this run`, 'validation', 'none')
        if (contract.stages?.length && !contract.stages.includes(stage)) return toolFailure(`Error: workflow stage ${stage} is not declared by ${workflow}`, 'validation', 'none')
        if (this.completedWorkflowStages.has(stage)) return toolFailure(`Error: workflow stage ${stage} has already been resolved`, 'validation', 'none')
        const pendingCheckpoint = this.pendingAutomaticWorkflowCheckpoint()
        if (pendingCheckpoint && contract.stages?.length) {
          const requestedIndex = contract.stages.indexOf(stage)
          const pendingIndex = contract.stages.indexOf(pendingCheckpoint.stage)
          if (requestedIndex > pendingIndex) return toolFailure(`Error: workflow checkpoint ${pendingCheckpoint.stage} must be resolved before ${stage}`, 'validation', 'none')
        }
        if (args.choices !== undefined && (!Array.isArray(args.choices) || args.choices.length > 40)) return toolFailure('Error: workflow choices are invalid', 'validation', 'none')
        const choices = Array.isArray(args.choices)
          ? args.choices.flatMap((choice: any) => {
              if (!choice || typeof choice !== 'object') return []
              const id = String(choice.id || '').trim()
              const label = String(choice.label || '').trim()
              const detail = String(choice.detail || '').trim()
              return id && id.length <= 80 && label && label.length <= 240 && detail.length <= 2_000 ? [{ id, label, detail: detail || undefined }] : []
            })
          : undefined
        if (Array.isArray(args.choices) && choices?.length !== args.choices.length) return toolFailure('Error: workflow choices contain invalid fields', 'validation', 'none')
        if (choices && new Set(choices.map(choice => choice.id)).size !== choices.length) return toolFailure('Error: workflow choice ids must be unique', 'validation', 'none')
        if (args.directions !== undefined && (!Array.isArray(args.directions) || args.directions.length > 20)) return toolFailure('Error: workflow directions are invalid', 'validation', 'none')
        const directions = Array.isArray(args.directions)
          ? args.directions.flatMap((direction: any) => {
              if (!direction || typeof direction !== 'object') return []
              const id = String(direction.id || '').trim()
              const name = String(direction.name || '').trim()
              const thesis = String(direction.thesis || '').trim()
              const screenshotPath = String(direction.screenshotPath || '').trim()
              const tags = Array.isArray(direction.tags) ? direction.tags.map(String).map((tag: string) => tag.trim()).filter(Boolean) : []
              return id && id.length <= 80 && name && name.length <= 160 && thesis && thesis.length <= 2_000 && screenshotPath.length <= 1_000 && tags.length <= 8 && tags.every((tag: string) => tag.length <= 80)
                ? [{
                    id,
                    name,
                    thesis,
                    screenshotPath: screenshotPath || undefined,
                    tags: tags.length ? tags : undefined,
                  }]
                : []
            })
          : undefined
        if (Array.isArray(args.directions) && directions?.length !== args.directions.length) return toolFailure('Error: workflow directions contain invalid fields', 'validation', 'none')
        if (directions && new Set(directions.map(direction => direction.id)).size !== directions.length) return toolFailure('Error: workflow direction ids must be unique', 'validation', 'none')
        const input = args.input && typeof args.input === 'object' ? args.input as Record<string, unknown> : undefined
        if (args.input !== undefined && !input) return toolFailure('Error: workflow input is invalid', 'validation', 'none')
        const inputType = input ? String(input.type || '') : ''
        const inputMin = input && Number.isFinite(Number(input.min)) ? Number(input.min) : undefined
        const inputMax = input && Number.isFinite(Number(input.max)) ? Number(input.max) : undefined
        if (input && !['number', 'text'].includes(inputType)) return toolFailure('Error: workflow input type is invalid', 'validation', 'none')
        if (inputType === 'number' && inputMin !== undefined && inputMax !== undefined && inputMin > inputMax) return toolFailure('Error: workflow input range is invalid', 'validation', 'none')
        const renderer = String(args.renderer || '')
        if (renderer === 'choice' && !choices?.length) return toolFailure('Error: choice workflow surfaces require choices', 'validation', 'none')
        if (renderer === 'gallery' && (!directions?.length || directions.some(direction => !direction.screenshotPath))) return toolFailure('Error: gallery workflow surfaces require workspace screenshots', 'validation', 'none')
        if (renderer === 'count' && !choices?.length && inputType !== 'number') return toolFailure('Error: count workflow surfaces require choices or a number input', 'validation', 'none')
        if (!choices?.length && !directions?.length && !input) return toolFailure('Error: workflow surface has no interactive content', 'validation', 'none')
        const ui: WorkflowSurfaceSpec = {
          workflow,
          stage,
          renderer: ['choice', 'count', 'gallery'].includes(String(args.renderer || ''))
            ? String(args.renderer) as WorkflowSurfaceSpec['renderer']
            : undefined,
          title,
          detail: String(args.detail || '').trim() || undefined,
          explorationId: String(args.exploration_id || '').trim() || undefined,
          choices,
          directions,
          input: input
            ? {
                type: inputType as 'number' | 'text',
                min: inputMin,
                max: inputMax,
                placeholder: String(input.placeholder || '').trim() || undefined,
                label: String(input.label || '').trim() || undefined,
              }
            : undefined,
        }
        const response = await this.interactiveRequests.request({
          id: toolCallId,
          kind: 'input',
          event: {
            type: 'ask:user',
            requestId: toolCallId,
            question,
            options: choices?.map(choice => choice.id),
            reason: ui.detail,
            ui,
          },
        }, { signal: operationSignal, cancelDecision: 'cancelled' })
        this.resolvedAskUserResponses.set(toolCallId, response)
        return `[Workflow response] ${response}`
      }

      case 'ask_user': {
        const response = await this.interactiveRequests.request({
          id: toolCallId,
          kind: 'input',
          event: {
            type: 'ask:user',
            requestId: toolCallId,
            question: args.question as string,
            options: args.options as string[] | undefined,
            reason: args.reason as string | undefined,
            command: args.command as string | undefined,
          },
        }, { signal: operationSignal, cancelDecision: 'deny' })
        this.resolvedAskUserResponses.set(toolCallId, response)
        return `[User response] ${response}`
      }

      case 'notify_user': {
        this.emit({ type: 'notification', message: args.message as string, level: (args.type as 'info' | 'success' | 'warning' | 'error') || 'info' })
        return `Notification sent`
      }

      case 'use_skill': {
        const skillId = String(args.skill_id || '').trim()
        const reason = args.reason as string | undefined
        if (!skillId) return toolFailure('Error: skill_id is required', 'validation', 'none')
        const skill = this.config.enabledSkills?.find(candidate => candidate.id === skillId || candidate.name === skillId || candidate.command === skillId)
        if (!skill) return toolFailure(`Error: skill "${skillId}" is not enabled for this session`, 'permission', 'none')
        const alreadyActive = this.activatedRunSkills.has(skill.id)
        this.activatedRunSkills.set(skill.id, skill)
        if (alreadyActive) return `Skill already active for this task: ${skill.name || skill.id}`
        return reason ? `Skill activated for this task: ${skill.name || skill.id} (${reason})` : `Skill activated for this task: ${skill.name || skill.id}`
      }

      default:
        if (this.mcpClient && isMcpTool(name)) {
          const signal = operationSignal
          const result = await executeMcpTool(this.mcpClient, name, args, {
            ...(signal ? { signal } : {}),
            execution: {
              conversationId: this.config.conversationId,
              runId: this.workExecution.getCurrentRunId() || undefined,
              toolCallId,
              itemId: toolCallId,
            },
          })
          return {
            isError: result.isError,
            ...(result.isError ? { errorKind: 'execution' as const } : {}),
            output: result.output,
            attachments: result.attachments,
          }
        }
        return toolFailure(`Unknown tool: ${name}`, 'validation', 'none')
    }
  }

  private formatWebSearchResults(response: WebSearchResponse): string {
    const attr = (value: string): string => String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240)
    const clean = (value: string | undefined): string => String(value || '').replace(/\s+/g, ' ').trim()

    const lines = [
      `<web_search_results query="${attr(response.query)}" provider="${attr(response.provider)}" count="${response.results.length}" retrieved_at="${attr(response.retrievedAt)}" partial="${response.partial}">`,
    ]
    if (response.queries.length > 1) lines.push(`queries: ${response.queries.map(clean).join(' | ')}`)
    response.warnings.forEach(warning => lines.push(`warning: ${clean(warning)}`))
    response.results.forEach((result, index) => {
      const title = clean(result.title) || '(untitled)'
      const snippet = clean(result.snippet)
      lines.push(`${result.id || `S${index + 1}`}. ${title}`)
      lines.push(`   url: ${result.url}`)
      if (result.domain) lines.push(`   domain: ${result.domain}`)
      if (snippet) lines.push(`   snippet: ${snippet}`)
      if (result.source) lines.push(`   source: ${clean(result.source)}`)
      if (result.publishedDate) lines.push(`   published: ${clean(result.publishedDate)}`)
      if (typeof result.score === 'number') lines.push(`   relevance: ${result.score}`)
    })
    lines.push('</web_search_results>')
    return lines.join('\n')
  }

  private formatWebFetchResults(response: WebFetchResponse): string {
    return formatWebSources(response)
  }

  private resolvePath(basePath: string, relativePath: string): string {
    return resolvePath(basePath, relativePath)
  }

  /**
   * 将绝对路径转为 workspace 相对路径。
   * 返回给 AI 的路径统一用相对路径，避免 AI 在绝对/相对路径之间混淆。
   */
  private toWorkspaceRelative(basePath: string, filePath: string): string {
    return toWorkspaceRelative(basePath, filePath)
  }

  private createUserTurn(
    content: string,
    attachments?: NonNullable<AgentTurn['metadata']>['attachments'],
    id = generateTurnId(),
    capabilities?: NonNullable<AgentTurn['metadata']>['capabilities'],
  ): AgentTurn {
    const metadata: AgentTurn['metadata'] = {}
    if (attachments?.length) metadata.attachments = attachments.map(attachment => ({ ...attachment }))
    if (capabilities?.items.length) metadata.capabilities = { items: capabilities.items.map(item => ({ ...item })) }
    const workRunId = this.workExecution.getCurrentRunId()
    if (workRunId) metadata.workRunId = workRunId
    return {
      id,
      role: 'user',
      content,
      timestamp: Date.now(),
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    }
  }

  private createAssistantTurn(
    content: string,
    toolCalls?: ToolCall[],
    metadata?: AgentTurn['metadata']
  ): AgentTurn {
    const finalMetadata: AgentTurn['metadata'] = { ...metadata }
    const workRunId = this.workExecution.getCurrentRunId()
    if (workRunId) finalMetadata.workRunId = workRunId
    let turnId = generateTurnId()
    if (this.pendingAssistantMessageId) {
      turnId = this.pendingAssistantMessageId
      this.pendingAssistantMessageId = null
    }

    return {
      id: turnId,
      role: 'assistant',
      content,
      timestamp: Date.now(),
      toolCalls,
      metadata: finalMetadata,
    }
  }

  private finishInterruptedStream(
    textContent: string,
    reasoningContent: string,
    model: APIModel | null,
    startTime: number,
    interruption?: AgentRunInterruption,
  ): AgentTurn | null {
    const visibleText = stripTextToolCallMarkup(textContent, { stripIncomplete: true })
    this.emit({ type: 'stream:end', interrupted: true })
    if (!visibleText && !reasoningContent.trim()) return null
    return this.createAssistantTurn(visibleText, undefined, {
      model: model?.name,
      duration: Date.now() - startTime,
      mode: this.config.mode,
      interrupted: true,
      ...(interruption ? { interruption } : {}),
      thinking: reasoningContent ? {
        content: reasoningContent,
        source: 'provider',
        status: 'interrupted',
        durationMs: Date.now() - startTime,
        tokenCount: Math.max(1, Math.ceil(reasoningContent.length / 4)),
      } : undefined,
    })
  }

  private createToolResultTurn(results: ToolResult[]): AgentTurn {
    const workRunId = this.workExecution.getCurrentRunId()
    return {
      id: generateTurnId(),
      role: 'tool_result',
      content: results.map(r => `${r.name}: [${toolResultExecutionStatus(r)}] ${(r.output || '').slice(0, 500)}`).join('\n\n'),
      timestamp: Date.now(),
      toolResults: results,
      metadata: workRunId ? { workRunId } : undefined,
    }
  }

  private createMockTurn(): AgentTurn {
    return this.createAssistantTurn(
      `**Mock Response** (No API key configured)\n\nPlease configure your API key in the bottom-left corner to enable AI features.`,
      undefined,
      { mode: this.config.mode }
    )
  }

  private emit(event: AgentEventType): void {
    this.events.emit(event)
  }

}
