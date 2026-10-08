import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentTool, ToolCall } from '@fluxos/contracts/agentTypes'

export interface ToolWriteScope {
  workspacePath?: string
  sessionId?: string
  memoryRoot?: string
}

type Resource = { kind: 'host' } | { kind: 'path'; path: string } | { kind: 'session'; id: string }
  | { kind: 'control'; target: 'agent' | 'terminal'; id: string }
// One cooperative host process. This is neither an OS lock nor a remote lease.
const owners = new Map<symbol, Resource[]>()

function canonicalPath(path: string): string {
  let ancestor = resolve(path)
  const missing: string[] = []
  for (;;) {
    try {
      const canonical = join(realpathSync.native(ancestor), ...missing)
      // Conservative on platforms that commonly use case-insensitive volumes,
      // including not-yet-created leaves. False conflicts are safer than aliasing.
      return process.platform === 'darwin' ? canonical.normalize('NFC').toLowerCase()
        : process.platform === 'win32' ? canonical.toLowerCase() : canonical
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function overlaps(left: Resource, right: Resource): boolean {
  if (left.kind === 'control' || right.kind === 'control') {
    return left.kind === 'control' && right.kind === 'control' && left.target === right.target
      && (left.id === right.id || !left.id || !right.id)
  }
  if (left.kind === 'session' || right.kind === 'session') {
    return left.kind === 'session' && right.kind === 'session' && left.id === right.id
  }
  if (left.kind === 'host' || right.kind === 'host') return true
  return contains(left.path, right.path) || contains(right.path, left.path)
}

function resources(call: ToolCall, tool: AgentTool, scope: ToolWriteScope): Resource[] {
  if (isCancellationControl(tool)) {
    const terminal = tool.name === 'kill_terminal'
    return [{ kind: 'control', target: terminal ? 'terminal' : 'agent', id: String(call.arguments[terminal ? 'session_id' : 'agent_id'] ?? '') }]
  }
  const writes = tool.access.resources.filter(resource => resource.access !== 'read')
  // Only trusted host declarations are used; never infer shell effects from text.
  if (!writes.length) return [{ kind: 'host' }]
  return writes.map(resource => {
    if ((resource.kind === 'session' || resource.kind === 'memory') && resource.scope === 'run' && scope.sessionId) {
      return { kind: 'session', id: scope.sessionId }
    }
    if (resource.kind === 'memory' && resource.scope === 'profile' && scope.memoryRoot) {
      return { kind: 'path', path: canonicalPath(scope.memoryRoot) }
    }
    if (resource.kind === 'filesystem' && resource.access === 'write'
      && resource.argument === 'path' && typeof call.arguments.path === 'string' && scope.workspacePath) {
      return { kind: 'path', path: canonicalPath(resolve(scope.workspacePath, call.arguments.path)) }
    }
    if (resource.kind === 'repository' && resource.scope === 'workspace' && scope.workspacePath) {
      return { kind: 'path', path: canonicalPath(scope.workspacePath) }
    }
    // Patches and unresolved effects take the coarse host domain. A patch can
    // touch several paths, including external paths in full-access mode.
    return { kind: 'host' }
  })
}

export function needsWriteCoordination(tool: AgentTool): boolean {
  return !tool.isReadOnly || tool.access.resources.some(resource => resource.access !== 'read'
    && !(resource.kind === 'memory' && resource.scope === 'run'))
}

function isCancellationControl(tool: AgentTool): boolean {
  return tool.access.source === 'builtin' && ['kill_terminal', 'cancel_agent', 'close_agent'].includes(tool.name)
}

export function needsOperationReceipt(tool: AgentTool): boolean {
  // Cancellation uses the target's process/task ownership and termination
  // receipts. It must remain available even when the mutation journal is full.
  return !isCancellationControl(tool)
    && !(tool.access.source === 'builtin' && ['tool_search', 'use_skill'].includes(tool.name))
}

/** Atomically claims every resource or rejects; never holds a partial lock set. */
export function acquireToolWrite(call: ToolCall, tool: AgentTool, scope: ToolWriteScope): (() => void) | undefined {
  const wanted = resources(call, tool, scope)
  if ([...owners.values()].some(held => wanted.some(left => held.some(right => overlaps(left, right))))) return undefined
  const token = Symbol('tool-write')
  owners.set(token, wanted)
  return () => { owners.delete(token) }
}
