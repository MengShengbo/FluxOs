import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const execute = promisify(execFile)

export interface ProcessTerminationReceipt {
  status: 'confirmed' | 'unknown'
  /** Confirmation applies only to this local observed scope, never remote effects. */
  scope: 'owned_group_and_observed_descendants' | 'windows_taskkill_tree'
  escalated: boolean
  error?: string
}

interface ProcessIdentity { pid: number; ppid: number; group: number; state: string; started: string }
async function inventory(): Promise<ProcessIdentity[]> {
  const { stdout } = await execute('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='], { timeout: 1000, maxBuffer: 8 * 1024 * 1024 })
  return stdout.trim().split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line)
    return match ? [{ pid: +match[1], ppid: +match[2], group: +match[3], state: match[4], started: match[5].trim() }] : []
  })
}

/** Only call for a process owned by this host. POSIX spawns must have their own group.
 * Captures descendants before signalling, including PTY job-control groups. Escaped
 * processes absent from the snapshot and remote effects are outside the receipt.
 * This is bounded best effort, not OS containment or a race-free process sandbox. */
export async function terminateOwnedProcess(pid: number | undefined, options: {
  graceMs?: number; killWaitMs?: number; platform?: NodeJS.Platform
  initial?: ProcessIdentity[]
} = {}): Promise<ProcessTerminationReceipt> {
  const platform = options.platform ?? process.platform
  const scope = platform === 'win32' ? 'windows_taskkill_tree' : 'owned_group_and_observed_descendants'
  let escalated = false
  if (!pid || pid <= 1 || pid === process.pid) return { status: 'unknown', scope, escalated, error: 'Owned process PID is unavailable or unsafe' }
  try {
    if (platform === 'win32') {
      await execute('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024 })
      // Successful taskkill /T acknowledges its tree. Confirm root disappearance too.
      const until = Date.now() + (options.killWaitMs ?? 1500)
      do {
        try { process.kill(pid, 0) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { status: 'confirmed', scope, escalated: true }
          throw error
        }
        await delay(25)
      } while (Date.now() < until)
      return { status: 'unknown', scope, escalated: true, error: 'taskkill returned but root exit is unconfirmed' }
    }
    const owned = new Map<number, string>()
    const capture = (table: ProcessIdentity[]) => {
      const byPid = new Map(table.map(item => [item.pid, item]))
      const root = byPid.get(pid)
      if (root && owned.has(pid) && owned.get(pid) !== root.started) throw new Error('Owned root PID was reused during termination')
      let changed = true
      while (changed) {
        changed = false
        for (const item of table) {
          if (item.pid === process.pid || owned.has(item.pid)) continue
          const parent = byPid.get(item.ppid)
          if (item.pid === pid || item.group === pid || (parent && owned.get(parent.pid) === parent.started)) {
            owned.set(item.pid, item.started); changed = true
          }
        }
      }
      return table.filter(item => owned.get(item.pid) === item.started && !item.state.startsWith('Z'))
    }
    if (options.initial) capture(options.initial)
    const current = await inventory()
    const initialRoot = options.initial?.find(item => item.pid === pid)
    const currentRoot = current.find(item => item.pid === pid)
    if (options.initial && currentRoot && currentRoot.started !== initialRoot?.started) {
      return { status: 'unknown', scope, escalated, error: 'Owned root identity changed; refusing to signal a reused PID' }
    }
    let live = capture(current)
    const signal = (name: NodeJS.Signals) => {
      // Group ownership survives root exit; do not downgrade to just the root PID.
      try { process.kill(-pid, name) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      for (const item of [...live].reverse()) {
        if (item.group === pid) continue
        try { process.kill(item.pid, name) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
    }
    if (live.length === 0) return { status: 'confirmed', scope, escalated }
    signal('SIGTERM')
    const grace = Date.now() + (options.graceMs ?? 500)
    do {
      await delay(25)
      live = capture(await inventory())
      if (live.length === 0) return { status: 'confirmed', scope, escalated }
    } while (Date.now() < grace)
    escalated = true
    signal('SIGKILL')
    const deadline = Date.now() + (options.killWaitMs ?? 1500)
    do {
      await delay(25)
      live = capture(await inventory())
      if (live.length === 0) return { status: 'confirmed', scope, escalated }
      signal('SIGKILL')
    } while (Date.now() < deadline)
    return { status: 'unknown', scope, escalated, error: 'Owned processes remained alive after SIGKILL deadline' }
  } catch (error) {
    return { status: 'unknown', scope, escalated, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Capture ownership when spawning, not when a long-retained exited terminal is closed. */
export function createProcessTerminator(pid: number | undefined, rootExited: () => boolean): () => Promise<ProcessTerminationReceipt> {
  const initial = process.platform === 'win32' ? undefined : inventory().then(
    table => ({ table }), error => ({ error: error instanceof Error ? error.message : String(error) }),
  )
  let pending: Promise<ProcessTerminationReceipt> | undefined
  return () => {
    if (pending) return pending
    pending = (async (): Promise<ProcessTerminationReceipt> => {
      if (process.platform === 'win32' && rootExited()) return {
        status: 'unknown', scope: 'windows_taskkill_tree', escalated: false,
        error: 'Root already exited; descendants cannot be identified safely by taskkill',
      }
      const captured = await initial
      if (captured && 'error' in captured) return { status: 'unknown', scope: 'owned_group_and_observed_descendants', escalated: false, error: captured.error }
      return terminateOwnedProcess(pid, { initial: captured?.table })
    })().then(receipt => {
      // Concurrent requests share one attempt. Failed confirmation may be retried
      // against the original captured identity, never a fresh unrelated PID.
      if (receipt.status === 'unknown') pending = undefined
      return receipt
    })
    return pending
  }
}
