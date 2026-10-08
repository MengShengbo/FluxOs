import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export interface RuntimeLogSegment { path: string; start: number; size: number }

/** A segment name is its immutable absolute JSONL byte offset, never a rotation slot. */
export function runtimeLogSegments(path: string): RuntimeLogSegment[] {
  const base = basename(path)
  let names: string[]
  try { names = readdirSync(dirname(path)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names.flatMap(name => {
    const suffix = name.slice(base.length)
    if (name !== base && !(name.startsWith(base) && /^\.offset-\d+$/.test(suffix))) return []
    const start = name === base ? 0 : Number(suffix.slice(8))
    if (!Number.isSafeInteger(start)) throw new Error('Runtime log offset exceeds safe integer range')
    const file = join(dirname(path), name)
    try { const info = statSync(file); return info.isFile() ? [{ path: file, start, size: info.size }] : [] }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }).sort((a, b) => a.start - b.start)
}

export interface RuntimeLogOutput {
  offset: number
  nextOffset: number
  content: string
  eof: boolean
  /** Retained absolute JSONL byte window; not raw command-output byte counts. */
  startOffset: number
  endOffset: number
  omittedBytes: number
}

export function readRuntimeLog(path: string, offset = 0, maxBytes = 256 * 1024): RuntimeLogOutput {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isFinite(maxBytes) || maxBytes < 1) throw new Error('Invalid runtime log offset or budget')
  // A retention deletion between listing and open is retried against the new window.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const segments = runtimeLogSegments(path)
      const startOffset = segments[0]?.start ?? 0
      const last = segments.at(-1)
      const endOffset = last ? last.start + last.size : 0
      if (offset > endOffset) throw new Error('Runtime log cursor is beyond the available output')
      const start = Math.max(offset, startOffset)
      const limit = Math.min(Math.floor(maxBytes), 2 * 1024 * 1024)
      const parts: Buffer[] = []
      let position = start, remaining = limit + 4
      for (const segment of segments) {
        if (segment.start + segment.size <= position) continue
        if (segment.start > position) throw new Error('Runtime log has a missing segment; continuation is incomplete')
        const length = Math.min(remaining, segment.start + segment.size - position)
        const buffer = Buffer.allocUnsafe(length)
        const fd = openSync(segment.path, 'r')
        let count: number
        try { count = readSync(fd, buffer, 0, length, position - segment.start) } finally { closeSync(fd) }
        if (count !== length) throw new Error('Runtime log segment changed during read')
        parts.push(buffer); position += count; remaining -= count
        if (!remaining) break
      }
      const bytes = Buffer.concat(parts)
      let from = 0
      while (from < bytes.length && (bytes[from] & 0xc0) === 0x80) from++
      let to = Math.min(from + limit, bytes.length)
      while (to < bytes.length && (bytes[to] & 0xc0) === 0x80) to++
      return { offset: start + from, nextOffset: start + to, content: bytes.subarray(from, to).toString('utf8'),
        eof: start + to >= endOffset, startOffset, endOffset, omittedBytes: start - offset }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt === 2) throw error
    }
  }
  throw new Error('Runtime log changed repeatedly during read')
}
