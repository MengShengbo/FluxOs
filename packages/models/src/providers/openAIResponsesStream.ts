import type { TokenUsage } from '@fluxos/contracts/agentTypes'
import type { ResponsesCustomToolInputs } from '../modelProtocol'
import {
  MAX_STREAM_REASONING_CHARS,
  MAX_STREAM_TEXT_CHARS,
  MAX_STREAM_TOOL_ARGUMENT_CHARS,
  appendBoundedString,
  extractResponsesReasoningEventDelta,
  extractResponsesReasoningSummary,
} from '../modelStream'

export interface OpenAIResponsesStreamToolCall {
  id: string
  name: string
  argumentsJson: string
}

export interface OpenAIResponsesStreamSnapshot {
  text: string
  reasoning: string
  toolCalls: OpenAIResponsesStreamToolCall[]
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  sawTerminalEvent: boolean
  streamFailure: string
  receivedData: boolean
}

export interface OpenAIResponsesStreamCallbacks {
  onTextDelta?: (text: string) => void
  onReasoningDelta?: (text: string) => void
  onToolCallDelta?: (toolCall: OpenAIResponsesStreamToolCall) => void
  onUsage?: (usage: TokenUsage) => void
  onResponseId?: (id: string) => void
}

export class OpenAIResponsesStreamParser {
  private textContent = ''
  private reasoningContent = ''
  private usage: TokenUsage = { source: 'unknown' }
  private inputTokens = 0
  private outputTokens = 0
  private reasoningTokens = 0
  private cacheReadTokens = 0
  private sawTerminalEvent = false
  private streamFailure = ''
  private receivedData = false
  private readonly toolCallMap = new Map<string, OpenAIResponsesStreamToolCall>()
  private readonly toolCallAliases = new Map<string, string>()
  private readonly customInputs = new Map<string, { text: string; complete: boolean }>()

  constructor(private readonly callbacks: OpenAIResponsesStreamCallbacks = {}, private readonly customToolInputs: ResponsesCustomToolInputs = {}) {}

  get hasReceivedData(): boolean {
    return this.receivedData
  }

  handleLine(line: string): void {
    this.receivedData = true
    if (!line.startsWith('data:')) return
    const json = line.slice(5).trim()
    if (!json || json === '[DONE]') return

    try {
      const event = JSON.parse(json) as Record<string, any>
      this.handleEvent(event)
    } catch {}
  }

  snapshot(): OpenAIResponsesStreamSnapshot {
    const incompleteCustom = [...this.customInputs.values()].some(input => !input.complete)
    return {
      text: this.textContent,
      reasoning: this.reasoningContent,
      toolCalls: [...this.toolCallMap.values()].map(toolCall => ({ ...toolCall })),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      reasoningTokens: this.reasoningTokens,
      cacheReadTokens: this.cacheReadTokens,
      sawTerminalEvent: this.sawTerminalEvent,
      streamFailure: this.streamFailure || (incompleteCustom ? 'Responses custom tool input is incomplete' : ''),
      receivedData: this.receivedData,
    }
  }

  private handleEvent(event: Record<string, any>): void {
    const eventType = event.type
    if (typeof event.response?.id === 'string') this.callbacks.onResponseId?.(event.response.id)
    const reasoningDelta = extractResponsesReasoningEventDelta(event)
    if (reasoningDelta) {
      const accepted = appendBoundedString(
        '',
        reasoningDelta,
        Math.max(0, MAX_STREAM_REASONING_CHARS - this.reasoningContent.length),
      )
      this.reasoningContent += accepted
      if (accepted) this.callbacks.onReasoningDelta?.(accepted)
      return
    }

    if (eventType === 'response.output_text.delta' || eventType === 'response.refusal.delta') {
      if (typeof event.delta === 'string' && event.delta) {
        const accepted = appendBoundedString(
          '',
          event.delta,
          Math.max(0, MAX_STREAM_TEXT_CHARS - this.textContent.length),
        )
        this.textContent += accepted
        if (accepted) this.callbacks.onTextDelta?.(accepted)
      }
      return
    }

    if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
      if (event.item?.type === 'function_call' || event.item?.type === 'custom_tool_call') {
        this.ensureToolCall(event.item, event.output_index, eventType === 'response.output_item.done')
      }
      return
    }

