import { toolFailure, type ToolDispatchOutput } from './runtime/toolDispatchResult'
import { toolResultCallStatus } from '@fluxos/contracts/toolResultData'
import { randomUUID } from 'node:crypto'
import type { AgentConfig } from '@fluxos/contracts/agentTypes'
import type { AgentStateProvider } from '@fluxos/contracts/stateTypes'
import type { ToolExecutor } from '@fluxos/contracts/toolExecutor'
import type { RuntimeTask } from '@fluxos/contracts/runtimeTaskTypes'
import type { SubAgentDefinition, SubAgentEvent, SubAgentEvidence } from '@fluxos/contracts/subAgentTypes'
import { childCapabilityProfile, normalizeChildName, type ChildCapabilityMode } from '@fluxos/contracts/childAgentTypes'
import type { AgentEventType } from './agentEngine'
import { getSubAgentDefinition, getAvailableAgentTypes, type SubAgentRegistry } from './subAgentRegistry'
import type { SubAgentResult } from '@fluxos/contracts/subAgentTypes'
import { SubAgentBudget, type SubAgentBudgetConfig, type SubAgentBudgetTaskView } from './subAgentBudget'
import { AgentJoinCoordinator } from './agentJoinCoordinator'
import { effectiveRequiredChildren } from './subAgentStepCoordinator'
import { SubAgentTaskManager, isTerminalSubAgentStatus, type SubAgentTaskSnapshot, type WaitSubAgentsResult } from './runtime/subAgentTaskManager'
import type { ChildAgentController } from './runtime/childAgentController'
import type { TaskManager } from './taskManager'

export const AGENT_CONTROL_TOOLS = ['spawn_agent', 'followup_agent', 'send_agent_message', 'close_agent', 'wait_agents', 'detach_agent', 'cancel_agent', 'list_agents', 'read_agent'] as const
export interface AutomationSubAgentPolicy {
  runId: string
  allowedTools: string[]
  deniedTools: string[]
  allowedAgentTypes: string[]
  maxSubtasks: number
  maxParallel: number
  authorizeSubtask?: () => void
}
export interface AgentOrchestratorHost {
  getConfig(): AgentConfig
  getRunId(): string | null
  getParentObjective(): string | undefined
  getTaskManager(): TaskManager
  stateProvider: AgentStateProvider
  toolExecutor: ToolExecutor
  registry: SubAgentRegistry
  tasks: SubAgentTaskManager
  emit(event: AgentEventType): void
}

/** Owns delegation admission and identity-to-execution routing, not model execution. */
export class AgentOrchestrator {
  private childAgents: ChildAgentController | null = null
  private readonly admissions = new Set<string>()
  private automationSubAgentPolicy: AutomationSubAgentPolicy | null = null
  private readonly subAgentBudget = new SubAgentBudget()
  readonly joinCoordinator = new AgentJoinCoordinator()
  constructor(private readonly host: AgentOrchestratorHost) {}
  setChildAgentController(controller: ChildAgentController): void { this.childAgents = controller }
  getChildAgentController(): ChildAgentController | null { return this.childAgents }
  handles(name: string): boolean { return (AGENT_CONTROL_TOOLS as readonly string[]).includes(name) }
  canSpawn(): boolean { return Boolean(this.childAgents) }
  private get subAgentTaskManager(): SubAgentTaskManager { return this.host.tasks }

  private resolveTask(id: string): SubAgentTaskSnapshot {
    const owner = this.host.getConfig().conversationId
    const child = this.childAgents?.list(owner || '').find(agent => agent.agentId === id)
    // Execution ownership is registered before the child runtime starts. During that
    // window its snapshot still points at the previous execution; use the task ledger.
    const admitted = this.host.tasks.listTasks().find(task => task.agentSessionId === id
      && task.ownerSessionId === owner && !isTerminalSubAgentStatus(task.runtimeTask.status))
    const task = admitted || this.host.tasks.getTask(child?.executionId || id)
    if (!task || task.ownerSessionId !== owner) throw new Error('Child execution not found in this conversation: ' + id)
    return task
  }
  stop(taskId: string, reason = 'Subagent cancelled by request'): Promise<RuntimeTask> {
    return this.host.tasks.stopTask(this.resolveTask(taskId).id, reason)
  }

