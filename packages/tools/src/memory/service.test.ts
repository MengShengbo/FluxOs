import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Memory } from '@fluxos/contracts/memoryTypes'
import { MemoryService } from './service'

const roots: string[] = []
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'fluxagent-memory-service-'))
  roots.push(root)
  return root
}
function fact(id: number, text = `Fact number ${id}`): Memory {
  return { id: `fact-${id}`, text, scope: 'workspace_private', kind: 'fact', source: 'test', evidence: [],
    confidence: 'observed', createdAt: id, updatedAt: id, pinned: false, tags: [], reviewState: 'auto', status: 'active' }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('persistent memory retrieval', () => {
  it('queries, injects, updates and forgets facts beyond the old 32-entry read boundary', async () => {
    const root = workspace(), store = join(root, '.fluxagent', 'memory', 'facts.jsonl')
    mkdirSync(dirname(store), { recursive: true })
    writeFileSync(store, Array.from({ length: 500 }, (_, i) => JSON.stringify(fact(i, i === 499 ? 'lateuniquetarget' : undefined))).join('\n') + '\n')
    const service = new MemoryService()
    expect((await service.getSnapshot(root)).totalCount).toBe(500)
    expect(await service.query({ workspacePath: root, query: 'lateuniquetarget' })).toEqual([expect.objectContaining({ id: 'fact-499' })])
    expect((await service.getRelevantInjection(root, 'lateuniquetarget', { baselineRules: 0 })).text).toContain('lateuniquetarget')
    expect(await service.update({ workspacePath: root, id: 'fact-499', pinned: true })).toEqual({ success: true })
    expect(await service.forget({ workspacePath: root, id: 'fact-499' })).toEqual({ success: true })
    expect(await service.query({ workspacePath: root, query: 'lateuniquetarget' })).toEqual([])
    expect(await service.query({ workspacePath: root, query: 'lateuniquetarget', includeStale: true })).toEqual([expect.objectContaining({ status: 'rejected', pinned: true })])
  })

  it('finds Chinese words and single characters inside unsegmented text, including long memories', async () => {
    const root = workspace(), service = new MemoryService()
    await service.remember({ workspacePath: root, text: '项目部署需要先构建再上传服务器。' + '其他上下文'.repeat(60) })
    await service.remember({ workspacePath: root, text: '界面使用蓝色主题' })
    for (const query of ['部署', '部署 构建', '项目部署', '服']) {
      expect(await service.query({ workspacePath: root, query })).toEqual([expect.objectContaining({ text: expect.stringContaining('项目部署') })])
      expect((await service.getRelevantInjection(root, query, { baselineRules: 0 })).text).toContain('项目部署')
    }
    expect(await service.query({ workspacePath: root, query: '数据库' })).toEqual([])
  })

  it('matches camel case names and mixed Chinese and English queries', async () => {
    const root = workspace(), service = new MemoryService()
    await service.remember({ workspacePath: root, text: '部署由 runtimeHost 管理' })
    expect(await service.query({ workspacePath: root, query: '部署 host' })).toHaveLength(1)
    expect(await service.query({ workspacePath: root, query: 'Host' })).toHaveLength(1)
  })

  it('keeps project rules and pinned facts ahead of a large fact history and reports only rendered items', async () => {
    const root = workspace(), service = new MemoryService()
    const store = join(root, '.fluxagent', 'memory', 'facts.jsonl')
    mkdirSync(dirname(store), { recursive: true })
    const facts = Array.from({ length: 40 }, (_, i) => fact(i, `Unrelated history ${i} ` + 'padding '.repeat(40)))
    facts.push({ ...fact(40, 'Pinned preference'), pinned: true })
    writeFileSync(store, facts.map(item => JSON.stringify(item)).join('\n') + '\n')
    writeFileSync(join(root, 'AGENTS.md'), Array.from({ length: 8 }, (_, i) => `- Mandatory rule ${i}`).join('\n'))
    const snapshot = await service.getSnapshot(root)
    expect(snapshot.injectionText.indexOf('Mandatory rule 7')).toBeLessThan(snapshot.injectionText.indexOf('Unrelated history'))
    expect(snapshot.injectionText).toContain('Pinned preference')
    const relevant = await service.getRelevantInjection(root, 'unknownquery')
    expect(relevant.text).toContain('Mandatory rule 7')
    expect(relevant.text).toContain('Pinned preference')
    expect(relevant.text).not.toContain('Unrelated history')
    expect(relevant.includedCount).toBe(9)
    const bounded = await service.getRelevantInjection(root, 'history', { tokenBudget: 200 })
    expect(bounded.includedCount).toBeLessThan(49)
    expect(bounded.includedCount).toBe((bounded.text.match(/  - <(?:rule|fact)\b/g) ?? []).length)
  })

  it.each(['FLUXAGENT.md', 'fluxagent.md', '.fluxagent/FLUXAGENT.md'])('refreshes cached %s rules after edits and deletion', async file => {
    const root = workspace(), source = join(root, file), service = new MemoryService()
    mkdirSync(dirname(source), { recursive: true })
    writeFileSync(source, '- Build before deploy')
    expect((await service.getSnapshot(root)).injectionText).toContain('Build before deploy')
    writeFileSync(source, '- Verify before publish')
    expect((await service.getSnapshot(root)).injectionText).toContain('Verify before publish')
    rmSync(source)
    expect((await service.getSnapshot(root)).injectionText).not.toContain('Verify before publish')
  })
})

describe('profile global memory', () => {
  it('shares global changes across workspaces and service caches while keeping private memories and profiles isolated', async () => {
    const root = workspace(), global = join(root, 'profile-a', 'memory')
    const a = new MemoryService(join(root, 'a-private'), global)
    const b = new MemoryService(join(root, 'b-private'), global)
    const otherProfile = new MemoryService(join(root, 'other-private'), join(root, 'profile-b', 'memory'))
    await b.getSnapshot(root)
    await a.remember({ workspacePath: root, text: 'Project private preference' })
    const created = await a.remember({ workspacePath: root, text: 'Prefer Chinese replies', scope: 'global' })
    expect(created.success).toBe(true)
    expect((await b.getSnapshot(root)).groups.flatMap(group => group.items)).toEqual([expect.objectContaining({ id: created.id, scope: 'global' })])
    expect(await otherProfile.query({ workspacePath: root })).toEqual([])
    expect(readFileSync(join(global, 'facts.jsonl'), 'utf8')).toContain(created.id)
    expect(readFileSync(join(root, 'a-private', 'facts.jsonl'), 'utf8')).not.toContain(created.id)
    expect(await b.update({ workspacePath: root, id: created.id!, text: 'Prefer concise Chinese replies', pinned: true })).toEqual({ success: true })
    expect(await a.query({ workspacePath: root, query: 'concise' })).toEqual([expect.objectContaining({ id: created.id, pinned: true })])
    expect(await b.forget({ workspacePath: root, id: created.id! })).toEqual({ success: true })
    expect(await a.query({ workspacePath: root, scope: 'global' })).toEqual([])
    expect(await a.query({ workspacePath: root, scope: 'global', includeStale: true })).toHaveLength(1)
    expect(await b.update({ workspacePath: root, id: created.id!, status: 'active' })).toEqual({ success: true })
    expect((await a.getRelevantInjection(root, 'Chinese')).text).toContain('Prefer concise Chinese replies')
  })

  it('rejects unavailable global storage and cross-store scope edits without silently filing memories in the wrong store', async () => {
    const root = workspace(), service = new MemoryService()
    expect(await service.remember({ workspacePath: root, text: 'Global preference', scope: 'global' })).toMatchObject({ success: false })
    const created = await service.remember({ workspacePath: root, text: 'Private preference' })
    expect(await service.update({ workspacePath: root, id: created.id!, scope: 'global' })).toMatchObject({ success: false })
    expect(await service.query({ workspacePath: root })).toEqual([expect.objectContaining({ scope: 'workspace_private' })])
  })
})
