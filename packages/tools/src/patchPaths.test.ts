import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeToolExecutor } from './nodeToolExecutor'

describe('path preflight lifecycle', () => {
  let root: string
  let executor: NodeToolExecutor
  let initialEntries: string[]
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fluxagent-path-preflight-')))
    executor = new NodeToolExecutor(root)
    // The executor initializes its own runtime storage before path preflight.
    initialEntries = readdirSync(root)
  })
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
  it('cleans isolated probes without creating target directories', async () => {
    const result = await executor.resolvePatchPaths(['new/one', 'new/two'], root)
    expect(result.success).toBe(true)
    expect(result.data?.[0]?.identity).not.toBe(result.data?.[1]?.identity)
    expect(readdirSync(root)).toEqual(initialEntries)
  })
  it('reports cleanup failure and retains its reason', async () => {
    const rm = fs.rm.bind(fs)
    vi.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
      if (String(path).includes('.fluxagent-patch-') && !String(path).endsWith('-caseprobe')) throw new Error('fixture cleanup failure')
      return rm(path, options)
    })
    const result = await executor.resolvePatchPaths(['one', 'two'], root)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unable to clean patch path probe')
    expect(result.error).toContain('fixture cleanup failure')
    const remaining = readdirSync(root).filter(name => !initialEntries.includes(name))
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatch(/^\.fluxagent-patch-/)
  })
  it('rejects dangling symlinks and missing children of a dangling directory link', async () => {
    symlinkSync(join(root, 'absent'), join(root, 'broken'))
    expect((await executor.resolvePatchPaths(['broken'], root)).success).toBe(false)
    expect((await executor.resolvePatchPaths(['broken/child'], root)).success).toBe(false)
    expect(readdirSync(root)).toEqual([...initialEntries, 'broken'].sort())
  })
  it('checks permissions and cancellation before probing any target namespace', async () => {
    expect((await new NodeToolExecutor(root, { capabilityProfile: 'read-only' }).resolvePatchPaths(['one', 'two'], root)).success).toBe(false)
    expect((await executor.resolvePatchPaths(['../outside', 'two'], root)).success).toBe(false)
    const abort = new AbortController(); abort.abort()
    expect((await executor.resolvePatchPaths(['one', 'two'], root, abort.signal)).success).toBe(false)
    expect(readdirSync(root)).toEqual(initialEntries)
  })
  it('uses existing physical identities without requiring a writable probe directory', async () => {
    writeFileSync(join(root, 'one'), '')
    const create = vi.spyOn(fs, 'mkdtemp')
    const result = await executor.resolvePatchPaths(['one', './one'], root)
    expect(result.success).toBe(true)
    expect(result.data?.[0]?.identity).toBe(result.data?.[1]?.identity)
    expect(create).not.toHaveBeenCalled()
  })
  it('resolves display paths relative to a canonicalized workspace alias', async () => {
    symlinkSync(root, join(root, 'workspace-alias'), 'dir')
    const result = await executor.resolvePatchPaths(['new.txt'], join(root, 'workspace-alias'))
    expect(result.success).toBe(true)
    expect(result.data?.[0]).toMatchObject({ path: join(root, 'new.txt'), relativePath: 'new.txt' })
  })
  it('cleans a partially prepared namespace after cancellation', async () => {
    const abort = new AbortController()
    const create = fs.mkdtemp.bind(fs)
    vi.spyOn(fs, 'mkdtemp').mockImplementation(async (...args) => {
      const directory = await create(...args)
      abort.abort(new Error('fixture cancellation'))
      return directory
    })
    const result = await executor.resolvePatchPaths(['one', 'two'], root, abort.signal)
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('fixture cancellation') })
    expect(readdirSync(root)).toEqual(initialEntries)
  })
  it('rejects writes through an existing symlink outside the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'fluxagent-patch-outside-'))
    try {
      symlinkSync(outside, join(root, 'outside'), 'dir')
      const result = await executor.resolvePatchPaths(['outside/one', 'outside/two'], root)
      expect(result.success).toBe(false)
      expect(readdirSync(outside)).toEqual([])
    } finally { rmSync(outside, { recursive: true, force: true }) }
  })
})
