import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { ApprovalPolicy } from '@fluxos/contracts/agentTypes'
import type { AutomationRecord } from './automationService'
import { AUTOMATION_SCHEMA_VERSION, type AutomationDefinition } from './automationTypes'

export function automationDefinitionFromRecord(record: AutomationRecord, revision = 1): AutomationDefinition {
  const approvalPolicy = normalizeApprovalPolicy(record.approvalPolicy)
  const capabilityPolicy = record.capabilityPolicy
  const capabilityApprovalPolicy = normalizeApprovalPolicy(capabilityPolicy?.approvalPolicy ?? approvalPolicy)
  return {
    id: record.id,
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    revision,
    status: record.lifecycleStatus ?? (record.enabled ? 'active' : 'paused'),
    name: record.name,
    description: record.description,
    workspaceRef: { path: resolve(record.workspacePath) },
    objective: {
      originalPrompt: record.objective?.originalPrompt ?? record.prompt,
      goal: record.objective?.goal ?? record.prompt,
      successCriteria: record.objective?.successCriteria ?? [],
      deliverables: record.objective?.deliverables ?? [],
      constraints: record.objective?.constraints ?? [],
      noChangeBehavior: record.objective?.noChangeBehavior,
      failureBehavior: record.objective?.failureBehavior,
    },
    triggers: record.triggers?.length
      ? JSON.parse(JSON.stringify(record.triggers)) as AutomationDefinition['triggers']
      : [{ id: stableId('trigger', `${record.id}:schedule`), kind: 'schedule', schedule: record.schedule, timezone: record.timezone }],
    context: {
      ...record.contextPolicy,
      mode: record.contextPolicy?.mode ?? record.mode ?? 'continuation',
      continuationConversationId: (record.contextPolicy?.mode ?? record.mode ?? 'continuation') === 'continuation'
        ? record.contextPolicy?.continuationConversationId ?? record.conversationId
        : undefined,
      includeAutomationMemory: record.contextPolicy?.includeAutomationMemory ?? false,
      includePreviousRunSummary: record.contextPolicy?.includePreviousRunSummary ?? false,
      fileRefs: record.contextPolicy?.fileRefs ?? [],
      skillIds: record.contextPolicy?.skillIds ?? [],
    },
    capabilities: {
      approvalPolicy: capabilityApprovalPolicy,
      allowedTools: capabilityPolicy?.allowedTools ?? [],
      deniedTools: capabilityPolicy?.deniedTools ?? [],
      paths: capabilityPolicy?.paths ?? [{ path: resolve(record.workspacePath), access: 'write' }],
      networkDomains: capabilityPolicy?.networkDomains ?? [],
      secretRefs: capabilityPolicy?.secretRefs ?? [],
      mcpServerIds: capabilityPolicy?.mcpServerIds ?? [],
      pluginIds: capabilityPolicy?.pluginIds ?? [],
      allowComputerUse: capabilityPolicy?.allowComputerUse ?? capabilityApprovalPolicy === 'full',
      allowBackgroundComputerUse: capabilityPolicy?.allowBackgroundComputerUse ?? false,
    },
    reliability: {
      ...record.reliabilityPolicy,
      misfirePolicy: record.reliabilityPolicy?.misfirePolicy ?? record.misfirePolicy,
      overlapPolicy: record.reliabilityPolicy?.overlapPolicy ?? record.overlapPolicy,
      maxParallel: record.reliabilityPolicy?.maxParallel ?? 1,
      maxQueuedRuns: record.reliabilityPolicy?.maxQueuedRuns ?? 1,
      maxRuntimeMinutes: record.reliabilityPolicy?.maxRuntimeMinutes ?? record.maxRuntimeMinutes,
      maxToolCalls: record.reliabilityPolicy?.maxToolCalls ?? 100,
      retry: {
        maxRetries: record.reliabilityPolicy?.retry.maxRetries ?? record.retryPolicy.maxRetries,
        backoffMinutes: record.reliabilityPolicy?.retry.backoffMinutes ?? record.retryPolicy.backoffMinutes,
        maxBackoffMinutes: record.reliabilityPolicy?.retry.maxBackoffMinutes ?? 1_440,
        jitter: record.reliabilityPolicy?.retry.jitter ?? 0.1,
      },
      concurrencyGroup: record.reliabilityPolicy?.concurrencyGroup,
      resourceLocks: record.reliabilityPolicy?.resourceLocks ?? [],
    },
    routing: record.routingPolicy ?? { rules: [], defaultAction: 'run' },
    agents: record.agentPolicy ?? { enabled: false, strategies: [] },
    delivery: record.deliveryPolicy!,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    publishedAt: record.createdAt,
  }
}

function normalizeApprovalPolicy(value: ApprovalPolicy): ApprovalPolicy {
  return value === 'agent' || value === 'full' ? value : 'ask'
}


function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`
}
