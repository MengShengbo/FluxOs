import { open } from 'node:fs/promises'

export const UNSUPPORTED_TEXT_FILE = 'Binary documents are not supported by text reading. Use a format-aware document parser; this result does not extract PDF/Office content or OCR.'

export function assertTextBytes(bytes: Uint8Array): void {
  const prefix = Buffer.from(bytes.subarray(0, 4096))
  if (prefix.includes(0) || prefix.subarray(0, 5).toString('ascii') === '%PDF-'
    || prefix.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]))) {
    throw new Error(UNSUPPORTED_TEXT_FILE)
  }
}

export async function assertTextFile(path: string): Promise<void> {
  const file = await open(path, 'r')
  try {
    const prefix = Buffer.alloc(4096)
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0)
    assertTextBytes(prefix.subarray(0, bytesRead))
  } finally { await file.close() }
}

export function decodeText(bytes: Uint8Array): string {
  assertTextBytes(bytes)
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw new Error('File is not valid UTF-8 text. Use an explicit encoding-aware parser; no lossy text was returned.') }
}

export async function* decodeTextStream(chunks: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  try {
    for await (const chunk of chunks) yield decoder.decode(chunk, { stream: true })
    const tail = decoder.decode()
    if (tail) yield tail
  } catch (error) {
    if (error instanceof TypeError) throw new Error('File is not valid UTF-8 text. Use an explicit encoding-aware parser.')
    throw error
  }
}
