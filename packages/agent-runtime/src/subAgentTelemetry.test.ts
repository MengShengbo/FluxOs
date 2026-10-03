import { describe, expect, it } from 'vitest'
import type { ModelRequestRecord } from '@fluxagentcore/contracts/agentTypes'
import { SubAgentTelemetry } from './subAgentTelemetry'

const request = (id: string, patch: Partial<ModelRequestRecord> = {}): ModelRequestRecord => ({
  id, requestId: 'logical-request', purpose: 'turn', protocol: 'openai_responses',
  status: 'running', startedAt: 1, updatedAt: 1, usage: { source: 'unknown' }, usageFinal: false, ...patch,
})

describe('SubAgentTelemetry', () => {
  it('counts provider attempts, retries and protocol fallback without counting updates twice', () => {
    const telemetry = new SubAgentTelemetry()
    const events = [
      { type: 'model_request', request: request('first') },
      { type: 'model_request', request: request('first', { status: 'failed', updatedAt: 2 }) },
      { type: 'model_request', request: request('second', { protocol: 'openai_chat' }) },
      { type: 'model_request', request: request('second', { protocol: 'openai_chat', status: 'completed', updatedAt: 3, usageFinal: true, usage: { source: 'provider', input: 80, output: 12, cached: 50 } }) },
      { type: 'turn_complete', turn: 1, inputTokens: 80, outputTokens: 12 },
      { type: 'tool_result', toolCallId: 'read', ok: true },
      { type: 'tool_result', toolCallId: 'read', ok: true },
    ]
    events.forEach(event => telemetry.record(event))
    expect(telemetry.snapshot()).toMatchObject({ modelRequests: 2, retries: 1, protocolFallbacks: 1, inputTokens: 80, outputTokens: 12, cacheReadTokens: 50, toolExecutions: 1 })
    const replayed = new SubAgentTelemetry()
    JSON.parse(JSON.stringify(events)).forEach((event: unknown) => replayed.record(event))
    expect(replayed.snapshot()).toEqual(telemetry.snapshot())
  })

  it('keeps legacy usage valid without inventing usage for unknown modern requests', () => {
    const legacy = new SubAgentTelemetry()
    legacy.record({ type: 'turn_complete', turn: 1, inputTokens: 10, outputTokens: 2 })
    legacy.record({ type: 'turn_complete', turn: 1, inputTokens: 10, outputTokens: 2 })
    expect(legacy.snapshot()).toMatchObject({ turns: 1, inputTokens: 10, outputTokens: 2 })
    legacy.record({ type: 'model_request', request: request('unknown') })
    expect(legacy.snapshot()).toMatchObject({ modelRequests: 1, inputTokens: 0, outputTokens: 0 })
  })
})
