import { toolFailure, type ToolDispatchOutput } from './runtime/toolDispatchResult'
import type { TaskNode, TaskPriority, TaskStatus } from '@fluxos/contracts/agentTypes'
import { toolRecovery, type TaskMutationReceipt } from '@fluxos/contracts/toolResultData'
import { TaskManager, TaskNotificationError } from './taskManager'

export type TaskSystemCreationEvent = {
  status: 'planning' | 'creating' | 'completed' | 'error'
  toolName?: string
  expectedCount?: number
  createdCount?: number
  title?: string
  startedAt?: number
  updatedAt: number
  error?: string
}

export interface TaskToolDispatchContext {
  taskManager: TaskManager
  emitTaskSystem(creation?: TaskSystemCreationEvent | null): void
  emitActiveTask(): void
}

function taskMutationOutput(output: string, tasks: TaskNode[], failures: TaskMutationReceipt['failures'] = []): Exclude<ToolDispatchOutput, string> {
  const isError = failures.length > 0
  const errorKind = failures.some(failure => failure.errorKind === 'execution') ? 'execution' : 'validation'
  return { output, isError,
    data: { kind: 'tasks', status: isError ? tasks.length ? 'partial' : 'failed' : 'completed', tasks: structuredClone(tasks), failures },
    ...(isError ? { errorKind, recovery: toolRecovery(errorKind, tasks.length ? 'partial' : 'none') } : {}),
  }
}

export function dispatchTaskTool(
  name: string,
  args: Record<string, unknown>,
  context: TaskToolDispatchContext,
): ToolDispatchOutput | undefined {
  const mutates = ['create_task', 'create_tasks', 'update_task', 'add_task_dependency', 'remove_task_dependency'].includes(name)
  // Notifications may throw after a mutation, including updates to a parent.
  // Snapshot values, not live TaskNode references, to retain those effects.
  const before = mutates ? new Map(context.taskManager.getAllTasks().map(task => [task.id, JSON.stringify(task)])) : undefined
  const progress = { index: 0, failures: [] as TaskMutationReceipt['failures'] }
  try {
    return dispatchTaskToolImpl(name, args, context, progress)
  } catch (error) {
    if (!before) throw error
    const tasks = context.taskManager.getAllTasks().filter(task => before.get(task.id) !== JSON.stringify(task))
    const message = error instanceof Error ? error.message : String(error)
    return taskMutationOutput(message, tasks, [...progress.failures, { index: progress.index, stage: 'execution', errorKind: 'execution', message }])
  }
}

