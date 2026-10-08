import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeToolExecutor } from './nodeToolExecutor'
import { getToolByName } from './toolRegistry'
import { CodeNavigationService } from './codeNavigation'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fluxos-navigation-'))); roots.push(root)
  const executor = new NodeToolExecutor(root, { memoryRoot: join(root, '.fluxagent', 'memory'), runtimeLogsRoot: join(root, '.fluxagent', 'logs') })
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['*.ts'] }))
  writeFileSync(join(root, 'owner.ts'), 'export function add(x: number) { return x + 1 }\n')
  writeFileSync(join(root, 'use.ts'), 'import { add as plus } from "./owner"\nconst value = plus(1)\nfunction shadow(plus: (n: number) => number) { return plus(2) }\nconst wrong: string = 123\n')
  return { root, executor }
}

describe('real semantic navigation', () => {
  it('exposes a structured read-only navigation tool', () => {
    expect(getToolByName('code_navigation')).toMatchObject({ isReadOnly: true, isDestructive: false })
  })
  it('resolves an imported alias to the actual definition and excludes shadowed references', async () => {
    const { root, executor } = fixture()
    expect(typeof executor.navigateCode).toBe('function')
    const definition = await executor.navigateCode({ operation: 'definition', path: join(root, 'use.ts'), line: 2, column: 15 })
    expect(definition).toMatchObject({ success: true, data: { status: 'semantic', locations: [expect.objectContaining({ path: join(root, 'owner.ts'), line: 1, column: 17 })] } })
    const references = await executor.navigateCode({ operation: 'references', path: join(root, 'owner.ts'), line: 1, column: 17 })
    expect(references.success, references.error).toBe(true)
    expect(references.data!.locations.some(item => item.path.endsWith('use.ts') && item.line === 2)).toBe(true)
    expect(references.data!.locations.some(item => item.path.endsWith('use.ts') && item.line === 3)).toBe(false)
  })
  it('returns real diagnostic ranges and rejects a stale source version after edits', async () => {
    const { root, executor } = fixture()
    expect(typeof executor.navigateCode).toBe('function')
    const first = await executor.navigateCode({ operation: 'diagnostics', path: join(root, 'use.ts') })
    expect(first.success, first.error).toBe(true)
    expect(first.data!.locations).toContainEqual(expect.objectContaining({ path: join(root, 'use.ts'), line: 4, code: 2322, category: 'error' }))
    writeFileSync(join(root, 'use.ts'), '\nexport const fine: string = "ok"\n')
    expect(await executor.navigateCode({ operation: 'diagnostics', path: join(root, 'use.ts'), sourceVersion: first.data!.sourceVersion })).toMatchObject({ success: false, errorKind: 'validation' })
    const refreshed = await executor.navigateCode({ operation: 'diagnostics', path: join(root, 'use.ts') })
    expect(refreshed).toMatchObject({ success: true, data: { locations: [] } })
    expect(refreshed.data!.sourceVersion).not.toBe(first.data!.sourceVersion)
  })

  it('supports a configured JS project and reports real JSDoc type errors', async () => {
    const { root, executor } = fixture()
    rmSync(join(root, 'tsconfig.json'))
    writeFileSync(join(root, 'jsconfig.json'), JSON.stringify({ compilerOptions: { checkJs: true, allowJs: true }, include: ['*.js'] }))
    writeFileSync(join(root, 'module.js'), 'export const value = 1\n')
    writeFileSync(join(root, 'use.js'), 'import { value } from "./module.js"\n/** @type {string} */\nconst wrong = value\n')
    expect(await executor.navigateCode({ operation: 'definition', path: join(root, 'use.js'), line: 3, column: 15 })).toMatchObject({ success: true, data: { language: 'javascript', locations: [expect.objectContaining({ path: join(root, 'module.js'), line: 1 })] } })
    const diagnostics = await executor.navigateCode({ operation: 'diagnostics', path: join(root, 'use.js') })
    expect(diagnostics.data!.locations).toContainEqual(expect.objectContaining({ line: 3, code: 2322 }))
  })

  it('returns only text-search guidance for unsupported languages', async () => {
    const { root, executor } = fixture(); writeFileSync(join(root, 'script.py'), 'def plus(x): return x+1\n')
    expect(await executor.navigateCode({ operation: 'definition', path: join(root, 'script.py'), line: 1, column: 5 })).toMatchObject({ success: true, data: { status: 'unsupported', language: 'unsupported', locations: [], totalIsExact: false, fallback: { tool: 'search_content', semantic: false } } })
    const textEvidence = await executor.searchContentPage('plus', root, '*.py', false, { fixedStrings: true })
    expect(textEvidence).toMatchObject({ success: true, data: { hits: [expect.objectContaining({ file: join(root, 'script.py'), line: 1, text: 'def plus(x): return x+1' })] } })
  })

  it('keeps reference pages complete and rejects changes in another source file', async () => {
    const { root, executor } = fixture()
    const query = { operation: 'references' as const, path: join(root, 'owner.ts'), line: 1, column: 17, limit: 1 }
    const first = (await executor.navigateCode(query)).data!
    expect(first.nextOffset).toBe(1)
    let next = first; const all = [...first.locations]
    while (next.nextOffset !== undefined) {
      const response = await executor.navigateCode({ ...query, offset: next.nextOffset, projectVersion: first.projectVersion })
      expect(response.success, response.error).toBe(true); next = response.data!; all.push(...next.locations)
    }
    expect(all).toHaveLength(first.total)
    expect(new Set(all.map(item => `${item.path}:${item.line}:${item.column}`)).size).toBe(all.length)
    writeFileSync(join(root, 'use.ts'), '\nimport { add } from "./owner"\nadd(4)\n')
    expect(await executor.navigateCode({ ...query, offset: 1, projectVersion: first.projectVersion })).toMatchObject({ success: false, errorKind: 'validation' })
    const refreshed = (await executor.navigateCode({ ...query, limit: 100 })).data!
    expect(refreshed.projectVersion).not.toBe(first.projectVersion)
    expect(refreshed.locations).toContainEqual(expect.objectContaining({ path: join(root, 'use.ts'), line: 3 }))
  }, 15_000)

  it('uses UTF-16 positions across BOM, CRLF and astral Unicode without splitting characters', async () => {
    const { root, executor } = fixture()
    const firstLine = '\uFEFFconst emoji="🙂"; export const value=1;'
    writeFileSync(join(root, 'unicode.ts'), `${firstLine}\r\nvalue\r\n`)
    expect(await executor.navigateCode({ operation: 'definition', path: join(root, 'unicode.ts'), line: 2, column: 1 })).toMatchObject({ success: true, data: { locations: [expect.objectContaining({ line: 1, column: firstLine.indexOf('value') + 1, endColumn: firstLine.indexOf('value') + 6 })] } })
    expect(await executor.navigateCode({ operation: 'definition', path: join(root, 'unicode.ts'), line: 1, column: firstLine.indexOf('🙂') + 2 })).toMatchObject({ success: false, errorKind: 'validation' })
  })

  it('honors extends, path aliases, excludes and includes a sibling source directory', async () => {
    const { root, executor } = fixture(); mkdirSync(join(root, 'app')); mkdirSync(join(root, 'shared'))
    writeFileSync(join(root, 'base.json'), JSON.stringify({ compilerOptions: { strict: true, moduleResolution: 'Bundler', module: 'ESNext', baseUrl: '.', paths: { '@shared/*': ['shared/*'] } } }))
    writeFileSync(join(root, 'app', 'tsconfig.json'), JSON.stringify({ extends: '../base.json', include: ['*.ts', '../shared/**/*.ts'], exclude: ['ignored.ts'] }))
    writeFileSync(join(root, 'shared', 'value.ts'), 'export const value=1\n')
    writeFileSync(join(root, 'shared', 'use.ts'), 'import { value } from "./value"\nvalue\n')
    writeFileSync(join(root, 'app', 'main.ts'), 'import { value } from "@shared/value"\nvalue\n')
    writeFileSync(join(root, 'app', 'ignored.ts'), 'import { value } from "@shared/value"\nvalue\n')
    const response = await executor.navigateCode({ operation: 'references', path: join(root, 'app', 'main.ts'), line: 2, column: 1 })
    expect(response.success, response.error).toBe(true)
    expect(response.data!.locations).toContainEqual(expect.objectContaining({ path: join(root, 'shared', 'use.ts'), line: 2 }))
    expect(response.data!.locations.some(item => item.path.endsWith('ignored.ts'))).toBe(false)
  })

  it('never executes project plugins and confines symlinked dependency reads', async () => {
    const { root, executor } = fixture(); const external = fixture()
    writeFileSync(join(external.root, 'private.ts'), 'export const privateValue="secret-value"\n')
    symlinkSync(join(external.root, 'private.ts'), join(root, 'linked.ts'))
    writeFileSync(join(root, 'plugin.cjs'), 'require("node:fs").writeFileSync(__dirname+"/executed", "bad"); module.exports=()=>{}\n')
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { plugins: [{ name: './plugin.cjs' }] }, include: ['*.ts'] }))
    writeFileSync(join(root, 'use.ts'), 'import {privateValue} from "./linked"\nprivateValue\n')
    const response = await executor.navigateCode({ operation: 'definition', path: join(root, 'use.ts'), line: 2, column: 1 })
    expect(response.success, response.error).toBe(true)
    expect(response.data!.issues.length).toBeGreaterThan(0)
    expect(JSON.stringify(response)).not.toContain('secret-value')
    expect(response.data!.locations.some(item => item.path.startsWith(external.root))).toBe(false)
    expect(existsSync(join(root, 'executed'))).toBe(false)
    expect(await executor.navigateCode({ operation: 'diagnostics', path: join(root, 'linked.ts') })).toMatchObject({ success: false, errorKind: 'permission' })
  })

  it('cancels a real worker promptly and keeps the host event loop responsive', async () => {
    const { root, executor } = fixture(); const controller = new AbortController(); let timerFired = false
    const timer = setTimeout(() => { timerFired = true; controller.abort() }, 30)
    try {
      expect(await executor.navigateCode({ operation: 'diagnostics', path: join(root, 'use.ts'), signal: controller.signal })).toMatchObject({ success: false, errorKind: 'abort' })
      expect(timerFired).toBe(true)
      expect((await executor.navigateCode({ operation: 'diagnostics', path: join(root, 'use.ts') })).success).toBe(true)
    } finally { clearTimeout(timer) }
  })

  it('fails explicitly on source budget overflow and invalid source encodings', async () => {
    const { root, executor } = fixture()
    writeFileSync(join(root, 'big.ts'), ' '.repeat(2 * 1024 * 1024 + 1))
    expect(await executor.navigateCode({ operation: 'diagnostics', path: join(root, 'big.ts') })).toMatchObject({ success: false, errorKind: 'environment', error: expect.stringContaining('budget') })
    rmSync(join(root, 'big.ts')); writeFileSync(join(root, 'bad.ts'), Buffer.from([0xff]))
    expect(await executor.navigateCode({ operation: 'diagnostics', path: join(root, 'bad.ts') })).toMatchObject({ success: false, errorKind: 'environment' })
  })

  it('bounds worker time and concurrency, then releases occupied slots after cancellation', async () => {
    const { root } = fixture(); const request = { operation: 'diagnostics' as const, path: join(root, 'use.ts') }
    expect(await new CodeNavigationService(1).run(root, request)).toMatchObject({ success: false, errorKind: 'environment', error: expect.stringContaining('worker terminated') })
    const service = new CodeNavigationService(); const controller = new AbortController()
    const first = service.run(root, { ...request, signal: controller.signal }); const second = service.run(root, { ...request, signal: controller.signal })
    expect(await service.run(root, request)).toMatchObject({ success: false, errorKind: 'environment', error: expect.stringContaining('already running') })
    controller.abort()
    for (const result of await Promise.all([first, second])) expect(result).toMatchObject({ success: false, errorKind: 'abort' })
    expect((await service.run(root, request)).success).toBe(true)
  })
})