  setSubAgentBudget(config: Partial<SubAgentBudgetConfig>): SubAgentBudgetConfig {
    return this.subAgentBudget.configure(config)
  }

  getSubAgentBudget(): SubAgentBudgetConfig {
    return this.subAgentBudget.getConfig()
  }

  setAutomationSubAgentPolicy(policy: AutomationSubAgentPolicy | null): void {
    this.automationSubAgentPolicy = policy ? {
      ...policy,
      allowedTools: [...policy.allowedTools],
      deniedTools: [...policy.deniedTools],
      allowedAgentTypes: [...policy.allowedAgentTypes],
    } : null
  }

  currentRunSubAgents(): SubAgentTaskSnapshot[] {
    const runId = this.host.getRunId()
    return this.subAgentTaskManager.listTasks().filter(task => task.ownerSessionId === this.host.getConfig().conversationId
      && (task.workRunId === runId || task.runtimeTask.metadata?.workRunId === runId))
  }

  unresolvedRunSubAgents(): SubAgentTaskSnapshot[] {
    const pendingIds = new Set(this.subAgentTaskManager.listPendingCompletions(
      this.host.getConfig().conversationId, this.host.getRunId() || undefined,
    ).map(result => result.agentId))
    return effectiveRequiredChildren(this.currentRunSubAgents()).filter(task => !isTerminalSubAgentStatus(task.runtimeTask.status) || pendingIds.has(task.id))
  }

  retrySubAgentTask(taskId: string): RuntimeTask {
    const previous = this.resolveTask(taskId)
    if (!['completed', 'failed', 'stopped', 'interrupted', 'orphaned'].includes(previous.runtimeTask.status)) {
      throw new Error('Only a finished subagent can be retried')
    }
    const definition = getSubAgentDefinition(previous.agentType, this.host.registry)
    if (!definition) throw new Error(`Subagent definition is no longer available: ${previous.agentType}`)
    const identity = previous.agentSessionId ? this.childAgents?.get(previous.agentSessionId, previous.ownerSessionId || '') : undefined
    const sameRun = previous.workRunId === (this.host.getRunId() || undefined)
    return this.startSubAgentTask(definition, previous.objective, previous.objective, sameRun ? previous.id : undefined, previous.joinPolicy, sameRun ? previous.stepId : undefined,
      identity ? { name: identity.name, mode: identity.mode, agentId: identity.agentId } : undefined)
  }

  private formatWaitAgentsResult(result: WaitSubAgentsResult): string {
    const lines = [
      'wait_agents mode=' + result.mode + ' timedOut=' + result.timedOut + ' elapsedMs=' + result.elapsedMs,
    ]
    if (result.agents.length === 0) {
      lines.push('No child agents matched this wait.')
      return lines.join('\n')
    }
    for (const agent of result.agents) {
      const task = this.subAgentTaskManager.getTask(agent.agentId)
      lines.push(
        '- agentId: ' + (task?.agentSessionId || agent.agentId),
        '  executionId: ' + agent.agentId,
        '  agentType: ' + agent.agentType,
        '  status: ' + agent.status + ' (runtime: ' + agent.runtimeStatus + ')',
        '  joinPolicy: ' + agent.joinPolicy + ' | turns: ' + agent.turns + ' | elapsedMs: ' + agent.elapsedMs,
        '  objective: ' + agent.objective.slice(0, 500),
      )
      if (agent.error) lines.push('  error: ' + agent.error)
      if (agent.finalText) lines.push('  finalText: ' + agent.finalText)
    }
    if (result.timedOut) lines.push('The wait budget expired. Running children were not failed; use wait_agents again or read_agent for details.')
    return lines.join('\n')
  }

  private emitSubAgentProgress(agentId: string, agentType: string, label: string, event: SubAgentEvent): void {
    this.host.emit({ type: 'subagent:progress', agentId, agentType, label, event })
  }

