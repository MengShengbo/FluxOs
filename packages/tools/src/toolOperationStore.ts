import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { withFileLockSync, writeFileAtomicSync } from '@fluxos/platform/fileIO'
import type { ToolOperationReceipt, ToolRecovery } from '@fluxos/contracts/toolResultData'

export interface ToolOperationIdentity {
  sessionId: string
  turnId: string
  callId: string
}
interface Intent {
  version: 1
  id: string
  fingerprint: string
  token: string
  startedAt: number
}
interface Settlement extends Intent {
  settledAt: number
  effects: ToolRecovery['effects']
  status: NonNullable<ToolOperationReceipt['previousStatus']>
}
export type OperationClaim =
  | { kind: 'new'; intent: Intent }
  | { kind: 'existing'; receipt: ToolOperationReceipt; reason: 'settled' | 'unsettled' | 'identity_conflict' }

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function syncDirectory(path: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function validIntent(value: unknown, id: string): value is Intent {
  if (!value || typeof value !== 'object') return false
  const record = value as Intent
  return record.version === 1 && record.id === id && /^[a-f0-9]{64}$/.test(record.fingerprint)
    && typeof record.token === 'string' && record.token.length > 0 && Number.isFinite(record.startedAt)
}
function validSettlement(value: unknown, intent: Intent): value is Settlement {
  if (!validIntent(value, intent.id)) return false
  const record = value as Settlement
  return record.token === intent.token && record.fingerprint === intent.fingerprint
    && Number.isFinite(record.settledAt)
    && ['none', 'committed', 'partial', 'unknown'].includes(record.effects)
    && ['completed', 'failed', 'cancelled', 'running'].includes(record.status)
}

/** Exclusive durable intents; no raw arguments, outputs, credentials or screenshots. */
export class ToolOperationStore {
  readonly root: string
  constructor(root: string) { this.root = resolve(root) }

  operationId(identity: ToolOperationIdentity): string {
    if (![identity.sessionId, identity.turnId, identity.callId].every(value => typeof value === 'string' && value.length > 0)) {
      throw new Error('A durable operation requires session, assistant turn and call identities')
    }
    return digest(JSON.stringify([identity.sessionId, identity.turnId, identity.callId]))
  }

  begin(identity: ToolOperationIdentity, signature: string): OperationClaim {
    const id = this.operationId(identity)
    const fingerprint = digest(signature)
    const firstCreated = mkdirSync(this.root, { recursive: true, mode: 0o700 })
    if (firstCreated) {
      for (let directory = this.root;; directory = dirname(directory)) {
        syncDirectory(directory)
        if (directory === dirname(firstCreated)) break
      }
    }
    const intent: Intent = { version: 1, id, fingerprint, token: randomUUID(), startedAt: Date.now() }
    if (!existsSync(this.path(id, 'intent')) && existsSync(this.path(id, 'settled'))) {
      throw new Error('Orphan operation settlement; inspect the retained journal before retrying')
    }
    let fd: number
    try { fd = openSync(this.path(id, 'intent'), 'wx', 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const prior = this.read(this.path(id, 'intent'))
      if (!validIntent(prior, id)) throw new Error('Invalid operation intent; inspect the retained journal before retrying')
      const settlement = this.read(this.path(id, 'settled'), true)
      if (settlement !== undefined && !validSettlement(settlement, prior)) {
        throw new Error('Invalid operation settlement; inspect the retained journal before retrying')
      }
      const settled = settlement as Settlement | undefined
      return { kind: 'existing', reason: prior.fingerprint !== fingerprint ? 'identity_conflict' : settled ? 'settled' : 'unsettled',
        receipt: { id, state: settled ? 'settled' : 'unsettled', replay: 'blocked', persistence: 'persisted',
          coordination: 'host_process', effects: settled?.effects ?? 'unknown', ...(settled ? { previousStatus: settled.status } : {}) } }
    }
    // If writing/syncing fails, retain even a partial intent. Never delete a
    // possibly published claim and allow the next process to blindly retry.
    try { writeFileSync(fd, JSON.stringify(intent), 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
    syncDirectory(this.root)
    return { kind: 'new', intent }
  }

  settle(claim: Extract<OperationClaim, { kind: 'new' }>, effects: ToolRecovery['effects'], status: Settlement['status']): ToolOperationReceipt {
    const current = this.read(this.path(claim.intent.id, 'intent'))
    if (!validIntent(current, claim.intent.id) || current.token !== claim.intent.token || current.fingerprint !== claim.intent.fingerprint) {
      throw new Error('Operation intent ownership changed; settlement was not acknowledged')
    }
    const record: Settlement = { ...claim.intent, settledAt: Date.now(), effects, status }
    const target = this.path(record.id, 'settled')
    withFileLockSync(`${target}.lock`, () => {
      if (existsSync(target)) throw new Error('Operation already settled; refusing to replace its receipt')
      writeFileAtomicSync(target, JSON.stringify(record), 0o600)
    })
    return { id: record.id, state: 'settled', replay: 'not_replayed', persistence: 'persisted',
      coordination: 'host_process', effects, previousStatus: status }
  }

  private path(id: string, phase: 'intent' | 'settled'): string { return join(this.root, `${id}.${phase}.json`) }
  private read(path: string, optional = false): unknown {
    try {
      if (statSync(path).size > 16_384) throw new Error('Operation record exceeds its bounded schema')
      return JSON.parse(readFileSync(path, 'utf8')) as unknown
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
}
