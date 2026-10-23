import { describe, expect, it } from 'vitest'
import { generatedConversationTitle, normalizeConversationTitleText } from './conversationTitle'

describe('conversation title generation', () => {
  it('normalizes ordinary titles and respects the length limit', () => {
    expect(generatedConversationTitle('  Plan\nnext release  ')).toBe('Plan next release')
    expect(normalizeConversationTitleText('abcdefgh', 4)).toBe('abcd')
    expect(generatedConversationTitle(null)).toBe('')
  })
})
