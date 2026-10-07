import { describe, expect, it } from 'vitest'
import { getToolsForMode } from '@fluxos/tools/toolRegistry'
import { toolsToAnthropicFormat, toolsToOpenAIFormat } from '@fluxos/models/toolSchemas'

describe('declared tool catalog contracts', () => {
  it.each(['plan', 'vibe'] as const)('preserves the legitimate %s tool surface across protocol adapters', mode => {
    const expected = getToolsForMode(mode).map(tool => tool.name)
    const chat = toolsToOpenAIFormat(getToolsForMode(mode)) as Array<{ function: { name: string } }>
    const messages = toolsToAnthropicFormat(getToolsForMode(mode)) as Array<{ name: string }>
    expect(chat.map(tool => tool.function.name)).toEqual(expected)
    expect(messages.map(tool => tool.name)).toEqual(expected)
    for (const name of ['read_file', 'search_content', 'tool_search', 'ask_user', 'read_agent']) expect(expected).toContain(name)
    if (mode === 'vibe') for (const name of ['apply_patch', 'run_command', 'spawn_agent', 'write_file']) expect(expected).toContain(name)
    else expect(getToolsForMode(mode).every(tool => tool.isReadOnly)).toBe(true)
  })
})
