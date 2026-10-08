import { describe, expect, it } from 'vitest'
import { createWorkExecutionFixture } from '@fluxos/contracts/testing/workExecutionFixture'
import { ConversationEventNormalizer } from './conversationEventNormalizer'

describe('shared execution event contract', () => {
  it('emits the current typed execution update from the shared runtime snapshot', () => {
    const fixture = createWorkExecutionFixture()
    const run = fixture.snapshot.runs[0]
    const normalizer = new ConversationEventNormalizer(run.conversationId, run.conversationId, { now: () => 201 })
    normalizer.startRun({ runId: run.id, objective: run.objective, at: 200 })
    const events = normalizer.normalizeAgent({ type: 'work:execution', snapshot: fixture.snapshot })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'execution.updated', runId: run.id, payload: { update: fixture.update } })
    expect(events[0].type).not.toBe('runtime.event')
    expect(events[0].payload).not.toHaveProperty('tree')
  })

  it('keeps shared fixtures independent between consumers', () => {
    const first = createWorkExecutionFixture()
    first.snapshot.runs[0].rootStepIds.length = 0
    expect(first.update.runs[0].rootStepIds).toEqual(['fixture:step:1'])
    expect(createWorkExecutionFixture().snapshot.runs[0].rootStepIds).toEqual(['fixture:step:1'])
  })
})
