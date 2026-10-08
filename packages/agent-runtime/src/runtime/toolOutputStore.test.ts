import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolOutputStore } from './toolOutputStore'

afterEach(() => vi.useRealTimers())
const call = { id: 'fixture', name: 'fixture__read', arguments: {} }
const allow = () => {}
describe('ephemeral tool output sources', () => {
  it('expires immutable sources, isolates scopes and clears session state', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    const store = new ToolOutputStore()
    const source = store.save('text🙂', call, 'workspace-a')!
    expect(store.read(source.id, 0, 5, 'workspace-a', allow)).toMatchObject({ output: 'text', outputSource: { nextOffset: 4 } })
    expect(store.read(source.id, 4, 2, 'workspace-a', allow)).toMatchObject({ output: '🙂', outputSource: { nextOffset: undefined } })
    expect(() => store.read(source.id, 5, 2, 'workspace-a', allow)).toThrow('splits a character')
    expect(() => store.read(source.id, 0, 10, 'workspace-b', allow)).toThrow('unavailable')
    vi.advanceTimersByTime(600_000)
    expect(() => store.read(source.id, 0, 10, 'workspace-a', allow)).toThrow('expired')
    const current = store.save('new', call, 'workspace-a')!; store.clear()
    expect(() => store.read(current.id, 0, 10, 'workspace-a', allow)).toThrow('unavailable')
  })

  it('bounds count and aggregate memory and rejects oversized sources instead of storing partial text', () => {
    const store = new ToolOutputStore({ entries: 2, sourceChars: 1000, totalChars: 1500, ttlMs: 60_000 })
    const first = store.save('a'.repeat(650), call, 'scope')!
    const second = store.save('b'.repeat(650), call, 'scope')!
    expect(store.save('x'.repeat(1001), call, 'scope')).toBeUndefined()
    const third = store.save('c'.repeat(650), call, 'scope')!
    expect(() => store.read(first.id, 0, 10, 'scope', allow)).toThrow('evicted')
    expect(store.read(second.id, 0, 10, 'scope', allow).output).toBe('b'.repeat(10))
    expect(store.read(third.id, 0, 10, 'scope', allow).output).toBe('c'.repeat(10))
    const budget = new ToolOutputStore({ entries: 10, sourceChars: 1000, totalChars: 1100, ttlMs: 60_000 })
    const evicted = budget.save('d'.repeat(650), call, 'scope')!
    budget.save('e'.repeat(650), call, 'scope')
    expect(() => budget.read(evicted.id, 0, 10, 'scope', allow)).toThrow('evicted')
  })

  it('copies source arguments, checks authorization per page and rejects invalid ranges', () => {
    const store = new ToolOutputStore(); const original = { ...call, arguments: { path: 'original' } }
    const source = store.save('payload', original, 'scope')!; original.arguments.path = 'changed'
    const authorize = vi.fn((sourceCall: typeof original) => { expect(sourceCall.arguments.path).toBe('original'); sourceCall.arguments.path = 'mutated callback copy' })
    store.read(source.id, 0, 2, 'scope', authorize); store.read(source.id, 2, 2, 'scope', authorize)
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(() => store.read(source.id, 0, 2, 'scope', () => { throw new Error('policy revoked') })).toThrow('policy revoked')
    for (const [offset, limit] of [[-1, 2], [1.5, 2], [8, 2], [0, 1], [0, 16001], [0, NaN]]) {
      expect(() => store.read(source.id, offset!, limit!, 'scope', allow)).toThrow('Invalid source range')
    }
  })
})
