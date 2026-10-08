import { describe, expect, it } from 'vitest'
import { applyPatchHunks, parseApplyPatch } from './applyPatch'

function apply(original: string, body: string): string {
  const operation = parseApplyPatch(`*** Begin Patch\n*** Update File: example.txt\n${body}\n*** End Patch`)[0]!
  if (operation.kind !== 'update') throw new Error('Expected update')
  return applyPatchHunks(original, operation.hunks, operation.path)
}

describe('patch location and source-order semantics', () => {
  it('handles a large repetitive file and long distinguishing context without stack overflow', () => {
    const source = 'a\n'.repeat(150_000) + 'tail\n'
    const body = '@@\n' + '-a\n'.repeat(60_000) + '-tail\n+changed'
    expect(apply(source, body)).toBe('a\n'.repeat(90_000) + 'changed\n')
  })
  it('uses a literal symbol anchor to select the later repeated block', () => {
    expect(apply('function first()\n  return old\nfunction second()\n  return old\n', '@@ function second()\n-  return old\n+  return new'))
      .toBe('function first()\n  return old\nfunction second()\n  return new\n')
  })
  it('uses an exact adjacent anchor to select the earlier repeated block', () => {
    expect(apply('first\nsame\nsecond\nsame\n', '@@ first\n-same\n+changed')).toBe('first\nchanged\nsecond\nsame\n')
  })
  it('supports consecutive anchor-only navigation before an edit', () => {
    expect(apply('class A\n  method\n    old\nclass B\n  method\n    old\n', '@@ class B\n@@   method\n-    old\n+    new'))
      .toBe('class A\n  method\n    old\nclass B\n  method\n    new\n')
  })
  it('fails when an explicit anchor is missing instead of ignoring it', () => {
    expect(() => apply('old\n', '@@ missing declaration\n-old\n+new')).toThrow('anchor')
  })
  it('rejects repeated anchors instead of choosing the first one', () => {
    expect(() => apply('fn\nold\nfn\nold\n', '@@ fn\n-old\n+new')).toThrow('ambiguous')
  })
  it('rejects remaining ambiguity after a nonadjacent anchor', () => {
    expect(() => apply('fn\ngap\nold\nold\n', '@@ fn\n-old\n+new')).toThrow('ambiguous')
  })
  it('advances across original source lines, unaffected by earlier insertions', () => {
    expect(apply('header\nfirst\nsame\nfooter\nsame\n', '@@\n first\n-same\n+more\n+changed\n@@\n-same\n+last'))
      .toBe('header\nfirst\nmore\nchanged\nfooter\nlast\n')
  })
  it('does not modify lines introduced by an earlier hunk', () => {
    expect(() => apply('a\nb\n', '@@\n-a\n+generated\n@@\n-generated\n+changed')).toThrow('expected lines')
  })
  it('rejects out-of-order or overlapping source hunks', () => {
    expect(() => apply('a\nb\nc\n', '@@\n-c\n+C\n@@\n-a\n+A')).toThrow('expected lines')
  })
  it('constrains an EOF-marked hunk to the actual suffix', () => {
    expect(apply('same\nmiddle\nsame\n', '@@\n-same\n+last\n*** End of File')).toBe('same\nmiddle\nlast\n')
    expect(() => apply('same\nmiddle\n', '@@\n-same\n+last\n*** End of File')).toThrow('end of file')
  })
  it('can append with EOF and can delete the suffix', () => {
    expect(apply('head\n', '@@\n+tail\n*** End of File')).toBe('head\ntail\n')
    expect(apply('head\ntail\n', '@@\n-tail\n*** End of File')).toBe('head\n')
  })
  it.each([
    '@@\n-old\n+new\n*** End of File\n+trailing',
    '@@\n-old\n+new\n*** End of File\n@@\n+trailing',
    '@@\n*** End of File',
    '@@broken\n-old\n+new',
    '@@ \n-old\n+new',
    '@@ old',
  ])('rejects invalid or no-change patch syntax: %s', body => {
    expect(() => apply('old\n', body)).toThrow()
  })
  it('validates explicit numeric locations instead of clamping them to EOF', () => {
    expect(() => apply('a\nb\n', '@@ -99,0 +99,1 @@\n+inserted')).toThrow('location')
    expect(apply('same\nsame\n', '@@ -2,1 +2,1 @@\n-same\n+new')).toBe('same\nnew\n')
    expect(() => apply('a\nb\n', '@@ -1,1 +1,1 @@\n-b\n+B')).toThrow('location')
    expect(() => apply('a\nb\n', '@@ -1,2 +1,1 @@\n-a\n+A')).toThrow('count')
  })
})
