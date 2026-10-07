export function withAnthropicMessageCacheControl(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return withRecentMessageCacheControl(messages, 2)
}

export function withOpenRouterCacheControl(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const withSystemCache = messages.map((message, index) => {
    if (index !== 0 || message.role !== 'system' || typeof message.content !== 'string') {
      return message
    }
    return {
      ...message,
      content: [{
        type: 'text',
        text: message.content,
        cache_control: { type: 'ephemeral' },
      }],
    }
  })
  return withLastMessageCacheControl(withSystemCache)
}

export function withLastMessageCacheControl(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return withRecentMessageCacheControl(messages, 1)
}

export function withRecentMessageCacheControl(
  messages: Array<Record<string, unknown>>,
  maxMessages: number,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = messages.map(message => ({
    ...message,
    content: Array.isArray(message.content) ? [...message.content] : message.content,
  }))

  let marked = 0
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'system') continue
    result[i] = addCacheControlToMessage(result[i])
    marked += 1
    if (marked >= maxMessages) break
  }

  return result
}

export function addCacheControlToMessage(message: Record<string, unknown>): Record<string, unknown> {
  const cacheControl = { type: 'ephemeral' }
  const content = message.content

  if (typeof content === 'string') {
    return {
      ...message,
      content: [{
        type: 'text',
        text: content,
        cache_control: cacheControl,
      }],
    }
  }

  if (Array.isArray(content)) {
    const blocks = content.map(block => (
      block && typeof block === 'object'
        ? { ...(block as Record<string, unknown>) }
        : block
    ))

    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]
      if (!block || typeof block !== 'object') continue
      const type = (block as Record<string, unknown>).type
      if (message.role === 'assistant' && (type === 'thinking' || type === 'redacted_thinking')) {
        continue
      }
      blocks[i] = {
        ...(block as Record<string, unknown>),
        cache_control: cacheControl,
      }
      return {
        ...message,
        content: blocks,
      }
    }
  }

  return message
}

export function extractStructuredReasoningDelta(delta: unknown, options?: { allowTypedText?: boolean }): string {
  if (!delta || typeof delta !== 'object') return ''
  const value = delta as Record<string, unknown>
  const candidates = [
    value.reasoning_content,
    value.reasoning,
    value.reasoning_text,
    value.thinking,
    value.thought,
  ]

  if (options?.allowTypedText && typeof value.type === 'string' && /reason|think|thought|analysis/i.test(value.type)) {
    candidates.push(value.text)
  }

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate
    }
  }
  return ''
}

