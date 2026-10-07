import type { TaskNode } from '@fluxos/contracts/agentTypes'
import type { SubAgentTaskSnapshot } from './runtime/subAgentTaskManager'
import { TaskManager } from './taskManager'

const TERMINAL = new Set(['completed', 'failed', 'stopped', 'interrupted', 'orphaned'])

/** A retry replaces only its own predecessor, not other children of the step. */
export function effectiveRequiredChildren(children: readonly SubAgentTaskSnapshot[]): SubAgentTaskSnapshot[] {
  const required = children.filter(child => child.joinPolicy === 'required')
  const superseded = new Set(required.flatMap(child => {
    const previous = required.find(candidate => candidate.id === child.retryOf)
    return previous && previous.ownerSessionId === child.ownerSessionId && previous.workRunId === child.workRunId && previous.stepId === child.stepId
      ? [previous.id] : []
  }))
  return required.filter(child => !superseded.has(child.id))
}

export function childCompletionBlocker(
  task: TaskNode, manager: TaskManager, children: readonly SubAgentTaskSnapshot[], pendingAgentIds: ReadonlySet<string>,
): string | null {
  const descendants = new Set<string>()
  const visit = (node: TaskNode) => {
    if (descendants.has(node.id)) return
    descendants.add(node.id)
    manager.getChildTasks(node.id).forEach(visit)
  }
  visit(task)
  const blocked = effectiveRequiredChildren(children).filter(child => child.stepId && descendants.has(child.stepId)
    && (child.runtimeTask.status !== 'completed' || pendingAgentIds.has(child.id)))
  return blocked.length ? 'Required child results are not resolved: ' + blocked.map(child => child.id + ' (' + child.runtimeTask.status + ')').join(', ')
    + '. Wait for running children, consume their results, retry failed children, or explicitly detach obsolete work.' : null
}

/** Project child outcomes onto their original step at a safe parent boundary.
 * Success never automatically closes the step; finalization/explicit acceptance
 * still owns that transition and its completion guard checks all siblings.
 */
export function reconcileSubAgentSteps(manager: TaskManager, children: readonly SubAgentTaskSnapshot[]): void {
  const byStep = new Map<string, SubAgentTaskSnapshot[]>()
  for (const child of children) {
    if (!child.stepId || !manager.getTask(child.stepId)) continue
    const group = byStep.get(child.stepId) || []
    group.push(child)
    byStep.set(child.stepId, group)
  }
  for (const [stepId, group] of byStep) {
    const task = manager.getTask(stepId)!
    const outcomes = group.map(child => ({ agentId: child.id, status: child.runtimeTask.status, joinPolicy: child.joinPolicy, retryOf: child.retryOf }))
    const failed = effectiveRequiredChildren(group).filter(child => TERMINAL.has(child.runtimeTask.status) && child.runtimeTask.status !== 'completed')
    const ownsFailure = task.metadata?.subAgentFailure === true
    const status = failed.length ? 'failed' : ownsFailure && task.status === 'failed' ? 'in_progress' : undefined
    const error = failed.length ? 'Required child work did not complete: ' + failed.map(child => child.id + ' (' + child.runtimeTask.status + ')').join(', ') : undefined
    if (JSON.stringify(task.metadata?.subAgentOutcomes) === JSON.stringify(outcomes) && (!status || task.status === status)) continue
    manager.updateTask(stepId, {
      ...(task.metadata?.workControlOutcome ? {} : { status, error }),
      metadata: { subAgentOutcomes: outcomes, subAgentFailure: failed.length > 0 && (!task.error || ownsFailure || task.status !== 'failed') },
    })
  }
}
