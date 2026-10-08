import type { WorkExecutionSnapshot, WorkExecutionUpdate, WorkRun } from '../workExecutionTypes'

/** Browser-safe conformance data shared by kernel and product tests. No runtime adapter. */
export function createWorkExecutionFixture(options: {
  conversationId?: string
  runId?: string
  stepId?: string
  title?: string
} = {}): { snapshot: WorkExecutionSnapshot; update: WorkExecutionUpdate } {
  const runId = options.runId ?? 'fixture:run:1'
  const stepId = options.stepId ?? 'fixture:step:1'
  const run: WorkRun = {
    id: runId, conversationId: options.conversationId ?? 'fixture-conversation', objective: 'Verify execution replay',
    presentation: 'work', responseMode: 'task', status: 'running', phase: 'execute',
    rootStepIds: [stepId],
    steps: {
      [stepId]: {
        id: stepId, runId, title: options.title ?? 'Read workspace', description: 'Verify current execution facts',
        status: 'running', parentId: null, childIds: [], dependencyIds: [], order: 0,
        progress: null, progressMode: 'indeterminate', activityIds: [], createdAt: 200, updatedAt: 201, startedAt: 201,
      },
    },
    activities: {}, startedAt: 200, updatedAt: 201, executionSegments: [{ startedAt: 200 }],
  }
  return {
    snapshot: { schemaVersion: 1, currentRunId: runId, runs: [structuredClone(run)] },
    update: { currentRunId: runId, retainedRunIds: [runId], runs: [structuredClone(run)], removedActivityIds: { [runId]: [] } },
  }
}