  private formatSubAgentTask(task: SubAgentTaskSnapshot): string {
    const runtime = task.runtimeTask
    const lines = [
      `Agent ID: ${task.agentSessionId || task.id}`,
      `Execution ID: ${task.id}`,
      `Type: ${task.agentType}`,
      `Status: ${runtime.status}`,
      `Join policy: ${task.joinPolicy}`,
      `Objective: ${task.objective}`,
      `Started: ${new Date(task.startedAt).toISOString()}`,
    ]
    if (runtime.endedAt) lines.push(`Ended: ${new Date(runtime.endedAt).toISOString()}`)
    if (runtime.error) lines.push(`Error: ${runtime.error}`)
    if (task.transcriptPath) lines.push(`Transcript: ${task.transcriptPath}`)

    if (task.result) {
      const result = task.result as {
        ok?: boolean
        turns?: number
        elapsedMs?: number
        finalText?: string
        evidence?: SubAgentEvidence[]
        error?: string
      }
      lines.push('', `<subagent_report type="${task.agentType}" turns="${result.turns || 0}" elapsed_ms="${result.elapsedMs || 0}">`)
      lines.push('', 'final_report:', result.finalText || result.error || '(empty)', '')
      const evidence = result.evidence || []
      if (evidence.length > 0) {
        lines.push('evidence (top 12):')
        for (const item of evidence.slice(0, 12)) {
          const preview = item.preview.split('\n').slice(0, 3).map(line => `    ${line.replace(/\s+/g, ' ').trim().slice(0, 200)}`).join('\n')
          lines.push(`  - ${item.path}:L${item.startLine}-${item.endLine} · ${item.reason}`)
          if (preview) lines.push(preview)
        }
        if (evidence.length > 12) lines.push(`  (... ${evidence.length - 12} more evidence range(s))`)
      }
      lines.push('', '</subagent_report>')
    }
    return lines.join('\n')
  }

