
export function normalizeConversationTitleText(value: unknown, maxLength = 80): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
}

export function generatedConversationTitle(value: unknown, maxLength = 60): string {
  if (typeof value !== 'string') return ''

  return normalizeConversationTitleText(value, maxLength)
}
