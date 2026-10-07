import type { ModelProtocol } from './modelProtocol'

export function extractModelResponseText(protocol: ModelProtocol, payload: unknown): string {
  let value: any = payload
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return value.trim()
    }
  }
  if (!value || typeof value !== 'object') return ''

  if (protocol === 'anthropic_messages') {
    return Array.isArray(value.content)
      ? value.content.filter((part: any) => typeof part?.text === 'string').map((part: any) => part.text).join('')
      : ''
  }
  if (protocol === 'openai_responses') {
    if (typeof value.output_text === 'string') return value.output_text
    return Array.isArray(value.output)
      ? value.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
        .filter((part: any) => typeof part?.text === 'string')
        .map((part: any) => part.text)
        .join('')
      : ''
  }
  const content = value.choices?.[0]?.message?.content
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((part: any) => typeof part?.text === 'string').map((part: any) => part.text).join('')
      : ''
}

