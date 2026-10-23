import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AtomicJsonStore } from './atomicJsonStore'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('AtomicJsonStore', () => {
  it('preserves a store path when reading it fails instead of treating an I/O error as corrupt JSON', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fluxagent-store-read-error-'))
    directories.push(directory)
    const path = join(directory, 'state.json')
    mkdirSync(path)
    writeFileSync(join(path, 'keep.txt'), 'original')
    const store = new AtomicJsonStore(path, () => ({ value: '' }), (value): value is { value: string } => Boolean(value && typeof value === 'object'))
    expect(() => store.load()).toThrow()
    expect(readFileSync(join(path, 'keep.txt'), 'utf8')).toBe('original')
    expect(readdirSync(directory)).toEqual(['state.json'])
  })

  it('cleans up temporary files after an atomic replace fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fluxagent-store-write-error-'))
    directories.push(directory)
    const path = join(directory, 'state.json')
    mkdirSync(path)
    const store = new AtomicJsonStore(path, () => ({ value: '' }), (value): value is { value: string } => Boolean(value && typeof value === 'object'))
    expect(() => store.save({ value: 'new' })).toThrow()
    expect(readdirSync(directory)).toEqual(['state.json'])
  })

  it('persists values with an atomic replace and reloads them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fluxagent-store-'))
    directories.push(directory)
    const path = join(directory, 'state.json')
    const validate = (value: unknown): value is { schemaVersion: 1; value: string } => Boolean(value && typeof value === 'object' && (value as any).schemaVersion === 1 && typeof (value as any).value === 'string')
    const store = new AtomicJsonStore(path, () => ({ schemaVersion: 1 as const, value: '' }), validate)
    store.save({ schemaVersion: 1, value: 'saved' })
    expect(new AtomicJsonStore(path, () => ({ schemaVersion: 1 as const, value: '' }), validate).load()).toEqual({ value: { schemaVersion: 1, value: 'saved' }, warnings: [] })
    expect(readFileSync(path, 'utf8')).toContain('saved')
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('moves corrupt data aside and returns a recoverable warning', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fluxagent-store-'))
    directories.push(directory)
    const path = join(directory, 'state.json')
    writeFileSync(path, '{broken')
    const store = new AtomicJsonStore(path, () => ({ schemaVersion: 1 as const, items: [] as string[] }), (value): value is { schemaVersion: 1; items: string[] } => Boolean(value && typeof value === 'object' && (value as any).schemaVersion === 1))
    const loaded = store.load()
    expect(loaded.value.items).toEqual([])
    expect(loaded.warnings[0]).toContain('Recovered an invalid store')
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(directory).some(name => name.startsWith('state.json.corrupt-'))).toBe(true)
  })
})
