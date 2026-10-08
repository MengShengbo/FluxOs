import { describe, expect, it, vi } from 'vitest'
import { TaskManager } from './taskManager'
import type { ToolDispatchResult } from './runtime/toolDispatchResult'
import { AgentSessionRehydrator } from './runtime/agentSessionRehydrator'
import { dispatchTaskTool, type TaskSystemCreationEvent } from './taskToolDispatcher'

function createContext() {
  const taskManager = new TaskManager()
  const creations: Array<TaskSystemCreationEvent | null | undefined> = []
  const emitActiveTask = vi.fn()
  return {
    taskManager,
    creations,
    emitActiveTask,
    emitTaskSystem: (creation?: TaskSystemCreationEvent | null) => creations.push(creation),
  }
}

describe('task tool dispatcher', () => {
  it.each(['create_task', 'create_tasks'])('retains committed nodes when %s observers throw and stops further mutations', name => {
    const context = createContext()
    context.taskManager.subscribe(event => { if (event.type === 'task:created') throw new Error('fixture observer rejected after commit') })
    const first = { title: 'Committed before notification', description: 'Keep', priority: 'major' }
    const args = name === 'create_task' ? first : { tasks: [first, { ...first, title: 'Must not execute after observer failure' }] }
    const result = dispatchTaskTool(name, args, context) as ToolDispatchResult
    expect(result).toMatchObject({ isError: true, errorKind: 'execution', recovery: { effects: 'partial', retry: 'after_inspection' },
      data: { kind: 'tasks', status: 'partial', tasks: [expect.objectContaining({ title: first.title })], failures: [expect.objectContaining({ stage: 'execution' })] } })
    expect(context.taskManager.getAllTasks()).toHaveLength(1)
  })

  it.each([
    ['planning', 0], ['creating', 1], ['completed', 2], ['active', 2],
  ] as const)('retains exactly the committed batch when the %s notification fails', (stage, count) => {
    const context = createContext()
    const failure = () => { throw new Error(`fixture ${stage} observer`) }
    if (stage === 'active') context.emitActiveTask.mockImplementation(failure)
    else context.emitTaskSystem = event => { if (event?.status === stage) failure() }
    const result = dispatchTaskTool('create_tasks', { tasks: [
      { ref: 'one', title: 'First', description: 'First', priority: 'major' },
      { title: 'Second', description: 'Second', priority: 'major', dependencies: ['one'] },
    ] }, context) as ToolDispatchResult
    expect(result).toMatchObject({ isError: true, errorKind: 'execution', recovery: {
      effects: count ? 'partial' : 'none', retry: count ? 'after_inspection' : 'after_environment',
    }, data: { kind: 'tasks', status: count ? 'partial' : 'failed', tasks: context.taskManager.getAllTasks() } })
    expect(context.taskManager.getAllTasks()).toHaveLength(count)
    if (count === 2) expect(context.taskManager.getAllTasks()[1]!.dependencies).toEqual([context.taskManager.getAllTasks()[0]!.id])
  })

  it.each(['update_task', 'add_task_dependency', 'remove_task_dependency'])('keeps the actual %s mutation when its observer throws', name => {
    const context = createContext()
    const task = context.taskManager.createTask({ title: 'Target', description: 'Target', priority: 'major' })
    const dependency = context.taskManager.createTask({ title: 'Dependency', description: 'Dependency', priority: 'major' })
    if (name === 'remove_task_dependency') context.taskManager.addDependency(task.id, dependency.id)
    context.taskManager.subscribe(() => { throw new Error('fixture updated observer') })
    const result = dispatchTaskTool(name, { task_id: task.id, status: 'in_progress', progress: 20, dependency_id: dependency.id }, context) as ToolDispatchResult
    expect(result).toMatchObject({ isError: true, recovery: { effects: 'partial', retry: 'after_inspection' },
      data: { kind: 'tasks', tasks: [task], failures: [expect.objectContaining({ stage: 'execution' })] } })
    if (name === 'update_task') expect(task).toMatchObject({ status: 'in_progress', progress: 20 })
    else expect(task.dependencies).toEqual(name === 'add_task_dependency' ? [dependency.id] : [])
  })

  it('retains parent changes when a child creation observer fails and recovers the actual tree', () => {
    const context = createContext()
    const parent = context.taskManager.createTask({ title: 'Parent', description: 'Parent', priority: 'major' })
    context.taskManager.subscribe(() => { throw new Error('fixture parent observer') })
    const args = { title: 'Child', description: 'Child', priority: 'minor', parent_id: parent.id }
    const result = dispatchTaskTool('create_task', args, context) as ToolDispatchResult
    expect(result).toMatchObject({ isError: true, data: { kind: 'tasks', tasks: context.taskManager.getAllTasks() } })
    const rehydrator = new AgentSessionRehydrator()
    const messages = rehydrator.messagesFromTurns([
      { id: 'call', role: 'assistant', content: '', timestamp: 1, toolCalls: [{ id: 'child', name: 'create_task', arguments: args }] },
      { id: 'result', role: 'tool_result', content: '', timestamp: 2, toolResults: [{ ...result, toolCallId: 'child', name: 'create_task' }] },
    ])
    const restored = new TaskManager()
    rehydrator.rehydrateMessages(JSON.parse(JSON.stringify(messages)), { systemTurns: [], taskManager: restored })
    expect(restored.getAllTasks()).toHaveLength(2)
    expect(restored.getTask(parent.id)?.children).toEqual(parent.children)
    expect(restored.getTask(parent.children[0]!)?.parentId).toBe(parent.id)
  })

  it('replays only acknowledged nodes after a skipped first item and a later update', () => {
    const context = createContext()
    vi.spyOn(context.taskManager, 'createTask').mockImplementationOnce(() => { throw new Error('fixture creation interrupted') })
    const args = { tasks: [
      { ref: 'failed', title: 'Not created', description: 'Skip', priority: 'major' },
      { ref: 'kept', title: 'Keep original index', description: 'Retain', priority: 'major', dependencies: ['missing'] },
    ] }
    const created = dispatchTaskTool('create_tasks', args, context) as ToolDispatchResult
    expect(created).toMatchObject({ isError: true, errorKind: 'execution', recovery: { effects: 'partial', retry: 'after_inspection' },
      data: { status: 'partial', tasks: [expect.objectContaining({ title: 'Keep original index', dependencies: [] })],
        failures: [expect.objectContaining({ index: 0, stage: 'create' }), expect.objectContaining({ index: 1, stage: 'dependency' })] } })
    const id = context.taskManager.getAllTasks()[0]!.id
    const updateArgs = { task_id: id, status: 'completed' }
    const updated = dispatchTaskTool('update_task', updateArgs, context) as ToolDispatchResult
    const rehydrator = new AgentSessionRehydrator()
    const messages = rehydrator.messagesFromTurns([
      { id: 'call', role: 'assistant', content: '', timestamp: 1, toolCalls: [
        { id: 'create', name: 'create_tasks', arguments: args }, { id: 'update', name: 'update_task', arguments: updateArgs },
      ] },
      { id: 'result', role: 'tool_result', content: '', timestamp: 2, toolResults: [
        { ...created, toolCallId: 'create', name: 'create_tasks', output: 'Error: arbitrary display text' },
        { ...updated, toolCallId: 'update', name: 'update_task' },
      ] },
    ])
    const restored = new TaskManager()
    rehydrator.rehydrateMessages(JSON.parse(JSON.stringify(messages)), { systemTurns: [], taskManager: restored })
    expect(restored.getAllTasks()).toEqual([expect.objectContaining({ id, title: 'Keep original index', status: 'completed', dependencies: [] })])
    expect(context.creations.at(-1)?.status).toBe('error')
  })

  it('creates a dependency-aware task tree and reports lifecycle events', () => {
    const context = createContext()
    const root = JSON.parse((dispatchTaskTool('create_task', {
      title: 'Root',
      description: 'Root task',
      priority: 'major',
    }, context) as ToolDispatchResult).output) as { id: string }

    const result = JSON.parse((dispatchTaskTool('create_tasks', {
      tasks: [{
        ref: 'child',
        title: 'Child',
        description: 'Child task',
        priority: 'medium',
        parent_id: root.id,
      }],
    }, context) as ToolDispatchResult).output) as { created: Array<{ id: string }> }

    expect(result.created[0]?.id).toBeTruthy()
    expect(context.taskManager.getChildTasks(root.id)).toHaveLength(1)
    expect(context.creations.map(event => event?.status)).toEqual([
      'creating',
      'completed',
      'planning',
      'creating',
      'completed',
    ])
    expect(context.emitActiveTask).toHaveBeenCalledTimes(2)
  })

  it('keeps task guards and returns undefined for non-task tools', () => {
    const context = createContext()
    const root = JSON.parse((dispatchTaskTool('create_task', {
      title: 'Root',
      description: 'Root task',
      priority: 'major',
    }, context) as ToolDispatchResult).output) as { id: string }
    const child = JSON.parse((dispatchTaskTool('create_task', {
      title: 'Child',
      description: 'Child task',
      priority: 'medium',
      parent_id: root.id,
    }, context) as ToolDispatchResult).output) as { id: string }

    expect(dispatchTaskTool('update_task', {
      task_id: root.id,
      status: 'completed',
    }, context)).toMatchObject({ isError: true, errorKind: 'validation', output: expect.stringContaining('child task(s) remain unfinished') })
    expect(dispatchTaskTool('update_task', {
      task_id: child.id,
      status: 'completed',
    }, context)).toMatchObject({ isError: false, output: expect.stringContaining('"status":"completed"') })
    expect(dispatchTaskTool('unknown_tool', {}, context)).toBeUndefined()
  })
})
