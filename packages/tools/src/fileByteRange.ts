import { createHash } from 'node:crypto'
import { promises as fs, type BigIntStats } from 'node:fs'
import { TextDecoder } from 'node:util'
import { assertTextBytes } from './textFile'
import type { FileByteRangeOptions, FileByteRangeResult } from '@fluxos/contracts/toolExecutor'

export class FileByteRangeError extends Error {
  readonly errorKind = 'validation' as const
}

function revision(path: string, stat: BigIntStats): string {
  return createHash('sha256').update([path, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join('\0')).digest('hex')
}

/** The caller supplies its current capability resolver; each page rechecks it. */
export async function readFileByteRange(resolvePath: () => string, options: FileByteRangeOptions = {}): Promise<FileByteRangeResult> {
  const offset = options.offset ?? 0
  const limit = options.maxBytes ?? 16 * 1024
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 4 || limit > 32 * 1024) {
    throw new FileByteRangeError('Expected nonnegative integer byte offset and byte limit from 4 to 32768')
  }
  if (offset > 0 && !options.version) throw new FileByteRangeError('Continuation requires source_version from the first byte page')
  options.signal?.throwIfAborted()
  const path = resolvePath()
  const handle = await fs.open(path, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new FileByteRangeError('Path is not a regular file')
    const prefix = Buffer.alloc(Number(before.size < 4096n ? before.size : 4096n))
    const prefixRead = await handle.read(prefix, 0, prefix.length, 0)
    try { assertTextBytes(prefix.subarray(0, prefixRead.bytesRead)) }
    catch (error) { throw new FileByteRangeError(error instanceof Error ? error.message : String(error)) }
    const version = revision(path, before)
    if (options.version !== undefined && options.version !== version) throw new FileByteRangeError('Source changed; restart reading at byte_offset=0 without source_version')
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER) || offset > Number(before.size)) throw new FileByteRangeError('Byte offset is outside the source')
    const totalBytes = Number(before.size)
    const buffer = Buffer.alloc(Math.min(limit, totalBytes - offset))
    let length = 0
    while (length < buffer.length) {
      options.signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, offset + length)
      if (!bytesRead) break
      length += bytesRead
    }
    options.signal?.throwIfAborted()
    const currentPath = resolvePath()
    const after = await handle.stat({ bigint: true })
    const current = await fs.stat(currentPath, { bigint: true })
    if (currentPath !== path || revision(path, after) !== version || revision(path, current) !== version || length !== buffer.length) {
      throw new FileByteRangeError('Source changed while reading; restart at byte_offset=0')
    }
    if (length && (buffer[0]! & 0xc0) === 0x80) throw new FileByteRangeError('Byte offset splits a UTF-8 character; use the returned nextOffset')
    let end = length
    if (length && offset + length < totalBytes) {
      let start = length - 1
      while (start > 0 && (buffer[start]! & 0xc0) === 0x80) start -= 1
      const first = buffer[start]!
      const width = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 : first <= 0xef && first >= 0xe0 ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0
      if (width > length - start) end = start
    }
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, end)) }
    catch { throw new FileByteRangeError('Source is not valid UTF-8 text in this range') }
    const endOffset = offset + end
    return { content, version, offset, endOffset, totalBytes, ...(endOffset < totalBytes ? { nextOffset: endOffset } : {}) }
  } finally { await handle.close() }
}