  async dispatchTool(name: string, args: Record<string, unknown>, operationSignal?: AbortSignal): Promise<ToolDispatchOutput> {
    switch (name) {
      case 'list_agents': {
        const named = this.childAgents?.list(this.host.getConfig().conversationId || '') || []
        return JSON.stringify(named)
      }

      case 'read_agent': {
        const owner = this.host.getConfig().conversationId || ''
        const agentId = String(args.agent_id || '').trim()
        if (!agentId) return toolFailure('Error: agent_id is required', 'validation', 'none')
        if (!this.childAgents) throw new Error('Child sessions are unavailable')
        const identity = this.childAgents.list(owner).find(agent => agent.agentId === agentId)
        const resolved = identity?.agentId || this.resolveTask(agentId).agentSessionId
        if (!resolved) throw new Error('Child session not found')
        return JSON.stringify(this.childAgents.read(resolved, owner, Number(args.offset || 0), Number(args.limit || 20)))
      }

      case 'send_agent_message': {
        if (!this.childAgents) return toolFailure('Error: reusable child sessions are unavailable', 'environment', 'none')
        const receipt = this.childAgents.message(String(args.agent_id), this.host.getConfig().conversationId || '', String(args.message || ''), {
          messageId: typeof args.message_id === 'string' ? args.message_id : undefined,
          sourceWorkRunId: this.host.getRunId() || undefined,
        })
        return JSON.stringify({ agentId: String(args.agent_id), ...receipt })
      }
      case 'followup_agent': {
        return this.followupChildAgent(String(args.agent_id), String(args.message || ''))
      }
      case 'close_agent': {
        if (!this.childAgents) return toolFailure('Error: reusable child sessions are unavailable', 'environment', 'none')
        await this.close(String(args.agent_id))
        return 'Child session closed.'
      }
      case 'wait_agents': {
        const agentIds = Array.isArray(args.agent_ids) ? args.agent_ids.map(value => this.resolveTask(String(value)).id) : undefined
        const mode = args.mode === 'any' ? 'any' : 'all'
        const timeoutMs = Math.min(typeof args.timeout_ms === 'number' ? args.timeout_ms : 120_000, this.joinCoordinator.remainingWaitMs())
        try {
          const result = await this.subAgentTaskManager.waitForTasks({
            agentIds,
            mode,
            timeoutMs,
            includeResults: args.include_results === true,
            ownerSessionId: this.host.getConfig().conversationId,
            workRunId: this.host.getRunId() || undefined,
            signal: operationSignal,
          })
          return this.formatWaitAgentsResult(result)
        } catch (error) {
          if ((error as { name?: string })?.name === 'AbortError') return toolFailure('Error: wait_agents aborted because the parent run stopped.', 'abort', 'none')
          return toolFailure('Error: ' + (error instanceof Error ? error.message : String(error)), 'execution', 'none')
        }
      }

      case 'detach_agent': {
        const agentId = String(args.agent_id || '').trim()
        if (agentId.length === 0) return toolFailure('Error: agent_id is required', 'validation', 'none')
        try {
          const task = this.subAgentTaskManager.setJoinPolicy(this.resolveTask(agentId).id, 'detached')
          return 'Subagent ' + agentId + ' detached from the parent run. Current status: ' + task.runtimeTask.status + '.'
        } catch (error) {
          return toolFailure('Error: ' + (error instanceof Error ? error.message : String(error)), 'execution', 'unknown')
        }
      }

      case 'cancel_agent': {
        const agentId = String(args.agent_id || '').trim()
        if (!agentId) return toolFailure('Error: agent_id is required', 'validation', 'none')
        try {
          const task = await this.stop(agentId)
          return `Subagent ${agentId} is ${task.status}.`
        } catch (error) {
          return toolFailure(`Error: ${error instanceof Error ? error.message : String(error)}`, 'execution', 'unknown')
        }
      }

      case 'spawn_agent': {
        const agentType = String(args.agent_type || '').trim()
        const objective = String(args.objective || '').trim()
        const extraContext = typeof args.context === 'string' ? args.context.trim() : ''
        const joinPolicy = args.join_policy === 'detached' ? 'detached' : 'required'
        if (agentType.length === 0) return toolFailure('Error: agent_type is required', 'validation', 'none')
        if (objective.length === 0) return toolFailure('Error: objective is required', 'validation', 'none')
        const def = getSubAgentDefinition(agentType, this.host.registry)
        if (def === undefined) return toolFailure('Error: unknown agent_type "' + agentType + '". Available: ' + getAvailableAgentTypes(this.host.registry).join(', ') + '.', 'validation', 'none')
        if (this.host.getConfig().workspacePath === undefined || this.host.getConfig().workspacePath === '') {
          return toolFailure('Error: no workspace open; cannot spawn subagent.', 'environment', 'none')
        }
        const parentObjective = this.host.getParentObjective()
        const enrichedObjective = [objective, extraContext ? 'Additional context from parent agent:\n' + extraContext : '', parentObjective ? 'Parent task objective (context, your assigned objective above remains your scope):\n' + parentObjective.slice(0, 4000) : ''].filter(Boolean).join('\n\n')
        const retryOf = typeof args.retry_of === 'string' ? args.retry_of.trim() : undefined
        const previous = retryOf ? this.resolveTask(retryOf) : null
        if (retryOf && (!previous || previous.ownerSessionId !== this.host.getConfig().conversationId || previous.workRunId !== this.host.getRunId())) {
          return toolFailure('Error: retry_of must identify a child belonging to this conversation and run.', 'validation', 'none')
        }
        if (previous && !['failed', 'stopped', 'interrupted', 'orphaned'].includes(previous.runtimeTask.status)) {
          return toolFailure('Error: retry_of must identify failed, stopped or interrupted work.', 'validation', 'none')
        }
        if (previous && previous.agentType !== def.id) return toolFailure('Error: a retry must preserve the original child role.', 'validation', 'none')
        const priorIdentity = previous?.agentSessionId ? this.childAgents?.get(previous.agentSessionId, previous.ownerSessionId || '') : undefined
        const childName = priorIdentity?.name ?? normalizeChildName(args.name)
        const mode: ChildCapabilityMode = priorIdentity?.mode ?? (args.capability_mode === 'read_only' ? 'read_only' : 'full')
        if (childName) this.childAgents?.assertNameAvailable(childName, this.host.getConfig().conversationId || '', priorIdentity?.agentId)
        const task = this.startSubAgentTask(def, objective, enrichedObjective, previous?.id, joinPolicy, previous?.stepId,
          childName ? { name: childName, mode, agentId: priorIdentity?.agentId } : undefined)
        const receipt = 'Subagent ' + def.label + (childName ? ' ' + childName : '') + ' started in the background. Agent ID: ' + (task.metadata?.agentSessionId || task.id) + '. Execution ID: ' + task.id + '.'
        return joinPolicy === 'required'
          ? receipt + ' Wait with wait_agents before finalizing, or detach_agent to release obsolete work. Cancellation is not successful completion.'
          : receipt + ' This child is detached and will not block the parent run.'
      }

      default: throw new Error('Unknown agent control tool: ' + name)
    }
  }

