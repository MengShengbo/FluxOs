import type { ToolAccessContract, ToolResourceAccess } from '@fluxos/contracts/toolAccess'

// Exact tool names, not command-prefix inference. Dynamic effects remain unknown.
const resources = new Map<string, readonly ToolResourceAccess[]>()
function declare(names: string, ...access: ToolResourceAccess[]): void {
  for (const name of names.split(' ')) {
    if (resources.has(name)) throw new Error(`Duplicate tool access declaration: ${name}`)
    resources.set(name, access)
  }
}
declare('read_file read_file_full list_directory', { kind: 'filesystem', access: 'read', scope: 'workspace', argument: 'path' })
declare('search_files search_content', { kind: 'filesystem', access: 'read', scope: 'workspace', argument: 'path' })
declare('code_navigation', { kind: 'filesystem', access: 'read', scope: 'workspace' })
declare('write_file replace_file edit_file multi_edit delete_file', { kind: 'filesystem', access: 'write', scope: 'workspace', argument: 'path' })
declare('apply_patch', { kind: 'filesystem', access: 'write', scope: 'workspace', argument: 'patch' })
declare('web_search web_fetch', { kind: 'network', access: 'read', scope: 'external' }, { kind: 'memory', access: 'write', scope: 'run' })
declare('read_web_source', { kind: 'memory', access: 'read', scope: 'run', argument: 'source_id' })
declare('read_tool_result', { kind: 'memory', access: 'read', scope: 'run', argument: 'source_id' })
declare('tool_search use_skill', { kind: 'session', access: 'write', scope: 'run' })
declare('list_memories', { kind: 'memory', access: 'read', scope: 'profile' })
declare('remember forget', { kind: 'memory', access: 'write', scope: 'profile' })
declare('git_status git_diff git_log git_show', { kind: 'repository', access: 'read', scope: 'workspace' })
declare('git_stage git_commit git_restore git_revert git_create_branch git_switch_branch git_stash', { kind: 'repository', access: 'write', scope: 'workspace' })
declare('git_push', { kind: 'repository', access: 'read', scope: 'workspace' }, { kind: 'network', access: 'write', scope: 'external' })
declare('run_command write_terminal', { kind: 'process', access: 'execute', scope: 'host' }, { kind: 'filesystem', access: 'unknown', scope: 'unknown' }, { kind: 'network', access: 'unknown', scope: 'unknown' })
declare('read_terminal list_terminals', { kind: 'process', access: 'read', scope: 'run' })
declare('kill_terminal', { kind: 'process', access: 'write', scope: 'run', argument: 'session_id' })
declare('create_task create_tasks update_task add_task_dependency remove_task_dependency ask_user notify_user present_workflow detach_agent', { kind: 'session', access: 'write', scope: 'run' })
declare('close_agent cancel_agent', { kind: 'session', access: 'write', scope: 'run' }, { kind: 'process', access: 'write', scope: 'run' })
declare('list_tasks list_agents read_agent wait_agents', { kind: 'session', access: 'read', scope: 'run' })
declare('spawn_agent followup_agent send_agent_message', { kind: 'session', access: 'write', scope: 'run' }, { kind: 'external', access: 'unknown', scope: 'unknown' })

export function builtInToolAccess(name: string): ToolAccessContract {
  const access = resources.get(name)
  if (!access) throw new Error(`Missing tool access declaration: ${name}`)
  return { source: 'builtin', exposure: 'resident', output: 'ToolResult', resources: access }
}

export function declaredBuiltInToolNames(): string[] { return [...resources.keys()].sort() }
