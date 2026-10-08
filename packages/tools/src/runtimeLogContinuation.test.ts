import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RuntimeLogWriter } from './runtimeLogWriter'
import { RuntimeTaskManager } from './runtimeTaskManager'
import { NodeToolExecutor } from './nodeToolExecutor'
import { readRuntimeLog, runtimeLogSegments } from './runtimeLogSegments'

it('keeps independent UTF-8 decoders across stdout and stderr chunks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flux-log-utf8-'))
  try {
    const path = join(root, 'log.jsonl'); const writer = new RuntimeLogWriter(path)
    const bytes = Buffer.from('你好😀')
    for (const byte of bytes) { writer.append('stdout', Buffer.from([byte])); writer.append('stderr', 'e') }
    await writer.close()
    const records = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(records.filter(r => r.channel === 'stdout').map(r => r.data).join('')).toBe('你好😀')
    expect(records.filter(r => r.channel === 'stderr').map(r => r.data).join('')).toBe('e'.repeat(bytes.length))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('continues across rotations using absolute offsets and reports evicted bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flux-log-pages-'))
  try {
    const path = join(root, 'log.jsonl'); const writer = new RuntimeLogWriter(path, { maxFileBytes: 1024, maxFiles: 3 })
    const manager = new RuntimeTaskManager(); const task = manager.createTask({ kind: 'shell', logPath: path })
    writer.append('stdout', 'A'.repeat(800)); await writer.flush()
    const first = manager.readTaskOutput(task.id, 0, 4096)
    writer.append('stdout', 'B'.repeat(800)); await writer.flush()
    const second = manager.readTaskOutput(task.id, first.nextOffset, 4096)
    expect(second.content).toContain('B'.repeat(800))
    expect(second.offset).toBe(first.nextOffset)
    for (const value of ['C', 'D', 'E']) { writer.append('stdout', value.repeat(800)); await writer.flush() }
    await writer.close()
    const retained = manager.readTaskOutput(task.id, 0, 4096)
    expect(retained).toMatchObject({ omittedBytes: expect.any(Number) })
    expect((retained as { omittedBytes?: number }).omittedBytes).toBeGreaterThan(0)
    expect(retained.content).not.toContain('A'.repeat(800))
    expect(retained.content).toContain('E'.repeat(800))
    expect(readdirSync(root).length).toBeLessThanOrEqual(3)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('retains a real high-volume Unicode stdout stream beyond the model capture budget', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flux-log-stream-'))
  try {
    const executor = new NodeToolExecutor(root)
    const result = await executor.runProcess(process.execPath, ['-e', 'process.stdout.write("中😀".repeat(1000000))'], root)
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ truncated: true, outputBytes: 7_000_000 })
    const manager = executor.getRuntimeTaskManager(); const task = manager.listTasks()[0]
    let offset = 0, content = ''
    for (;;) {
      const page = manager.readTaskOutput(task.id, offset, 65533)
      expect(page.offset).toBe(offset)
      expect(page.omittedBytes).toBe(0)
      content += page.content; offset = page.nextOffset
      if (page.eof) break
    }
    const output = content.trim().split('\n').map(line => JSON.parse(line).data).join('')
    expect(output).toBe('中😀'.repeat(1_000_000))
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 15_000)

it('resumes retained segmented logs after reopening and rejects an internal gap instead of skipping it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flux-log-reopen-'))
  try {
    const path = join(root, 'task.jsonl')
    const first = new RuntimeLogWriter(path, { maxFileBytes: 1024, maxFiles: 8 })
    first.append('stdout', 'A'.repeat(800), 1); await first.flush()
    first.append('stdout', 'B'.repeat(800), 2); await first.close()
    const initial = readRuntimeLog(path)
    const reopened = new RuntimeLogWriter(path, { maxFileBytes: 1024, maxFiles: 8 })
    reopened.append('stdout', 'C'.repeat(800), 3); await reopened.close()
    expect(readRuntimeLog(path, initial.nextOffset).content).toContain('C'.repeat(800))
    const segments = runtimeLogSegments(path)
    expect(segments).toHaveLength(3)
    rmSync(segments[1].path)
    expect(() => readRuntimeLog(path)).toThrow('missing segment')
    expect(() => readRuntimeLog(path, Number.MAX_SAFE_INTEGER)).toThrow('beyond')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('recovers pipe-terminal output from retained rotated segments even when the base file was evicted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flux-log-terminal-'))
  try {
    const logPath = join(root, 'task.jsonl'); const manager = new RuntimeTaskManager()
    const task = manager.createTask({ kind: 'terminal', logPath, metadata: { sessionId: 'retained' } })
    const a = JSON.stringify({ seq: 1, timestamp: 1, data: 'A' }) + '\n'
    const b = JSON.stringify({ seq: 2, timestamp: 2, data: 'B' }) + '\n'
    const c = JSON.stringify({ seq: 3, timestamp: 3, data: 'C' }) + '\n'
    writeFileSync(`${logPath}.offset-${Buffer.byteLength(a)}`, b)
    writeFileSync(`${logPath}.offset-${Buffer.byteLength(a + b)}`, c)
    manager.completeTask(task.id, { outputBytes: 3 })
    const executor = new NodeToolExecutor(root, { runtimeTaskManager: manager })
    expect(await executor.ptyGetBuffer('retained')).toMatchObject({ success: true, data: 'BC', firstSeq: 2, lastSeq: 3, omittedBytes: 1 })
    expect(await executor.ptyGetBuffer('retained', 2)).toMatchObject({ success: true, data: 'C', omittedBytes: 0 })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