  async close(agentId: string): Promise<void> {
    if (!this.childAgents) throw new Error('Reusable child sessions unavailable')
    const child = this.childAgents.get(agentId, this.host.getConfig().conversationId || '')
    // Close admission synchronously, before cancellation yields to another follow-up.
    const closing = this.childAgents.close(agentId, child.ownerSessionId)
    const stopping = child.executionId && this.host.tasks.getTask(child.executionId)
      ? this.stop(agentId) : Promise.resolve()
    const results = await Promise.allSettled([closing, stopping])
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Child close failed')
  }

  followupChildAgent(agentId: string, message: string): string {
    if (!message.trim() || message.length > 20_000) throw new Error('Message must contain 1–20000 characters')
    if (!this.childAgents) throw new Error('Reusable child sessions unavailable')
    const agent = this.childAgents.get(agentId, this.host.getConfig().conversationId || '')
    if (agent.state === 'running') {
      const receipt = this.childAgents.message(agentId, agent.ownerSessionId, message, {
        intent: 'followup', sourceWorkRunId: this.host.getRunId() || undefined,
      })
      return 'Follow-up accepted for running child ' + agent.name + '. Message ID: ' + receipt.messageId + '. State: ' + receipt.state + '. Context delivery is not task completion.'
    }
    if (agent.state === 'closed') throw new Error('Child session is closed')
    const definition = getSubAgentDefinition(agent.roleId, this.host.registry)
    if (!definition) throw new Error('Child role is no longer available')
    const previous = agent.executionId ? this.host.tasks.getTask(agent.executionId) : null
    const sameRun = previous?.workRunId === (this.host.getRunId() || undefined)
    const task = this.startSubAgentTask(definition, message, message, sameRun ? agent.executionId : undefined, 'required', sameRun ? previous?.stepId : undefined, { name: agent.name, mode: agent.mode, agentId })
    return 'Child ' + agent.name + ' continued. Agent ID: ' + agentId + '. Execution ID: ' + task.id
  }

