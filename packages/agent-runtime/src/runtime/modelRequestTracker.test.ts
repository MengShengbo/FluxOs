import { describe, expect, it, vi } from 'vitest'
import { ModelRequestTracker } from './modelRequestTracker'
import type { ModelRequestRecord } from '@fluxos/contracts/agentTypes'

const input={requestId:'logical',protocol:'openai_responses' as const,provider:'custom',model:'test',purpose:'turn' as const,serializedBody:'{"input":"private conversation","model":"test"}'}
describe('ModelRequestTracker',()=>{
  it('creates distinct physical attempts, isolates emitted data, and keeps unknown consumption',()=>{
    const events:ModelRequestRecord[]=[];const tracker=new ModelRequestTracker(r=>events.push(r))
    const failed=tracker.begin(input);const first=failed.finish('failed',400)
    const accepted=tracker.begin(input);accepted.usage({input:100,cached:80,output:10,source:'provider'});accepted.responseId('resp-1');const second=accepted.finish('completed',200)
    expect(first.id).not.toBe(second.id);expect(first.requestId).toBe(second.requestId)
    expect(first.usage).toEqual({source:'unknown'});expect(first.usageFinal).toBe(false)
    expect(second).toMatchObject({status:'completed',usageFinal:true,providerResponseId:'resp-1',usage:{input:100,cached:80,output:10}})
    const count=events.length;accepted.finish('failed');expect(events).toHaveLength(count)
    events.at(-1)!.usage.input=999;expect(second.usage.input).toBe(100)
    expect(JSON.stringify(events)).not.toContain('private conversation')
  })

  it('uses monotonic duration even when the wall clock moves backwards',()=>{
    const now=vi.spyOn(Date,'now');now.mockReturnValueOnce(10000).mockReturnValue(100)
    try{const record=new ModelRequestTracker(()=>{}).begin(input).finish('interrupted');expect(record.durationMs).toBeGreaterThanOrEqual(0)}finally{now.mockRestore()}
  })
})

it('records first semantic chunks once, without token-event amplification or private settings', () => {
  const events: ModelRequestRecord[] = []
  const attempt = new ModelRequestTracker(record => events.push(record)).begin({ ...input,
    serializedBody: JSON.stringify({ input: 'PRIVATE', max_output_tokens: 2000, reasoning: { effort: 'high' }, temperature: .5, api_key: 'SECRET' }),
  })
  attempt.outputChunk('answer', false)
  expect(attempt.record.outputTiming).toBeUndefined()
  attempt.outputChunk('reasoning', true)
  const first = attempt.record.outputTiming!.firstReasoningChunkMs
  for (let i = 0; i < 1000; i++) attempt.outputChunk('reasoning', true)
  attempt.outputChunk('tool', true)
  attempt.outputChunk('answer', true)
  expect(events).toHaveLength(1)
  const finished = attempt.finish('interrupted')
  expect(events).toHaveLength(2)
  expect(finished.outputTiming).toMatchObject({ firstOutputChunkMs: first, firstReasoningChunkMs: first })
  expect(finished.outputTiming!.firstAnswerChunkMs).toBeGreaterThanOrEqual(first!)
  expect(finished.requestSettings).toEqual({ maxOutputTokens: 2000, reasoningEffort: 'high', temperature: .5 })
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE|SECRET|api_key/)
  attempt.outputChunk('answer', true)
  expect(attempt.record.outputTiming).toEqual(finished.outputTiming)
})

it('captures Anthropic reasoning budget and leaves no-output failure latency unknown', () => {
  const attempt = new ModelRequestTracker(() => {}).begin({ ...input, serializedBody: JSON.stringify({ max_tokens: 100, thinking: { type: 'enabled', budget_tokens: 60 } }) })
  expect(attempt.finish('failed').outputTiming).toBeUndefined()
  expect(attempt.record.requestSettings).toEqual({ maxOutputTokens: 100, reasoningBudgetTokens: 60, thinkingType: 'enabled' })
})
