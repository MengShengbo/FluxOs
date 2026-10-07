export { AgentEngine } from './agentEngine'
export type { AgentEventType, AgentEventListener } from './agentEngine'
export { buildSystemPrompt, invalidateStaticPromptCache } from './systemPrompt'
export { TaskManager } from './taskManager'
export type { TaskTreeNode, TaskEvent, TaskToolCall, ActiveTaskContext } from './taskManager'
export { WorkExecutionTracker } from './workExecutionTracker'
export type {
  WorkActivity,
  WorkActivityKind,
  WorkActivityStatus,
  WorkExecutionSnapshot,
  WorkRun,
  WorkRunStatus,
  WorkStep,
  WorkStepControlAction,
  WorkStepStatus,
} from '@fluxos/contracts/workExecutionTypes'
export { ContextManager } from './contextManager'
export type { StructuredSummary } from './contextManager'
export { createAgentRuntime } from './runtime/agentRuntime'
export type { AgentRuntime, CreateAgentRuntimeOptions } from './runtime/agentRuntime'
export {
  applyPreset,
  ensureDirectories,
  getConfigDir,
  getConversationsDir,
  getPresetByIdOrModel,
  getPresetByIdOrModelFrom,
  loadConfig,
  saveConfig,
} from '@fluxos/models/config'
export type { ModelCapabilities, ModelMetadataSource, ModelPreset, FluxAgentConfig } from '@fluxos/models/config'
export { discoverModelPresets, getModelPresets, readCachedModelDiscovery } from '@fluxos/models/modelDiscovery'
export type { ModelDiscoveryResult } from '@fluxos/models/modelDiscovery'
export { createFluxAgentRequestHeaders, getFluxAgentClientIdentity } from '@fluxos/models/clientIdentity'
export { configureNetworkProxy, describeNetworkProxy, readWindowsProxySettings, resolveNetworkProxy } from '@fluxos/platform/networkProxy'
export type { NetworkProxyConfiguration, NetworkProxyStatus, WindowsProxySettings } from '@fluxos/platform/networkProxy'
export { DefaultAgentStateProvider } from './runtime/stateProvider'
export type { AgentRuntimeConfig } from './runtime/stateProvider'
export { NodeToolExecutor } from '@fluxos/tools/nodeToolExecutor'
export { RuntimeTaskManager } from '@fluxos/tools/runtimeTaskManager'
export { getRuntimeInfo } from '@fluxos/platform/runtime'
export { getChildProcessSpawnOptions, getDefaultShellSpec, usesProcessGroup } from '@fluxos/platform/process'
export { SubAgentTaskManager } from './runtime/subAgentTaskManager'
export { SubAgentCompletionCoordinator } from './subAgentCompletionCoordinator'
export { SubAgentBudget, DEFAULT_SUB_AGENT_BUDGET } from './subAgentBudget'
export { AgentJoinCoordinator } from './agentJoinCoordinator'
export type {
  CreateRuntimeTaskInput,
  RuntimeTaskControl,
  RuntimeTaskManagerOptions,
  RuntimeTaskUpdate,
  RuntimeTaskOutput,
} from '@fluxos/tools/runtimeTaskManager'
export type {
  SubAgentCompletionResult,
  SubAgentCompletionStats,
  SubAgentCompletionStatus,
  SubAgentJoinPolicy,
} from './subAgentCompletionCoordinator'
export type { SubAgentBudgetConfig, SubAgentBudgetTaskView } from './subAgentBudget'
export type { AgentJoinCoordinatorOptions, JoinTaskView } from './agentJoinCoordinator'
export type {
  ReadSubAgentTranscriptOptions,
  ReadSubAgentTranscriptResult,
  StartedSubAgentTask,
  StartSubAgentTaskContext,
  StartSubAgentTaskInput,
  SubAgentTaskDescriptor,
  SubAgentTaskManagerOptions,
  SubAgentTaskSnapshot,
  SubAgentTranscriptRecord,
  WaitSubAgentSnapshot,
  WaitSubAgentStatus,
  WaitSubAgentsOptions,
  WaitSubAgentsResult,
} from './runtime/subAgentTaskManager'
export type {
  RuntimeRestartPolicy,
  RuntimeTask,
  RuntimeTaskEvent,
  RuntimeTaskFilter,
  RuntimeTaskKind,
  RuntimeTaskStatus,
} from '@fluxos/contracts/runtimeTaskTypes'
export {
  getAllTools,
  getToolsForMode,
  getToolByName,
  getToolsByCategory,
  toolsToOpenAIFormat,
  toolsToAnthropicFormat,
} from '@fluxos/tools/toolRegistry'
export { PermissionPipeline, createDefaultPipeline } from '@fluxos/tools/permissions'
export { TurnStrategyPlanner } from './turnStrategy'
export type { TurnIntent, TurnScope, TurnStrategy } from './turnStrategy'
export { runModelRequest } from '@fluxos/models/modelRequestOrchestrator'
export type { ModelProtocolFallback, ModelRequestOrchestratorOptions } from '@fluxos/models/modelRequestOrchestrator'
export { executeToolCallBatches, partitionToolCalls } from './toolCallOrchestrator'
export type { ToolCallBatch, ToolCallExecutionOptions, ToolCallPartitionOptions } from './toolCallOrchestrator'
export { planContextCompaction, splitTurnsForCompaction } from './contextCompactionBoundary'
export type { ContextCompactionPlan, ContextCompactionPlanOptions } from './contextCompactionBoundary'
export { dispatchTaskTool } from './taskToolDispatcher'
export type { TaskSystemCreationEvent, TaskToolDispatchContext } from './taskToolDispatcher'

export * from '@fluxos/platform/profilePaths'
export * from '@fluxos/platform/networkProxy'
export * from '@fluxos/models/credentialStore'
export * from '@fluxos/extensions'
export * from './runtime/approvalCoordinator'
export * from './runtime/sessionRegistry'
export * from './runtime/systems/index'

export { AgentOrchestrator } from './agentOrchestrator'
export type { AgentOrchestratorHost, AutomationSubAgentPolicy } from './agentOrchestrator'
