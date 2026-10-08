import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSearchCapture } from './workspaceSearchCapture'
import { WorkspaceSearch } from './workspaceSearch'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function workspace() { const root = mkdtempSync(join(tmpdir(), 'fluxos-search-process-')); roots.push(root); return root }

describe('actual bounded search processes', () => {
  it('keeps the real 8 MiB capture limit and reports partial rg results', async () => {
    const root = workspace(); writeFileSync(join(root, 'large.txt'), 'needle '.repeat(24) + '\n' + ('needle ' + 'x'.repeat(160) + '\n').repeat(70_000))
    const backend = createSearchCapture(); let capturedBytes = 0
    const service = new WorkspaceSearch(async (...args) => {
      const result = await backend(...args); capturedBytes = Buffer.byteLength(result.output); return result
    })
    const result = await service.content('needle', root, undefined, false, { limit: 2 })
    expect(capturedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(capturedBytes).toBeGreaterThan(7 * 1024 * 1024)
    expect(result).toMatchObject({ success: true, data: { totalIsExact: false, truncated: true, incompleteReasons: expect.arrayContaining(['capture_budget']) } })
    expect(result.data!.hits.length).toBeGreaterThan(0)
    const next = await service.content('needle', root, undefined, false, { cursor: result.data!.nextCursor })
    expect(next.data!.incompleteReasons).toContain('capture_budget')
  }, 15_000)

  it('kills timed out processes, preserves partial evidence and awaits handle release', async () => {
    const root = workspace()
    const capture = createSearchCapture({ executable: process.execPath, timeoutMs: 600 })
    const result = await capture(['-e', "require('fs').writeFileSync('pid',String(process.pid));process.stdout.write('partial\\n');setInterval(()=>{},1000)"], root)
    expect(result).toEqual({ output: 'partial\n', reasons: ['timeout'] })
    expect(() => process.kill(Number(readFileSync(join(root, 'pid'), 'utf8')), 0)).toThrow()
    rmSync(root, { recursive: true, force: true })
  }, 5000)

  it('aborts an already running process and does not return a no-match result', async () => {
    const root = workspace(); const controller = new AbortController()
    const capture = createSearchCapture({ executable: process.execPath })
    const timer = setTimeout(() => controller.abort(), 600)
    try {
      await expect(capture(['-e', "require('fs').writeFileSync('pid',String(process.pid));process.stdout.write('partial\\n');setInterval(()=>{},1000)"], root, controller.signal)).rejects.toMatchObject({ kind: 'abort' })
      expect(() => process.kill(Number(readFileSync(join(root, 'pid'), 'utf8')), 0)).toThrow()
      rmSync(root, { recursive: true, force: true })
    } finally { clearTimeout(timer) }
  }, 5000)

  it('distinguishes no matches, path failures, invalid regex and missing executable', async () => {
    const root = workspace(); writeFileSync(join(root, 'file.txt'), 'needle')
    expect(await new WorkspaceSearch().content('absent', root)).toMatchObject({ success: true, data: { totalMatches: 0, totalIsExact: true, truncated: false } })
    expect(await new WorkspaceSearch().content('[', root)).toMatchObject({ success: false, errorKind: 'execution' })
    expect(await createSearchCapture({ executable: process.execPath })(['-e', "process.stdout.write('partial\\n');process.exitCode=2"], root)).toMatchObject({ reasons: ['path_error'] })
    await expect(createSearchCapture({ executable: join(root, 'not-installed') })([], root)).rejects.toMatchObject({ kind: 'environment' })
  })
})
