import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { ToolOperationStore } from './toolOperationStore'

const roots: string[] = []
const identity = { sessionId: 'session', turnId: 'turn', callId: 'call' }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fluxagent-operation-store-'))
  roots.push(root)
  return { root, store: new ToolOperationStore(join(root, 'operations')) }
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

describe('ToolOperationStore', () => {
  it('reopens immutable intent and settlement facts without saving private payloads', () => {
    const { root, store } = fixture()
    const claim = store.begin(identity, 'private password, screenshot and message')
    expect(claim.kind).toBe('new')
    if (claim.kind !== 'new') throw new Error('expected new claim')
    const receipt = store.settle(claim, 'committed', 'completed')
    const reopened = new ToolOperationStore(store.root)
    expect(reopened.begin(identity, 'private password, screenshot and message')).toMatchObject({ kind: 'existing', reason: 'settled',
      receipt: { ...receipt, replay: 'blocked' } })
    for (const file of readdirSync(join(root, 'operations'))) {
      expect(readFileSync(join(root, 'operations', file), 'utf8')).not.toMatch(/private password|screenshot|message/)
    }
  })

  it('leaves uncertain external effects in inspection even if the transport completed', () => {
    const { store } = fixture()
    const claim = store.begin(identity, 'remote')
    if (claim.kind !== 'new') throw new Error('expected new claim')
    store.settle(claim, 'unknown', 'completed')
    expect(new ToolOperationStore(store.root).begin(identity, 'remote')).toMatchObject({
      kind: 'existing', reason: 'settled', receipt: { effects: 'unknown', previousStatus: 'completed', replay: 'blocked' },
    })
  })

  it('blocks replay after a real child exits between its side effect and settlement', () => {
    const { root, store } = fixture()
    const moduleUrl = new URL('./toolOperationStore.ts', import.meta.url).href
    const script = `import { ToolOperationStore } from ${JSON.stringify(moduleUrl)};
      import { appendFileSync } from 'node:fs';
      const store = new ToolOperationStore(process.argv[1]);
      const claim = store.begin(${JSON.stringify(identity)}, 'external-write');
      if (claim.kind !== 'new') process.exit(9);
      appendFileSync(process.argv[2], 'acknowledged side effect\\n');
      if (process.platform === 'win32') process.exit(23);
      process.kill(process.pid, 'SIGKILL');`
    const marker = join(root, 'effects')
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, store.root, marker], { encoding: 'utf8', timeout: 10_000 })
    expect(child.error).toBeUndefined()
    if (process.platform === 'win32') expect(child.status, child.stderr).toBe(23)
    else expect(child.signal, child.stderr).toBe('SIGKILL')
    expect(new ToolOperationStore(store.root).begin(identity, 'external-write')).toMatchObject({
      kind: 'existing', reason: 'unsettled', receipt: { effects: 'unknown', replay: 'blocked' },
    })
    expect(readFileSync(marker, 'utf8')).toBe('acknowledged side effect\n')
    const duplicate = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, store.root, marker], { encoding: 'utf8', timeout: 10_000 })
    expect(duplicate.status, duplicate.stderr).toBe(9)
    expect(readFileSync(marker, 'utf8')).toBe('acknowledged side effect\n')
  })

  it('admits only one owner when separate Node processes contend for the same operation', async () => {
    const { root, store } = fixture()
    const moduleUrl = new URL('./toolOperationStore.ts', import.meta.url).href
    const script = `import { ToolOperationStore } from ${JSON.stringify(moduleUrl)};
      import { appendFileSync } from 'node:fs';
      try {
        const claim = new ToolOperationStore(process.argv[1]).begin(${JSON.stringify(identity)}, 'contended');
        if (claim.kind === 'new') appendFileSync(process.argv[2], 'effect\\n');
        process.stdout.write(claim.kind);
      } catch { process.stdout.write('closed'); }`
    const run = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, store.root, join(root, 'effects')], { stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      let errors = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      child.stdout.on('data', chunk => { output += String(chunk) })
      child.stderr.on('data', chunk => { errors += String(chunk) })
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(errors || `child exit ${code}`)) })
    })
    const results = await Promise.all([run(), run()])
    expect(results.filter(result => result === 'new')).toHaveLength(1)
    expect(readFileSync(join(root, 'effects'), 'utf8')).toBe('effect\n')
  })

  it('rejects identity reuse but admits independent sessions, turns and calls', () => {
    const { store } = fixture()
    store.begin(identity, 'first payload')
    expect(store.begin(identity, 'changed payload')).toMatchObject({ kind: 'existing', reason: 'identity_conflict' })
    for (const key of ['sessionId', 'turnId', 'callId'] as const) {
      expect(store.begin({ ...identity, [key]: 'other' }, 'first payload').kind).toBe('new')
    }
  })

  it.each(['intent', 'settled'] as const)('fails closed on a corrupt %s and preserves the evidence', phase => {
    const { store } = fixture()
    store.begin(identity, 'payload')
    const path = join(store.root, `${store.operationId(identity)}.${phase}.json`)
    writeFileSync(path, '{incomplete')
    expect(() => store.begin(identity, 'payload')).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{incomplete')
  })

  it('does not accept settlement by a stale or replaced intent owner', () => {
    const { store } = fixture()
    const claim = store.begin(identity, 'payload')
    if (claim.kind !== 'new') throw new Error('expected new claim')
    writeFileSync(join(store.root, `${store.operationId(identity)}.intent.json`), JSON.stringify({ ...claim.intent, token: 'different-owner' }))
    expect(() => store.settle(claim, 'committed', 'completed')).toThrow('ownership changed')
    expect(store.begin(identity, 'payload')).toMatchObject({ kind: 'existing', reason: 'unsettled' })
  })

  it('retains the first settlement and refuses a second acknowledgement', () => {
    const { store } = fixture()
    const claim = store.begin(identity, 'payload')
    if (claim.kind !== 'new') throw new Error('expected new claim')
    store.settle(claim, 'committed', 'completed')
    expect(() => store.settle(claim, 'none', 'failed')).toThrow('already settled')
    expect(store.begin(identity, 'payload')).toMatchObject({ receipt: { effects: 'committed', previousStatus: 'completed' } })
  })

  it('does not recreate an intent when its settlement survives alone', () => {
    const { store } = fixture()
    const claim = store.begin(identity, 'payload')
    if (claim.kind !== 'new') throw new Error('expected new claim')
    store.settle(claim, 'committed', 'completed')
    rmSync(join(store.root, `${store.operationId(identity)}.intent.json`))
    expect(() => store.begin(identity, 'payload')).toThrow('Orphan')
  })
})
