/** Host-authored declarations describe effects; they do not create a sandbox. */
export interface ToolResourceAccess {
  kind: 'filesystem' | 'repository' | 'network' | 'process' | 'memory' | 'session' | 'browser' | 'computer' | 'external'
  access: 'read' | 'write' | 'execute' | 'unknown'
  scope: 'workspace' | 'profile' | 'run' | 'host' | 'external' | 'unknown'
  argument?: string
}

export interface ToolAccessContract {
  source: 'builtin' | 'host' | 'external'
  exposure: 'resident' | 'deferred'
  output: 'ToolResult'
  resources: readonly ToolResourceAccess[]
}

/** Supplied by trusted host code, never copied from MCP wire annotations. */
export interface HostToolPolicy {
  isReadOnly: boolean
  isDestructive: boolean
  isConcurrencySafe: boolean
  resources: readonly ToolResourceAccess[]
}

export interface ToolPermissionContext {
  trustedHostTool?: boolean
}
