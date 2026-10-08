import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyPatchHunks, parseApplyPatch } from './applyPatch'

// Apache-2.0 upstream fixtures; see the adjacent provenance and license files.
const fixtureRoot = new URL('./__fixtures__/applyPatchCodex/', import.meta.url)
const scenarios = ['003_multiple_chunks', '016_pure_addition_update_chunk', '022_update_file_end_of_file_marker']
describe('fixed Codex source fixture differential', () => {
  it.each(scenarios)('matches the upstream expected bytes for %s', scenario => {
    const patch = readFileSync(new URL(`${scenario}/patch.txt`, fixtureRoot), 'utf8')
    const operations = parseApplyPatch(patch)
    expect(operations).toHaveLength(1)
    const operation = operations[0]!
    if (operation.kind !== 'update') throw new Error('Expected update')
    const before = readFileSync(new URL(`${scenario}/input/${operation.path}`, fixtureRoot), 'utf8')
    const expected = readFileSync(new URL(`${scenario}/expected/${operation.path}`, fixtureRoot))
    expect(Buffer.from(applyPatchHunks(before, operation.hunks, operation.path))).toEqual(expected)
  })
})