    if (eventType === 'response.function_call_arguments.delta' || eventType === 'response.function_call_arguments.done') {
      this.handleToolCallArguments(event, eventType.endsWith('.done'))
      return
    }

    if (eventType === 'response.custom_tool_call_input.delta' || eventType === 'response.custom_tool_call_input.done') {
      this.handleToolCallArguments(event, eventType.endsWith('.done'), true)
      return
    }

    if (eventType === 'response.completed') {
      this.sawTerminalEvent = true
      this.harvestCompletedOutput(event.response)
      return
    }

    if (eventType === 'response.incomplete' || eventType === 'response.failed') {
      this.sawTerminalEvent = true
      this.harvestCompletedOutput(event.response)
      this.streamFailure = event.response?.error?.message
        || event.response?.incomplete_details?.reason
        || `${eventType}: provider did not complete the response`
      return
    }

    if (eventType === 'error') {
      this.sawTerminalEvent = true
      this.streamFailure = event.error?.message || event.message || 'Responses stream returned an error event'
    }
  }

  private ensureToolCall(item: Record<string, any>, outputIndex?: number, complete = false): OpenAIResponsesStreamToolCall {
    const id = typeof item.call_id === 'string' && item.call_id
      ? item.call_id
      : typeof item.id === 'string' && item.id
        ? item.id
        : `call_${outputIndex ?? this.toolCallMap.size}`
    const aliases = [item.id, item.call_id, typeof outputIndex === 'number' ? `idx-${outputIndex}` : undefined]
      .filter((alias): alias is string => typeof alias === 'string')
    const priorId = aliases.map(alias => this.toolCallAliases.get(alias) || alias).find(alias => this.toolCallMap.has(alias))
    let entry = this.toolCallMap.get(id) || (priorId ? this.toolCallMap.get(priorId) : undefined)
    if (entry && entry.id !== id) {
      this.toolCallMap.delete(entry.id)
      const custom = this.customInputs.get(entry.id)
      if (custom) { this.customInputs.delete(entry.id); this.customInputs.set(id, custom) }
      for (const [alias, target] of this.toolCallAliases) if (target === entry.id) this.toolCallAliases.set(alias, id)
      entry.id = id
      this.toolCallMap.set(id, entry)
    }
    if (!entry) {
      entry = {
        id,
        name: typeof item.name === 'string' ? item.name : '',
        argumentsJson: typeof item.arguments === 'string' ? item.arguments : '',
      }
      this.toolCallMap.set(id, entry)
    } else {
      if (typeof item.name === 'string' && item.name) entry.name = item.name
      if (typeof item.arguments === 'string' && item.arguments) entry.argumentsJson = item.arguments
    }
    if (item.type === 'custom_tool_call' || this.customInputs.has(id)) {
      const prior = this.customInputs.get(id)
      const input = typeof item.input === 'string' && (item.input || complete || !prior) ? item.input : prior?.text || ''
      this.setCustomInput(entry, input, complete || prior?.complete === true)
    }
    if (typeof item.id === 'string') this.toolCallAliases.set(item.id, id)
    if (typeof item.call_id === 'string') this.toolCallAliases.set(item.call_id, id)
    if (typeof outputIndex === 'number') this.toolCallAliases.set(`idx-${outputIndex}`, id)
    return entry
  }

  private handleToolCallArguments(event: Record<string, any>, complete: boolean, custom = false): void {
    const alias = typeof event.item_id === 'string'
      ? event.item_id
      : typeof event.call_id === 'string'
        ? event.call_id
        : `idx-${event.output_index ?? 0}`
    const canonicalId = this.toolCallAliases.get(alias) || alias
    const entry = this.toolCallMap.get(canonicalId)
      || this.ensureToolCall({ call_id: canonicalId, name: event.name || '', ...(custom ? { type: 'custom_tool_call' } : {}) }, event.output_index)
    if (custom) {
      const text = complete && typeof event.input === 'string' ? event.input
        : (this.customInputs.get(entry.id)?.text || '') + (typeof event.delta === 'string' ? event.delta : '')
      this.setCustomInput(entry, text, complete)
    } else if (complete && typeof event.arguments === 'string') {
      entry.argumentsJson = event.arguments
    } else if (typeof event.delta === 'string') {
      entry.argumentsJson = appendBoundedString(entry.argumentsJson, event.delta, MAX_STREAM_TOOL_ARGUMENT_CHARS)
    }
    this.callbacks.onToolCallDelta?.({ ...entry })
  }

  private setCustomInput(entry: OpenAIResponsesStreamToolCall, text: string, complete: boolean): void {
    if (text.length > MAX_STREAM_TOOL_ARGUMENT_CHARS) {
      this.streamFailure = 'Responses custom tool input exceeds the stream character limit'
      text = text.slice(0, MAX_STREAM_TOOL_ARGUMENT_CHARS)
    }
    this.customInputs.set(entry.id, { text, complete })
    if (!entry.name) return // A delta may arrive before its named output item.
    if (!Object.prototype.hasOwnProperty.call(this.customToolInputs, entry.name)) {
      this.streamFailure = `Responses custom tool is not enabled: ${entry.name}`
      return
    }
    entry.argumentsJson = JSON.stringify({ [this.customToolInputs[entry.name]]: text })
  }

  private updateUsage(usage: Record<string, any> | undefined): void {
    if (!usage) return
    const numeric = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
    if (numeric(usage.input_tokens)) this.usage.input = this.inputTokens = usage.input_tokens
    if (numeric(usage.output_tokens)) this.usage.output = this.outputTokens = usage.output_tokens
    const reasoning = usage.output_tokens_details?.reasoning_tokens
    if (numeric(reasoning)) this.usage.reasoning = this.reasoningTokens = reasoning
    const cached = usage.input_tokens_details?.cached_tokens
    if (numeric(cached)) this.usage.cached = this.cacheReadTokens = cached
    const written = usage.input_tokens_details?.cache_write_tokens
    if (numeric(written)) this.usage.cacheWrite = written
    if (this.usage.input === undefined && this.usage.output === undefined) return
    this.usage.source = 'provider'
    if (this.usage.input !== undefined && this.usage.output !== undefined) this.usage.total = this.usage.input + this.usage.output
    this.callbacks.onUsage?.({ ...this.usage })
  }

  private harvestCompletedOutput(response: Record<string, any> | undefined): void {
    this.updateUsage(response?.usage)
    if (!Array.isArray(response?.output)) return
    const completedReasoning = extractResponsesReasoningSummary(response.output)
    if (completedReasoning && completedReasoning !== this.reasoningContent) {
      const delta = completedReasoning.startsWith(this.reasoningContent)
        ? completedReasoning.slice(this.reasoningContent.length)
        : this.reasoningContent
          ? `\n\n${completedReasoning}`
          : completedReasoning
      const accepted = appendBoundedString(
        '',
        delta,
        Math.max(0, MAX_STREAM_REASONING_CHARS - this.reasoningContent.length),
      )
      this.reasoningContent += accepted
      if (accepted) this.callbacks.onReasoningDelta?.(accepted)
    }
    for (const item of response.output) {
      if (!item || typeof item !== 'object') continue
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        this.ensureToolCall(item, undefined, true)
        continue
      }
      if (item.type !== 'message' || this.textContent) continue
      const completedText = Array.isArray(item.content)
        ? item.content
            .filter((part: any) => part?.type === 'output_text' && typeof part.text === 'string')
            .map((part: any) => part.text)
            .join('')
        : ''
      if (!completedText) continue
      const accepted = appendBoundedString(
        '',
        completedText,
        Math.max(0, MAX_STREAM_TEXT_CHARS - this.textContent.length),
      )
      this.textContent += accepted
      if (accepted) this.callbacks.onTextDelta?.(accepted)
    }
  }
}
