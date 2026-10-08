import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync, withFileLockSync } from './fileIO'

type Document = Record<string, any>
const currentKeys = ['provider', 'apiKey', 'baseUrl', 'model', 'contextWindow', 'maxTokens', 'reasoning']
const pick = (value: Document, keys: string[]): Document => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]))
const read = (path: string): Document => {
  const value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid configuration document: ${path}`)
  return value
}
const connectionFile = (id: string): string => `${encodeURIComponent(id)}.json`

// A durable journal makes a connection switch one recoverable operation.
function applyTransaction(root: string, transaction: Document): void {
  const connections = join(root, 'connections')
  if (!transaction.current || !transaction.state || !Array.isArray(transaction.connections)) throw new Error('Invalid model configuration transaction')
  mkdirSync(connections, { recursive: true, mode: 0o700 })
  const expected = new Set<string>()
  for (const profile of transaction.connections) {
    if (typeof profile.id !== 'string' || !profile.id) throw new Error('Invalid connection identity')
    const name = connectionFile(profile.id)
    expected.add(name)
    writeFileAtomicSync(join(connections, name), JSON.stringify(profile, null, 2), 0o600)
  }
  writeFileAtomicSync(join(root, 'connection-state.json'), JSON.stringify(transaction.state, null, 2), 0o600)
  writeFileAtomicSync(join(root, 'config.json'), JSON.stringify(transaction.current, null, 2), 0o600)
  for (const name of readdirSync(connections)) if (name.endsWith('.json') && !expected.has(name)) unlinkSync(join(connections, name))
  unlinkSync(join(root, '.connection-transaction.json'))
}

function recover(root: string): void {
  const journal = join(root, '.connection-transaction.json')
  if (existsSync(journal)) applyTransaction(root, read(journal))
}

function readConfiguration(root: string): Document {
  recover(root)
  const path = join(root, 'config.json')
  const current = existsSync(path) ? pick(read(path), currentKeys) : {}
  const statePath = join(root, 'connection-state.json')
  const state = existsSync(statePath) ? read(statePath) : {}
  const active = state.activeConnection
  const profiles: Document[] = []
  for (const id of state.connectionOrder ?? []) {
    if (typeof id !== 'string' || !id) throw new Error('Invalid connection identity')
    profiles.push(id === active?.id ? { ...active, ...current } : read(join(root, 'connections', connectionFile(id))))
  }
  return { ...pick(state, ['approvalPolicy', 'capabilityProfile', 'gitEnabled']), ...active, ...current,
    activeApiConfigId: active?.id, apiConfigs: profiles }
}

function writeConfiguration(root: string, config: Document): void {
  recover(root)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const profiles: Document[] = Array.isArray(config.apiConfigs) ? config.apiConfigs : []
  const active = profiles.find(profile => profile.id === config.activeApiConfigId)
  const metadata = active ? Object.fromEntries(Object.entries(active).filter(([key]) => !currentKeys.includes(key))) : undefined
  const transaction = {
    current: pick(config, currentKeys),
    state: { ...pick(config, ['approvalPolicy', 'capabilityProfile', 'gitEnabled']), activeConnection: metadata, connectionOrder: profiles.map(profile => profile.id) },
    connections: profiles.filter(profile => profile.id !== config.activeApiConfigId),
  }
  writeFileAtomicSync(join(root, '.connection-transaction.json'), JSON.stringify(transaction), 0o600)
  applyTransaction(root, transaction)
}

function locked<T>(root: string, operation: () => T): T {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  return withFileLockSync(join(root, '.config.lock'), operation)
}
export function recoverModelConfiguration(root: string): void {
  locked(root, () => recover(root))
}
export function readModelConfiguration(root: string): Document {
  return locked(root, () => readConfiguration(root))
}
export function writeModelConfiguration(root: string, config: Document): void {
  locked(root, () => writeConfiguration(root, config))
}
