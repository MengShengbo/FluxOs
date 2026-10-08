import { createHash, randomUUID } from 'node:crypto'
import type { AutomationWorkspaceIdentity } from './automationWorkspaceIdentity'
export { captureAutomationWorkspaceIdentity, DEFAULT_AUTOMATION_WORKSPACE_SCAN_LIMITS, type AutomationWorkspaceIdentity } from './automationWorkspaceIdentity'
import type {
  AutomationContextSnapshot,
  AutomationPermissionSnapshot,
  AutomationRun,
  AutomationRunCheckpoint,
  AutomationToolEffectRecord,
} from './automationTypes'

export interface AutomationCheckpointState {
  canonicalEventSequence: number
  completedToolCallIds: string[]
  nonReplayableToolCallIds: string[]
  toolEffects: AutomationToolEffectRecord[]
  inFlightToolEffect?: AutomationToolEffectRecord
  pendingApprovalId?: string
  artifactIds: string[]
  contextSummary?: string
}

export function automationPermissionDigest(snapshot: AutomationPermissionSnapshot): string {
  return createHash('sha256').update(JSON.stringify({
    definitionRevision: snapshot.definitionRevision,
    allowedTools: snapshot.allowedTools,
    deniedTools: snapshot.deniedTools,
    paths: snapshot.paths,
    networkDomains: snapshot.networkDomains,
    secretRefs: snapshot.secretRefs,
    pluginIds: snapshot.pluginIds,
    pluginVersions: snapshot.pluginVersions ?? {},
  })).digest('hex')
}

export function createAutomationCheckpoint(input: {
  run: AutomationRun
  permissionSnapshot: AutomationPermissionSnapshot
  contextSnapshot: AutomationContextSnapshot
  state: AutomationCheckpointState
  reason: AutomationRunCheckpoint['reason']
  workspaceIdentity: AutomationWorkspaceIdentity
  now?: number
}): AutomationRunCheckpoint {
  const now = input.now ?? Date.now()
  const uncertain = input.state.inFlightToolEffect
  const replaySafe = !uncertain || uncertain.classification === 'read_only' || uncertain.classification === 'idempotent_write'
  const permissionIdentity = automationPermissionDigest(input.permissionSnapshot)
  return {
    id: `checkpoint-${randomUUID()}`,
    runId: input.run.id,
    definitionId: input.run.definitionId,
    definitionRevision: input.run.definitionRevision,
    conversationId: input.run.conversationId,
    canonicalEventSequence: input.state.canonicalEventSequence,
    completedToolCallIds: [...input.state.completedToolCallIds],
    nonReplayableToolCallIds: [...input.state.nonReplayableToolCallIds],
    toolEffects: input.state.toolEffects.map(effect => structuredClone(effect)),
    inFlightToolEffect: uncertain ? structuredClone(uncertain) : undefined,
    pendingApprovalId: input.state.pendingApprovalId,
    artifactIds: [...input.state.artifactIds],
    workspaceFingerprint: input.workspaceIdentity.fingerprint,
    workspaceCoverage: structuredClone(input.workspaceIdentity.coverage),
    gitHead: input.workspaceIdentity.gitHead,
    contextSummary: input.state.contextSummary,
    resumable: replaySafe && input.workspaceIdentity.complete,
    nonResumableReason: replaySafe
      ? input.workspaceIdentity.complete ? undefined : `Workspace state could not be fully fingerprinted: ${input.workspaceIdentity.coverage.issues.map(issue => `${issue.code}${issue.path ? ` (${issue.path})` : ''}`).join(', ')}.`
      : `Tool ${uncertain?.toolName ?? 'unknown'} may have produced a non-replayable external effect.`,
    reason: input.reason,
    createdAt: now,
    permissionDigest: permissionIdentity,
    contextSnapshotId: input.contextSnapshot.id,
  }
}