  startSubAgentTask(
    definition: SubAgentDefinition,
    objective: string,
    enrichedObjective: string,
    retryOf?: string,
    joinPolicy: 'required' | 'detached' = 'required',
    stepId?: string,
    childIdentity?: { name: string; mode: ChildCapabilityMode; agentId?: string },
  ): RuntimeTask {
    const workspacePath = this.host.getConfig().workspacePath
    if (workspacePath === undefined || workspacePath === '') throw new Error('No workspace open; cannot spawn subagent')
    if (!childIdentity || !this.childAgents) throw new Error('A named child runtime is required')
    const admissionKey = JSON.stringify([this.host.getConfig().conversationId, childIdentity.name])
    if (this.admissions.has(admissionKey)) throw new Error('Child already has an active execution: ' + childIdentity.name)
    const activeChildConfig = this.host.stateProvider.getActiveConfig()
    if (childIdentity && !activeChildConfig) throw new Error('No active model configuration for child execution')
    if (childIdentity?.agentId) {
      const child = this.childAgents!.get(childIdentity.agentId, this.host.getConfig().conversationId || '')
      if (child.state !== 'idle') throw new Error('Child is not idle: ' + child.name)
      const active = this.host.tasks.listTasks().some(task => task.agentSessionId === child.agentId && !isTerminalSubAgentStatus(task.runtimeTask.status))
      if (active) throw new Error('Child already has an active execution')
    }
    const agentSessionId = childIdentity ? childIdentity.agentId || 'agent-' + randomUUID() : undefined
    const ownerSessionId = this.host.getConfig().conversationId
    const workRunId = this.host.getRunId() || undefined
    const policy = this.automationSubAgentPolicy
    if (policy !== null) {
      if (policy.allowedAgentTypes.includes(definition.id) === false) throw new Error('Subagent type is not authorized for this automation run: ' + definition.id)
      const policyTasks = this.subAgentTaskManager.listTasks().filter(task => task.ownerSessionId === ownerSessionId && (policy.runId === '' || task.workRunId === policy.runId || task.runtimeTask.metadata?.workRunId === policy.runId))
      if (policyTasks.length >= policy.maxSubtasks) throw new Error('Automation run reached its ' + policy.maxSubtasks + '-subtask limit')
      const active = policyTasks.filter(task => ['starting', 'running', 'stopping'].includes(task.runtimeTask.status)).length
      if (active >= policy.maxParallel) throw new Error('Automation run reached its ' + policy.maxParallel + '-subagent concurrency limit')

    }

    const budgetTasks = (): SubAgentBudgetTaskView[] => this.subAgentTaskManager.listTasks().map(task => {
      const stats = task.stats
      return {
        ownerSessionId: task.ownerSessionId,
        workRunId: task.workRunId || (typeof task.runtimeTask.metadata?.workRunId === 'string' ? task.runtimeTask.metadata.workRunId : undefined),
        status: task.runtimeTask.status,
        startedAt: task.startedAt,
        endedAt: task.runtimeTask.endedAt,
        tokens: (stats?.inputTokens || 0) + (stats?.outputTokens || 0),
        requests: stats?.modelRequests || 0,
      }
    })
    const budgetCheck = this.subAgentBudget.checkSpawn({
      ownerSessionId,
      workRunId,
      tasks: budgetTasks(),
      pendingResults: this.subAgentTaskManager.listPendingCompletions(ownerSessionId, workRunId).length,
      pendingResultBytes: this.subAgentTaskManager.pendingCompletionBytes(ownerSessionId, workRunId),
    })
    if (budgetCheck.allowed === false) throw new Error(budgetCheck.reason + ' (' + budgetCheck.code + ')')

    const parent = this.host.getConfig()
    const parentChildConfig: AgentConfig = {
      ...parent,
      allowedTools: definition.allowedTools && parent.allowedTools
        ? definition.allowedTools.filter(tool => parent.allowedTools!.includes(tool))
        : definition.allowedTools || parent.allowedTools,
      disabledTools: [...(parent.disabledTools || []), ...(policy?.deniedTools || [])],
      enabledSkills: parent.enabledSkills?.map(skill => ({ ...skill })),
    }
    if (policy?.allowedTools.length) {
      parentChildConfig.allowedTools = parentChildConfig.allowedTools
        ? parentChildConfig.allowedTools.filter(tool => policy.allowedTools.includes(tool))
        : [...policy.allowedTools]
    }
    policy?.authorizeSubtask?.()
    const startedAt = Date.now()
    if (admissionKey) this.admissions.add(admissionKey)
    let started: { task: RuntimeTask; promise: Promise<SubAgentResult> }
    try {
      started = this.subAgentTaskManager.startTask<SubAgentResult>({
        kind: 'agent',
        agentType: definition.id,
        label: definition.label,
        objective,
        workspacePath,
        ownerSessionId,
        retryOf,
        agentSessionId,
        namedAgent: Boolean(childIdentity),
        joinPolicy,
        timeoutMs: this.subAgentBudget.agentTimeoutMs,
        drainOnStop: Boolean(childIdentity),
        workRunId,
        stepId: stepId || this.host.getTaskManager().getActiveTaskContext()?.taskId,
        run: async ({ signal, recordEvent, taskId }) => {
          const onSubEvent = (event: SubAgentEvent) => {
            recordEvent(event)
            this.emitSubAgentProgress(taskId, definition.id, definition.label, event)
          }
          if (childIdentity && this.childAgents && activeChildConfig) {
            let turns = 0
            return this.childAgents.execute({
              agentId: agentSessionId!, executionId: taskId, ownerSessionId: ownerSessionId || '',
              name: childIdentity.name, roleId: definition.id, roleLabel: definition.label,
              mode: childIdentity.mode,
              capabilityProfile: childCapabilityProfile(childIdentity.mode, parentChildConfig.capabilityProfile || 'workspace-write'),
              objective: enrichedObjective, instructions: definition.systemPrompt,
              model: activeChildConfig.defaultModel,
              reasoning: definition.thinking === undefined ? activeChildConfig.reasoning
                : definition.thinking === 'disabled' ? { enabled: false } : { enabled: true, effort: definition.thinking },
              limits: { maxToolRounds: definition.maxTurns, maxParallelTools: definition.maxParallel, maxOutputTokens: definition.maxOutputTokens, requestTimeoutMs: definition.requestTimeoutMs },
              requiredToolCalls: definition.requiredToolCalls,
              parentConfig: parentChildConfig, modelConfig: { ...activeChildConfig },
              beforeModelRequest: () => {
                const check = this.subAgentBudget.checkModelRequest({ ownerSessionId, workRunId, tasks: budgetTasks() })
                if (!check.allowed) throw new Error(check.reason + ' (' + check.code + ')')
              },
            }, signal, event => {
              if (event.type === 'model:request') recordEvent({ type: 'model_request', request: event.request })
              if (event.type === 'tool:call') onSubEvent({ type: 'tool_call', toolCallId: event.toolCall.id, tool: event.toolCall.name, args: event.toolCall.arguments, turn: turns + 1 })
              if (event.type === 'tool:result') onSubEvent({ type: 'tool_result', toolCallId: event.toolResult.toolCallId, tool: event.toolResult.name, ok: toolResultCallStatus(event.toolResult) === 'completed', summary: event.toolResult.output.slice(0, 500), turn: turns + 1 })
              if (event.type === 'turn:complete' && event.turn.role === 'assistant') {
                turns++
                onSubEvent({ type: 'turn_complete', turn: turns, calls: event.turn.toolCalls?.length || 0,
                  inputTokens: event.turn.metadata?.tokens?.input, outputTokens: event.turn.metadata?.tokens?.output,
                  cacheReadTokens: event.turn.metadata?.tokens?.cached })
              }
            })
          }
          throw new Error('Child model configuration is unavailable')
        },
        isSuccess: result => result.ok,
        getError: result => result.error || 'Subagent failed',
      })
    } catch (error) {
      if (admissionKey) this.admissions.delete(admissionKey)
      throw error
    }
    void started.promise.then(
      () => { if (admissionKey) this.admissions.delete(admissionKey) },
      () => { if (admissionKey) this.admissions.delete(admissionKey) },
    )
    this.host.emit({
      type: 'subagent:start',
      agentId: started.task.id,
      agentType: definition.id,
      label: definition.label,
      objective,
    })
    void started.promise.then(
      result => this.host.emit({
        type: 'subagent:end',
        agentId: started.task.id,
        agentType: definition.id,
        ok: result.ok && this.subAgentTaskManager.getTask(started.task.id)?.runtimeTask.status === 'completed',
        elapsedMs: Date.now() - startedAt,
      }),
      () => this.host.emit({
        type: 'subagent:end',
        agentId: started.task.id,
        agentType: definition.id,
        ok: false,
        elapsedMs: Date.now() - startedAt,
      }),
    )
    return started.task
  }

}
