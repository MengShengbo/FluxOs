import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readlinkSync, readSync, realpathSync, type Stats } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { AutomationWorkspaceCoverage, AutomationWorkspaceScanIssue, AutomationWorkspaceScanLimits } from './automationTypes'

export interface AutomationWorkspaceIdentity {
  fingerprint: string
  gitHead?: string
  complete: boolean
  coverage: AutomationWorkspaceCoverage
}

export const DEFAULT_AUTOMATION_WORKSPACE_SCAN_LIMITS: Readonly<AutomationWorkspaceScanLimits> = Object.freeze({
  maxEntries: 10_000,
  maxBytes: 64 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxDurationMs: 2_000,
})

class IncompleteScan extends Error {
  constructor(readonly issue: AutomationWorkspaceScanIssue) {
    super(`${issue.code}${issue.path ? `: ${issue.path}` : ''}`)
  }
}

function sameStat(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

/** A bounded content snapshot, not an atomic filesystem snapshot or proof of external side-effect safety. */
export function captureAutomationWorkspaceIdentity(
  workspacePath: string,
  options: Partial<AutomationWorkspaceScanLimits> = {},
): AutomationWorkspaceIdentity {
  const limits = { ...DEFAULT_AUTOMATION_WORKSPACE_SCAN_LIMITS, ...options }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Invalid workspace scan limit: ${key}`)
  }
  const deadline = performance.now() + limits.maxDurationMs
  const coverage: AutomationWorkspaceCoverage = {
    algorithm: 'sha256-workspace-content-v1',
    scope: 'workspace-files-including-ignored',
    excludedPaths: ['.git'],
    limits,
    scannedEntries: 0,
    hashedBytes: 0,
    issues: [],
  }
  const hash = createHash('sha256')
  // JSON array framing prevents collisions between filenames, link targets and content records.
  const record = (...values: (string | number)[]) => { hash.update(JSON.stringify(values)).update('\n') }
  const fail = (code: AutomationWorkspaceScanIssue['code'], path?: string): never => {
    throw new IncompleteScan(path === undefined ? { code } : { code, path })
  }
  const checkDeadline = () => { if (performance.now() >= deadline) fail('budget_exceeded') }
  let normalized = workspacePath
  let gitHead: string | undefined
  let currentPath = '.'
  let gitStatus: string | undefined
  const observed: { path: string; stat: Stats }[] = []
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  // Git must inspect the requested workspace, not inherited repository overrides.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key]
  const git = (...args: string[]) => {
    checkDeadline()
    return execFileSync('git', ['-C', normalized, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
      encoding: 'utf8', env, timeout: Math.max(1, Math.ceil(deadline - performance.now())),
      maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
  }
  const status = () => git('status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=none')

  try {
    checkDeadline()
    normalized = realpathSync(workspacePath)
    record(coverage.algorithm, coverage.scope, normalized, ...coverage.excludedPaths)
    try {
      if (realpathSync(git('rev-parse', '--show-toplevel').trim()) !== normalized) fail('git_scope_mismatch')
      gitStatus = status()
      const oid = gitStatus.split('\0').find(line => line.startsWith('# branch.oid '))?.slice('# branch.oid '.length)
      if (!oid) fail('git_unavailable')
      gitHead = oid === '(initial)' ? undefined : oid
      record('git', gitStatus)
    } catch (error) {
      if (error instanceof IncompleteScan) throw error
      fail('git_unavailable')
    }

    const pending = ['.']
    const buffer = Buffer.alloc(64 * 1024)
    while (pending.length) {
      checkDeadline()
      currentPath = pending.pop()!
      const absolute = currentPath === '.' ? normalized : join(normalized, currentPath)
      const stat = lstatSync(absolute)
      observed.push({ path: absolute, stat })
      if (stat.isDirectory()) {
        record('directory', currentPath, stat.mode)
        const names: string[] = []
        const directory = opendirSync(absolute)
        try {
          let entry
          while ((entry = directory.readSync()) !== null) {
            checkDeadline()
            if (currentPath === '.' && entry.name === '.git') continue
            if (++coverage.scannedEntries > limits.maxEntries) fail('budget_exceeded', currentPath)
            const child = currentPath === '.' ? entry.name : `${currentPath}/${entry.name}`
            if (entry.name === '.git') fail('nested_repository', child)
            names.push(child)
          }
        } finally {
          directory.closeSync()
        }
        pending.push(...names.sort().reverse())
      } else if (stat.isFile()) {
        if (stat.size > limits.maxFileBytes || coverage.hashedBytes + stat.size > limits.maxBytes) fail('budget_exceeded', currentPath)
        // NOFOLLOW avoids a last-component symlink race; NONBLOCK prevents a swapped FIFO from blocking open.
        const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const opened = fstatSync(fd)
          if (!opened.isFile() || !sameStat(stat, opened)) fail('changed_during_scan', currentPath)
          const content = createHash('sha256')
          let bytes = 0
          while (true) {
            checkDeadline()
            const count = readSync(fd, buffer, 0, buffer.length, null)
            if (!count) break
            bytes += count
            coverage.hashedBytes += count
            if (bytes > limits.maxFileBytes || coverage.hashedBytes > limits.maxBytes) fail('budget_exceeded', currentPath)
            content.update(buffer.subarray(0, count))
          }
          if (bytes !== stat.size || !sameStat(stat, fstatSync(fd)) || !sameStat(stat, lstatSync(absolute))) fail('changed_during_scan', currentPath)
          record('file', currentPath, stat.mode, bytes, content.digest('hex'))
        } finally {
          closeSync(fd)
        }
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(absolute)
        record('symlink', currentPath, target)
        let resolved: string
        try { resolved = realpathSync(absolute) } catch { throw new IncompleteScan({ code: 'unresolved_symlink', path: currentPath }) }
        const targetPath = relative(normalized, resolved)
        if (isAbsolute(targetPath) || targetPath === '..' || targetPath.startsWith(`..${sep}`)) fail('external_symlink', currentPath)
        if (targetPath === '.git' || targetPath.startsWith(`.git${sep}`)) fail('excluded_symlink', currentPath)
        // Internal targets are covered by the ordinary tree walk; do not follow directory cycles.
      } else {
        fail('unsupported_entry', currentPath)
      }
    }
    // Recheck earlier files and directory membership changes, not just each file immediately after reading.
    for (const entry of observed) {
      checkDeadline()
      currentPath = relative(normalized, entry.path).split(sep).join('/') || '.'
      if (!sameStat(entry.stat, lstatSync(entry.path))) fail('changed_during_scan', currentPath)
    }
    try {
      if (status() !== gitStatus) fail('changed_during_scan', '.git')
    } catch (error) {
      if (error instanceof IncompleteScan) throw error
      fail('git_unavailable')
    }
    checkDeadline()
  } catch (error) {
    coverage.issues.push(error instanceof IncompleteScan ? error.issue : { code: 'unreadable', path: currentPath })
  }
  record('coverage', JSON.stringify(coverage.issues))
  return { fingerprint: `${coverage.algorithm}:${hash.digest('hex')}`, gitHead, complete: coverage.issues.length === 0, coverage }
}
