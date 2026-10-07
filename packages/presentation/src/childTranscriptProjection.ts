import type { AgentTurn, ToolCall, ToolResult } from '@fluxos/contracts/agentTypes'
import type { ChildTranscriptItem } from '@fluxos/contracts/childAgentTypes'

export interface ChildToolActivity {
  call: ToolCall
  result?: ToolResult
}
export type ChildConversationItem =
  | { id: string; kind: 'message'; turn: AgentTurn }
  | { id: string; kind: 'tools'; tools: ChildToolActivity[] }

/** Runtime events are evidence, not individual chat bubbles. Preserve public
 * messages and group adjacent work, joining results by toolCallId even when
 * status events or pagination split a call/result pair.
 */
export function projectChildTranscript(records: readonly ChildTranscriptItem[]): ChildConversationItem[] {
  const items: ChildConversationItem[] = []
  const tools = new Map<string, ChildToolActivity>()
  const messageIds = new Set<string>()
  let group: Extract<ChildConversationItem, { kind: 'tools' }> | undefined
  let executionId: string | undefined
  for (const record of records) {
    if (record.executionId !== executionId) { group = undefined; executionId = record.executionId }
    if (record.kind === 'status') continue
    if (record.kind === 'message') {
      const turn = record.turn
      if (turn.metadata?.internal || (!turn.content.trim() && !turn.metadata?.thinking?.content) || messageIds.has(turn.id)) continue
      messageIds.add(turn.id)
      items.push({ id: record.id, kind: 'message', turn })
      group = undefined
      continue
    }
    const name = record.kind === 'tool_call' ? record.toolCall.name : record.toolResult.name
    if (name === 'set_response_mode') continue
    const callId = record.kind === 'tool_call' ? record.toolCall.id : record.toolResult.toolCallId
    const key = record.executionId + ':' + callId
    let activity = tools.get(key)
    if (!activity) {
      activity = { call: record.kind === 'tool_call' ? record.toolCall : { id: callId, name, arguments: {} } }
      tools.set(key, activity)
      if (!group) {
        group = { id: 'child-tools:' + key, kind: 'tools', tools: [] }
        items.push(group)
      }
      group.tools.push(activity)
    }
    if (record.kind === 'tool_call') activity.call = record.toolCall
    else activity.result = record.toolResult
  }
  return items
}

export function childToolGroupLabel(tools: readonly ChildToolActivity[]): string {
  const counts = new Map<string, number>()
  for (const { call } of tools) {
    const verb = ['read_file', 'read_file_full', 'list_directory', 'read_web_source'].includes(call.name) ? '读取'
      : ['search_files', 'search_content', 'web_search'].includes(call.name) ? '搜索'
      : call.name === 'web_fetch' || call.name.startsWith('browser__') ? '浏览网页'
      : call.name.startsWith('computer__') ? '操作电脑'
      : call.name === 'run_command' ? '运行命令'
      : ['write_file', 'replace_file', 'edit_file', 'multi_edit', 'apply_patch'].includes(call.name) ? '编辑文件'
      : '使用工具'
    counts.set(verb, (counts.get(verb) || 0) + 1)
  }
  const settled = tools.every(tool => tool.result)
  const text = [...counts].map(([verb, count]) => verb + (count > 1 ? ` ${count} 次` : '')).join('、')
  const failures = tools.filter(tool => tool.result?.isError).length
  return (settled ? '已' : '正在') + text + (failures ? ` · ${failures} 项未完成` : '')
}
