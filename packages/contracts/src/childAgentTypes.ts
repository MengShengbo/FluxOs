import type { AgentTurn, CapabilityProfile, NativeReasoningConfig, ToolCall, ToolResult } from './agentTypes'

export type ChildCapabilityMode = 'full' | 'read_only'
export const AGENT_COLORS = ['blue', 'teal', 'violet', 'amber', 'rose', 'cyan', 'lime', 'orange'] as const
export type AgentColor = typeof AGENT_COLORS[number]

export interface ChildAgentIdentity {
  agentId: string
  ownerSessionId: string
  parentAgentId?: string
  name: string
  roleId: string
  roleLabel: string
  color: AgentColor
  mode: ChildCapabilityMode
  effectiveCapabilityProfile: CapabilityProfile
  createdAt: number
}

export interface ChildAgentSnapshot extends ChildAgentIdentity {
  legacy?: boolean
  state: 'idle' | 'running' | 'closed'
  lastOutcome?: 'completed' | 'partial' | 'failed' | 'interrupted'
  executionId?: string
  revision: number
  updatedAt: number
  model: string
  reasoning?: NativeReasoningConfig
  lastActivity?: string
  streamingText?: string
  error?: string
  finalText?: string
  pendingRequests: Array<{ id: string; question: string; options?: string[]; kind: 'permission' | 'question' }>
}

export type ChildTranscriptItem = {
  id: string
  sequence: number
  executionId: string
  timestamp: number
} & (
  | { kind: 'message'; turn: AgentTurn }
  | { kind: 'tool_call'; toolCall: ToolCall }
  | { kind: 'tool_result'; toolResult: ToolResult }
  | { kind: 'status'; phase: string; detail?: string }
)

/** committed means durably present in context, not task completion or model comprehension. */
export interface ChildAgentMessageReceipt {
  messageId: string
  intent: 'message' | 'followup'
  state: 'queued' | 'committed'
  /** Absent for migrated records whose original arrival time was not recorded. */
  createdAt?: number
  sourceWorkRunId?: string
  committedAt?: number
  executionId?: string
}

export interface ChildAgentDetail {
  agent: ChildAgentSnapshot
  messages?: ChildAgentMessageReceipt[]
  items: ChildTranscriptItem[]
  nextCursor?: number
  total: number
}

export function normalizeChildName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Give the child agent a name independent of its role.')
  const name = value.normalize('NFKC').trim()
  if (!name || [...name].length > 40 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error('Child agent name must contain 1–40 characters without control characters or newlines.')
  }
  return name
}

export function childCapabilityProfile(mode: ChildCapabilityMode, parent: CapabilityProfile): CapabilityProfile {
  return mode === 'read_only' ? 'read-only' : parent
}

export function childAgentAccessibleLabel(agent: Pick<ChildAgentIdentity, 'roleLabel' | 'name'>): string {
  return `${agent.roleLabel} ${agent.name}`
}
