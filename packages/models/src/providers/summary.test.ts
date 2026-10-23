import { describe, expect, it } from 'vitest'
import { readSummary } from './summary'
const sse = (...events: unknown[]) => events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}`).join('\n\n')
describe('summary responses from current streaming gateways', () => {
  it('reads complete Chat SSE and usage despite a non-stream request', () => {
    const response = readSummary('openai_chat', sse({ id: 'reply', choices: [{ delta: { content: '{"memories":[],' } }] },
      { choices: [{ delta: { content: '"summaries":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }, '[DONE]'))
    expect(response).toMatchObject({ structured: true, text: '{"memories":[],"summaries":[]}', responseId: 'reply' })
    expect(response.usage.at(-1)).toMatchObject({ input: 100, output: 20 })
  })
  it('reads Responses SSE through its current protocol parser', () => {
    const response = readSummary('openai_responses', sse({ type: 'response.output_text.delta', delta: '{"memories":[],"summaries":[]}' },
      { type: 'response.completed', response: { id: 'reply', status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } } }))
    expect(response.text).toContain('memories'); expect(response.structured).toBe(true)
  })
  it('reads Messages SSE and requires a completed message', () => {
    const response = readSummary('anthropic_messages', sse({ type: 'message_start', message: { id: 'msg', usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"memories":[],"summaries":[]}' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }))
    expect(response.text).toContain('memories'); expect(response.responseId).toBe('msg')
  })
  it('rejects interrupted streams instead of committing partial memory', () => {
    expect(() => readSummary('openai_chat', sse({ choices: [{ delta: { content: '{"memories":[]}' } }] }))).toThrow('incomplete')
    expect(() => readSummary('openai_chat', sse({ choices: [{ delta: { content: '{"memories":[]}' }, finish_reason: 'length' }] }, '[DONE]'))).toThrow('incomplete')
  })
})
