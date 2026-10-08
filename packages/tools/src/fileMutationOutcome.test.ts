import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeToolExecutor } from './nodeToolExecutor'

describe('native file mutation facts', () => {
  let root: string
  let executor: NodeToolExecutor
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fluxagent-mutation-')); executor = new NodeToolExecutor(root) })
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
  it('distinguishes a precondition rejection from committed writes and deletes', async () => {
    writeFileSync(join(root, 'file'), 'before')
    expect(await executor.writeFile(join(root, 'file'), 'bad', { expectedHash: 'mismatch' })).toMatchObject({ success: false, mutation: 'not_committed' })
    expect(await executor.writeFile(join(root, 'file'), 'after')).toMatchObject({ success: true, mutation: 'committed' })
    expect(await executor.deleteFile(join(root, 'file'), { expectedHash: 'mismatch' })).toMatchObject({ success: false, mutation: 'not_committed' })
    expect(await executor.deleteFile(join(root, 'file'))).toMatchObject({ success: true, mutation: 'committed' })
  })
  it('retains the publication fact when opening the directory for sync fails', async () => {
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (args[1] === 'r') throw new Error('fixture directory sync unavailable')
      return open(...args)
    })
    const result = await executor.writeFile(join(root, 'file'), 'published')
    if (process.platform === 'win32') expect(result).toMatchObject({ success: true, mutation: 'committed' })
    else expect(result).toMatchObject({ success: false, mutation: 'committed', error: expect.stringContaining('fixture directory sync unavailable') })
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('published')
  })
  it('rejects a newly appeared destination before publication', async () => {
    writeFileSync(join(root, 'target'), 'concurrent change')
    expect(await executor.writeFile(join(root, 'target'), 'patch', { expectNotExists: true })).toMatchObject({ success: false, mutation: 'not_committed' })
    expect(readFileSync(join(root, 'target'), 'utf8')).toBe('concurrent change')
  })
})
