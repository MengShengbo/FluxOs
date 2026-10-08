import { describe, expect, it } from 'vitest'
import { readTextLineRange } from './fileLineRange'

async function* chunks(values: string[]) { for (const value of values) yield value }
describe('bounded line accumulation', () => {
  it('stops before consuming a giant physical line beyond the preview budget', async () => {
    let consumed = 0
    async function* source() { for (let i = 0; i < 1000; i += 1) { consumed += 1; yield '中'.repeat(5000) } }
    const result = await readTextLineRange(source(), 0, 200, 4096)
    expect(result).toMatchObject({ partialLine: true, truncated: true, bytesRead: 4095 })
    expect(consumed).toBe(1)
    expect(result.content).toBe('中'.repeat(1365))
  })
  it('skips a giant line with bounded memory and handles split CRLF, CR and blank lines', async () => {
    const result = await readTextLineRange(chunks(['x'.repeat(100_000), '\r', '\nfirst\rsecond\n\nthird\n']), 1, 4, 4096)
    expect(result).toMatchObject({ content: 'first\nsecond\n\nthird', startLine: 2, endLine: 5, truncated: false, bytesRead: 19 })
  })
  it('keeps the next line for continuation when remaining bytes cannot contain it', async () => {
    expect(await readTextLineRange(chunks(['first\n', 'x'.repeat(5000)]), 0, 20, 4096)).toMatchObject({ content: 'first', truncated: true, partialLine: false, bytesRead: 5 })
  })
  it('keeps a complete replacement character at the truncation boundary', async () => {
    expect(await readTextLineRange(chunks(['\uFFFDx']), 0, 20, 3)).toMatchObject({ content: '\uFFFD', bytesRead: 3, partialLine: true })
  })
  it.each([['', '', 0], ['\n', '', 1], ['a\n', 'a', 1], ['a\r\nb', 'a\nb', 2]])('handles EOF for %j', async (input, content, endLine) => {
    expect(await readTextLineRange(chunks([String(input)]), 0, 20, 4096)).toMatchObject({ content, endLine, truncated: false })
  })
})
