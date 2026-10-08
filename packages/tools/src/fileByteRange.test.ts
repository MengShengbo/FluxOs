import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, utimesSync, statSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeToolExecutor } from './nodeToolExecutor'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function fixture(text: string) {
  const root = mkdtempSync(join(tmpdir(), 'fluxos-byte-read-')); roots.push(root)
  const path = join(root, 'long.txt'); writeFileSync(path, text)
  return { root, path, executor: new NodeToolExecutor(root, { memoryRoot: join(root, 'memory'), runtimeLogsRoot: join(root, 'logs') }) }
}

describe('bounded UTF-8 file continuation', () => {
  it.each(['x'.repeat(100_000), '\uFEFF' + '中🙂e\u0301\r\n'.repeat(20_000)])('reconstructs a large source without missing or repeated bytes', async text => {
    const { executor, path } = fixture(text)
    let offset = 0; let version: string | undefined; let restored = ''
    do {
      const result = await executor.readFileBytes(path, { offset, maxBytes: 4097, version })
      expect(result.success, result.error).toBe(true)
      const page = result.data!
      expect(page.offset).toBe(offset)
      expect(Buffer.byteLength(page.content)).toBe(page.endOffset - offset)
      expect(page.endOffset - offset).toBeLessThanOrEqual(4097)
      expect(page.content).not.toContain('\uFFFD')
      if (version) expect(page.version).toBe(version)
      version = page.version; restored += page.content; offset = page.nextOffset ?? -1
    } while (offset >= 0)
    expect(restored).toBe(text)
  })

  it('rejects a changed file even when size and mtime are restored', async () => {
    const { executor, path } = fixture('a'.repeat(100_000))
    const before = statSync(path)
    const first = (await executor.readFileBytes(path, { maxBytes: 100 })).data!
    writeFileSync(path, 'b'.repeat(100_000)); utimesSync(path, before.atime, before.mtime)
    expect(await executor.readFileBytes(path, { offset: first.nextOffset, version: first.version })).toMatchObject({ success: false, error: expect.stringContaining('changed') })
  })

  it('rejects invalid ranges, non-UTF-8 boundaries and versionless continuation', async () => {
    const { executor, path } = fixture('🙂'.repeat(100))
    const first = (await executor.readFileBytes(path, { maxBytes: 4 })).data!
    for (const options of [{ offset: -1 }, { offset: 0.5 }, { maxBytes: NaN }, { maxBytes: 1_000_000 }, { offset: 4 }, { offset: 1, version: first.version }]) {
      expect(await executor.readFileBytes(path, options)).toMatchObject({ success: false, errorKind: 'validation' })
    }
  })

  it('rechecks canonical workspace boundaries on each page', async () => {
    const inside = fixture('inside'.repeat(100)); const outside = fixture('private')
    const first = (await inside.executor.readFileBytes(inside.path, { maxBytes: 4 })).data!
    rmSync(inside.path); symlinkSync(outside.path, inside.path)
    expect(await inside.executor.readFileBytes(inside.path, { offset: 4, version: first.version })).toMatchObject({ success: false, errorKind: 'permission' })
    expect(await inside.executor.readFileBytes(outside.path, {})).toMatchObject({ success: false, errorKind: 'permission' })
  })

  it('rejects invalid UTF-8, EOF overflow, another path version and aborted reads', async () => {
    const { executor, path, root } = fixture('valid')
    const first = (await executor.readFileBytes(path, {})).data!
    const other = join(root, 'other.txt'); writeFileSync(other, 'valid')
    expect(await executor.readFileBytes(other, { version: first.version })).toMatchObject({ success: false, errorKind: 'validation' })
    expect(await executor.readFileBytes(path, { offset: 6, version: first.version })).toMatchObject({ success: false, errorKind: 'validation' })
    const controller = new AbortController(); controller.abort()
    expect(await executor.readFileBytes(path, { signal: controller.signal })).toMatchObject({ success: false, errorKind: 'abort' })
    writeFileSync(path, Buffer.from([0xff, 0xfe]))
    expect(await executor.readFileBytes(path, {})).toMatchObject({ success: false, error: expect.stringContaining('valid UTF-8') })
  })

  it('rejects a file edited while its byte window is being read', async () => {
    const { executor, path } = fixture('a'.repeat(10000))
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementationOnce(async (...readArgs) => {
        const result = await read(...readArgs)
        writeFileSync(path, 'b'.repeat(10000))
        return result
      })
      return handle
    })
    expect(await executor.readFileBytes(path, { maxBytes: 100 })).toMatchObject({ success: false, error: expect.stringContaining('changed while reading') })
  })
})
