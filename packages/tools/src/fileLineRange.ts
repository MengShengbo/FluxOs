import type { FileRangeResult } from '@fluxos/contracts/toolExecutor'

/** Bounded accumulation even when a physical line has no newline for gigabytes. */
export async function readTextLineRange(chunks: AsyncIterable<string>, offset: number, limit: number, maxBytes: number): Promise<FileRangeResult> {
  const lines: string[] = []
  let index = 0; let line = ''; let lineBytes = 0; let bytesRead = 0
  let truncated = false; let partialLine = false; let stop = false; let skipLF = false
  const append = (text: string) => {
    if (!text || index < offset || stop) return
    if (lines.length >= limit) { truncated = true; stop = true; return }
    const remaining = maxBytes - bytesRead - (lines.length ? 1 : 0) - lineBytes
    const bytes = Buffer.byteLength(text)
    if (bytes <= remaining) { line += text; lineBytes += bytes; return }
    truncated = true; stop = true
    if (lines.length) return // Keep a partial subsequent line for the next line page.
    const buffer = Buffer.from(text)
    let end = Math.max(0, remaining)
    while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1
    line += buffer.subarray(0, end).toString('utf8'); lineBytes += end
    lines.push(line); bytesRead = lineBytes; partialLine = true
  }
  const finish = () => {
    if (index >= offset) {
      if (lines.length >= limit || bytesRead + (lines.length ? 1 : 0) + lineBytes > maxBytes) { truncated = true; stop = true; return }
      bytesRead += (lines.length ? 1 : 0) + lineBytes; lines.push(line)
    }
    index += 1; line = ''; lineBytes = 0
  }
  for await (const chunk of chunks) {
    let start = 0
    if (skipLF && chunk.startsWith('\n')) start = 1
    if (chunk.length) skipLF = false
    for (let i = start; i < chunk.length && !stop; i += 1) {
      if (chunk[i] !== '\n' && chunk[i] !== '\r') continue
      append(chunk.slice(start, i)); if (stop) break
      finish(); if (stop) break
      if (chunk[i] === '\r') {
        if (chunk[i + 1] === '\n') i += 1
        else if (i === chunk.length - 1) skipLF = true
      }
      start = i + 1
    }
    if (!stop) append(chunk.slice(start))
    if (stop) break
  }
  if (!stop && lineBytes) finish()
  return { content: lines.join('\n'), startLine: offset + 1, endLine: offset + lines.length, truncated, bytesRead, partialLine }
}