function dispatchTaskToolImpl(
  name: string,
  args: Record<string, unknown>,
  context: TaskToolDispatchContext,
  progress: { index: number; failures: TaskMutationReceipt['failures'] },
): ToolDispatchOutput | undefined {
  if (name === 'create_task') {
    const creationStartedAt = Date.now()
    context.emitTaskSystem({
      status: 'creating',
      toolName: 'create_task',
      expectedCount: 1,
      createdCount: 0,
      title: args.title as string | undefined,
      startedAt: creationStartedAt,
      updatedAt: creationStartedAt,
    })
    const task = context.taskManager.createTask({
      title: args.title as string,
      description: args.description as string,
      priority: args.priority as TaskPriority,
      parentId: args.parent_id as string | undefined,
      order: args.order as number | undefined,
      metadata: args.metadata as TaskNode['metadata'] | undefined,
    })
    const dependencies = args.dependencies as string[] | undefined
    if (dependencies && dependencies.length > 0) {
      const failed: string[] = []
      for (const dependencyId of dependencies) {
        if (!context.taskManager.addDependency(task.id, dependencyId)) failed.push(dependencyId)
      }
      if (failed.length > 0) {
        context.emitTaskSystem({
          status: 'error',
          toolName: 'create_task',
          expectedCount: 1,
          createdCount: 1,
          title: task.title,
          startedAt: creationStartedAt,
          updatedAt: Date.now(),
          error: `Some dependencies could not be added: ${failed.join(', ')}`,
        })
        context.emitActiveTask()
        return taskMutationOutput(JSON.stringify({
          id: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          dependencies: task.dependencies,
          warning: `Some dependencies could not be added (tasks not found or would create cycle): ${failed.join(', ')}`,
        }), [task], failed.map(dependencyId => ({ index: 0, stage: 'dependency', errorKind: 'validation', taskId: task.id, message: `Dependency not added: ${dependencyId}` })))
      }
    }
    context.emitTaskSystem({
      status: 'completed',
      toolName: 'create_task',
      expectedCount: 1,
      createdCount: 1,
      title: task.title,
      startedAt: creationStartedAt,
      updatedAt: Date.now(),
    })
    context.emitActiveTask()
    return taskMutationOutput(JSON.stringify({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      dependencies: task.dependencies,
    }), [task])
  }

  if (name === 'create_tasks') {
    const items = args.tasks as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(items) || items.length === 0) return toolFailure("Error: 'tasks' must be a non-empty array", 'validation', 'none')

    const creationStartedAt = Date.now()
    context.emitTaskSystem({
      status: 'planning',
      toolName: 'create_tasks',
      expectedCount: items.length,
      createdCount: 0,
      title: items.length === 1 ? String(items[0]?.title || 'Task') : `${items.length} tasks`,
      startedAt: creationStartedAt,
      updatedAt: creationStartedAt,
    })
    const refToId = new Map<string, string>()
    const resolveReference = (value: unknown): string | undefined => {
      if (typeof value !== 'string' || !value) return undefined
      return refToId.get(value) ?? value
    }
    const created: Array<{ id: string; ref?: string; title: string; status: TaskStatus; priority: TaskPriority }> = []
    const warnings: string[] = []
    const failures = progress.failures

    for (let index = 0; index < items.length; index += 1) {
      progress.index = index
      const raw = items[index] || {}
      const title = raw.title as string | undefined
      const description = raw.description as string | undefined
      const priority = raw.priority as TaskPriority | undefined
      if (!title || !description || !priority) {
        warnings.push(`tasks[${index}]: missing required field (title/description/priority)`)
        failures.push({ index, stage: 'create', errorKind: 'validation', message: warnings.at(-1)! })
        continue
      }

      let task: TaskNode
      try {
        task = context.taskManager.createTask({
          title,
          description,
          priority,
          parentId: resolveReference(raw.parent_id),
          order: raw.order as number | undefined,
          metadata: raw.metadata as TaskNode['metadata'] | undefined,
        })
      } catch (error) {
        // A committed task must not disappear from the receipt, and a broken
        // observer must stop this batch before further mutations are attempted.
        if (error instanceof TaskNotificationError) throw error
        warnings.push(`tasks[${index}] (${title}): ${(error as Error).message}`)
        failures.push({ index, stage: 'create', errorKind: 'execution', message: warnings.at(-1)! })
        continue
      }

      const localReference = typeof raw.ref === 'string' ? raw.ref : undefined
      if (localReference) refToId.set(localReference, task.id)
      const dependencies = raw.dependencies as unknown[] | undefined
      if (Array.isArray(dependencies)) {
        for (const dependencyReference of dependencies) {
          const dependencyId = resolveReference(dependencyReference)
          if (!dependencyId || !context.taskManager.addDependency(task.id, dependencyId)) {
            warnings.push(`tasks[${index}] (${title}): dependency '${String(dependencyReference)}' not added`)
            failures.push({ index, stage: 'dependency', errorKind: 'validation', taskId: task.id, message: warnings.at(-1)! })
          }
        }
      }
      created.push({ id: task.id, ref: localReference, title: task.title, status: task.status, priority: task.priority })
      context.emitTaskSystem({
        status: 'creating',
        toolName: 'create_tasks',
        expectedCount: items.length,
        createdCount: created.length,
        title: task.title,
        startedAt: creationStartedAt,
        updatedAt: Date.now(),
      })
    }

    context.emitTaskSystem({
      status: warnings.length > 0 ? 'error' : 'completed',
      toolName: 'create_tasks',
      expectedCount: items.length,
      createdCount: created.length,
      title: created.at(-1)?.title || `${items.length} tasks`,
      startedAt: creationStartedAt,
      updatedAt: Date.now(),
      error: warnings.length > 0 ? warnings.slice(0, 2).join('; ') : undefined,
    })
    context.emitActiveTask()
    return taskMutationOutput(JSON.stringify(warnings.length > 0 ? { created, warnings } : { created }),
      created.map(task => context.taskManager.getTask(task.id)!), failures)
  }

  if (name === 'update_task') {
    const taskId = args.task_id as string
    if (args.status === 'in_progress') {
      const existing = context.taskManager.getTask(taskId)
      if (existing && !context.taskManager.areDependenciesMet(taskId)) {
        const blocked = existing.dependencies.filter(dependencyId => {
          const dependency = context.taskManager.getTask(dependencyId)
          return dependency && dependency.status !== 'completed'
        })
        if (blocked.length > 0) return toolFailure(`Error: cannot start task ${taskId} — dependencies not met: ${blocked.join(', ')}`, 'validation', 'none')
      }
    }
    if (args.status === 'completed') {
      const blocker = context.taskManager.getCompletionBlocker(taskId)
      if (blocker) return toolFailure('Error: cannot complete task ' + taskId + '. ' + blocker, 'validation', 'none')
      const existing = context.taskManager.getTask(taskId)
      if (existing && existing.children.length > 0) {
        const pending = context.taskManager.getChildTasks(taskId).filter(task => task.status !== 'completed')
        if (pending.length > 0) {
          const titles = pending.slice(0, 4).map(task => `${task.id} (${task.status})`).join(', ')
          return toolFailure(`Error: cannot mark parent task ${taskId} as completed while ${pending.length} child task(s) remain unfinished: ${titles}${pending.length > 4 ? ', ...' : ''}. Complete or fail the children first.`, 'validation', 'none')
        }
      }
    }
    const task = context.taskManager.updateTask(taskId, {
      status: args.status as TaskStatus,
      progress: args.progress as number | undefined,
      error: args.error as string | undefined,
    })
    if (!task) return toolFailure(`Error: task ${taskId} not found`, 'validation', 'none')
    context.emitActiveTask()
    return taskMutationOutput(JSON.stringify({ id: task.id, title: task.title, status: task.status, progress: task.progress }), [task])
  }

  if (name === 'add_task_dependency') {
    const ok = context.taskManager.addDependency(args.task_id as string, args.dependency_id as string)
    if (!ok) return toolFailure('Error: failed to add dependency. Check that both tasks exist, the dependency is not a self-reference, and no cycle would be created.', 'validation', 'none')
    context.emitActiveTask()
    return taskMutationOutput(`Dependency added: ${args.task_id} now depends on ${args.dependency_id}`, [context.taskManager.getTask(args.task_id as string)!])
  }

  if (name === 'remove_task_dependency') {
    const ok = context.taskManager.removeDependency(args.task_id as string, args.dependency_id as string)
    if (!ok) return toolFailure('Error: failed to remove dependency', 'validation', 'none')
    context.emitActiveTask()
    return taskMutationOutput(`Dependency removed: ${args.task_id} no longer depends on ${args.dependency_id}`, [context.taskManager.getTask(args.task_id as string)!])
  }

  if (name === 'list_tasks') {
    const tasks = (args.parent_id
      ? context.taskManager.getChildTasks(args.parent_id as string)
      : context.taskManager.getAllTasks())
      .filter(task => !args.status || task.status === args.status)
    return JSON.stringify(tasks.map(task => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      progress: task.progress,
      children: task.children.length,
    })))
  }

  return undefined
}
