import { describe, expect, it } from 'vitest'
import { applyPatchHunks, parseApplyPatch } from './applyPatch'

const apply = (source: string, body: string) => {
  const operation = parseApplyPatch(`*** Begin Patch\n*** Update File: a.txt\n${body}\n*** End Patch`)[0]!
  if (operation.kind !== 'update') throw new Error('Expected update')
  return applyPatchHunks(source, operation.hunks, 'a.txt')
}

describe('patch byte preservation', () => {
  it.each(['\n', '\r\n', '\r'])('keeps the source line ending %j', ending => {
    expect(apply(`a${ending}old${ending}z${ending}`, '@@\n a\n-old\n+new\n z')).toBe(`a${ending}new${ending}z${ending}`)
  })
  it('keeps every unchanged context terminator in a mixed file', () => {
    expect(apply('a\r\nb\nold\rz\r\n', '@@\n a\n b\n-old\n+new\n z')).toBe('a\r\nb\nnew\rz\r\n')
  })
  it('preserves literal BOM, Unicode, whitespace and unmodified final bytes', () => {
    expect(apply('\uFEFF头部\r\nold\n末尾  ', '@@\n-old\n+new')).toBe('\uFEFF头部\r\nnew\n末尾  ')
  })
  it.each(['old', 'head\r\nold'])('does not append a newline when replacing unterminated EOF: %j', source => {
    expect(apply(source, '@@\n-old\n+new\n*** End of File')).toBe(source.replace('old', 'new'))
  })
  it.each(['', '\n', '\r\n', '\r'])('retains terminal convention %j for inserted EOF lines', ending => {
    const source = `head${ending}`
    const separator = ending || '\n'
    expect(apply(source, '@@\n+tail\n*** End of File')).toBe(`head${separator}tail${ending}`)
  })
  it('can delete all bytes, including the final newline', () => {
    expect(apply('old\r\n', '@@\n-old\n*** End of File')).toBe('')
    expect(apply('old', '@@\n-old\n*** End of File')).toBe('')
  })
  it('does not remove an unrelated context newline when deleting the unterminated suffix', () => {
    expect(apply('head\r\ntail', '@@\n-tail\n*** End of File')).toBe('head\r\n')
  })
  it('retains blank lines at EOF without collapsing them', () => {
    expect(apply('a\r\nold\r\n\r\n', '@@\n-old\n+new')).toBe('a\r\nnew\r\n\r\n')
  })
  it('uses a neighboring terminator for a middle insertion', () => {
    expect(apply('a\r\nb\nc\r\n', '@@\n b\n+inserted\n c')).toBe('a\r\nb\ninserted\nc\r\n')
  })
  it('preserves paired replacement terminators for mixed multi-line changes', () => {
    expect(apply('a\r\nb\nc\r\nz', '@@\n-a\n-b\n+A\n+B')).toBe('A\r\nB\nc\r\nz')
  })
  it('adds empty files as zero bytes and retains every explicit added blank line', () => {
    const empty = parseApplyPatch('*** Begin Patch\n*** Add File: empty.txt\n*** End Patch')[0]!
    const blank = parseApplyPatch('*** Begin Patch\n*** Add File: blank.txt\n+\n+\n*** End Patch')[0]!
    expect(empty).toMatchObject({ kind: 'add', content: '' })
    expect(blank).toMatchObject({ kind: 'add', content: '\n\n' })
  })
  it('keeps distinct case spellings for executor-level filesystem resolution', () => {
    expect(parseApplyPatch('*** Begin Patch\n*** Add File: A.ts\n+A\n*** Add File: a.ts\n+a\n*** End Patch')).toHaveLength(2)
  })
  it('preserves filename spaces rather than trimming the declared name', () => {
    expect(parseApplyPatch('*** Begin Patch\n*** Add File:  spaced \n+data\n*** End Patch')[0]?.path).toBe(' spaced ')
  })
})
