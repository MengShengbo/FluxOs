import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureAutomationWorkspaceIdentity } from './automationCheckpoint'

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, readSync: vi.fn(fs.readSync) }
})

const roots: string[] = []
const actualRead = vi.mocked(readSync).getMockImplementation()!
afterEach(() => {
  vi.mocked(readSync).mockReset().mockImplementation(actualRead)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(commit = true) {
  const root = mkdtempSync(join(tmpdir(), 'automation-content-'))
  roots.push(root)
  const path = join(root, 'workspace')
  mkdirSync(path)
  const gitConfig = join(root, 'empty-gitconfig')
  writeFileSync(gitConfig, '')
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' },
  })
  git('init', '-q', '--template=')
  git('config', 'user.name', 'Automation Fixture')
  git('config', 'user.email', 'automation@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(path, 'tracked.txt'), 'committed\n')
  if (commit) {
    git('add', 'tracked.txt')
    git('commit', '-qm', 'fixture')
  }
  return { path, root, git }
}

describe('automation workspace content identity', () => {
  it('distinguishes two dirty versions with the same status, size and restored mtime', () => {
    const { path, git } = workspace()
    const file = join(path, 'tracked.txt')
    writeFileSync(file, 'version-a\n')
    const stat = statSync(file)
    const first = captureAutomationWorkspaceIdentity(path)
    const status = git('status', '--porcelain=v2', '-z')
    writeFileSync(file, 'version-b\n')
    utimesSync(file, stat.atime, stat.mtime)
    const second = captureAutomationWorkspaceIdentity(path)
    expect(git('status', '--porcelain=v2', '-z')).toBe(status)
    expect(first.complete).toBe(true)
    expect(second.complete).toBe(true)
    expect(second.fingerprint).not.toBe(first.fingerprint)
  })

  it.each(['untracked.txt', 'ignored/config.json', 'name with\nnewline.txt'])('hashes actual contents of %s', name => {
    const { path, git } = workspace()
    writeFileSync(join(path, '.gitignore'), 'ignored/\n')
    mkdirSync(join(path, 'ignored'))
    writeFileSync(join(path, name), 'first')
    const status = git('status', '--porcelain=v2', '-z')
    const first = captureAutomationWorkspaceIdentity(path)
    writeFileSync(join(path, name), 'other')
    const second = captureAutomationWorkspaceIdentity(path)
    expect(git('status', '--porcelain=v2', '-z')).toBe(status)
    expect(second.complete).toBe(true)
    expect(second.fingerprint).not.toBe(first.fingerprint)
  })

  it('is stable across identical scans and records its explicit coverage', () => {
    const { path } = workspace()
    const first = captureAutomationWorkspaceIdentity(path)
    expect(captureAutomationWorkspaceIdentity(path)).toEqual(first)
    expect(first.coverage).toMatchObject({
      algorithm: 'sha256-workspace-content-v1',
      scope: 'workspace-files-including-ignored',
      excludedPaths: ['.git'],
      issues: [],
    })
    expect(first.coverage.hashedBytes).toBe(Buffer.byteLength('committed\n'))
  })

  it('detects rename and delete, including an empty directory rename', () => {
    const { path } = workspace()
    mkdirSync(join(path, 'empty'))
    const before = captureAutomationWorkspaceIdentity(path)
    renameSync(join(path, 'tracked.txt'), join(path, 'renamed.txt'))
    const renamed = captureAutomationWorkspaceIdentity(path)
    rmSync(join(path, 'renamed.txt'))
    const deleted = captureAutomationWorkspaceIdentity(path)
    renameSync(join(path, 'empty'), join(path, 'renamed-empty'))
    const movedDirectory = captureAutomationWorkspaceIdentity(path)
    expect([before, renamed, deleted, movedDirectory].every(value => value.complete)).toBe(true)
    expect(new Set([before, renamed, deleted, movedDirectory].map(value => value.fingerprint)).size).toBe(4)
  })

  it('covers internal links and refuses to claim coverage of external or dangling targets', () => {
    const { path, root } = workspace()
    symlinkSync('tracked.txt', join(path, 'internal'))
    const first = captureAutomationWorkspaceIdentity(path)
    expect(first.complete).toBe(true)
    writeFileSync(join(path, 'tracked.txt'), 'link-target-changed')
    expect(captureAutomationWorkspaceIdentity(path).fingerprint).not.toBe(first.fingerprint)
    writeFileSync(join(root, 'external.txt'), 'outside')
    symlinkSync('../external.txt', join(path, 'external'))
    const external = captureAutomationWorkspaceIdentity(path)
    expect(external.complete).toBe(false)
    expect(external.coverage.issues).toContainEqual({ code: 'external_symlink', path: 'external' })
    rmSync(join(path, 'external'))
    symlinkSync('missing', join(path, 'dangling'))
    expect(captureAutomationWorkspaceIdentity(path).complete).toBe(false)
  })

  it.each([
    { maxEntries: 0 }, { maxBytes: 1 }, { maxFileBytes: 1 }, { maxDurationMs: 0 },
  ])('fails closed when the scan budget is exhausted: %j', limits => {
    const { path } = workspace()
    const result = captureAutomationWorkspaceIdentity(path, limits)
    expect(result.complete).toBe(false)
    expect(result.coverage.issues.some(issue => issue.code === 'budget_exceeded')).toBe(true)
  })

  it('does not turn a read failure into a complete partial fingerprint', () => {
    const { path } = workspace()
    vi.mocked(readSync).mockImplementationOnce(() => { throw new Error('injected read failure') })
    const result = captureAutomationWorkspaceIdentity(path)
    expect(result.complete).toBe(false)
    expect(result.coverage.issues).toContainEqual({ code: 'unreadable', path: 'tracked.txt' })
  })

  it('detects a mutation during scanning', () => {
    const { path } = workspace()
    const read = vi.mocked(readSync).getMockImplementation()!
    vi.mocked(readSync).mockImplementationOnce((...args: Parameters<typeof readSync>) => {
      writeFileSync(join(path, 'tracked.txt'), 'changed while reading')
      return read(...args)
    })
    const result = captureAutomationWorkspaceIdentity(path)
    expect(result.complete).toBe(false)
    expect(result.coverage.issues).toContainEqual({ code: 'changed_during_scan', path: 'tracked.txt' })
  })

  it('handles unborn Git repositories and reports non-Git and nested repository coverage gaps', () => {
    const { path, root, git } = workspace(false)
    expect(captureAutomationWorkspaceIdentity(path)).toMatchObject({ complete: true, gitHead: undefined })
    expect(captureAutomationWorkspaceIdentity(root).complete).toBe(false)
    mkdirSync(join(path, 'nested'))
    git('-C', join(path, 'nested'), 'init', '-q', '--template=')
    const result = captureAutomationWorkspaceIdentity(path)
    expect(result.complete).toBe(false)
    expect(result.coverage.issues).toContainEqual({ code: 'nested_repository', path: 'nested/.git' })
  })

  it('rechecks an earlier file that changes while a later file is being scanned', () => {
    const { path } = workspace()
    writeFileSync(join(path, 'z-last'), 'last')
    let reads = 0
    vi.mocked(readSync).mockImplementation((...args: Parameters<typeof readSync>) => {
      const count = actualRead(...args)
      if (++reads === 3) writeFileSync(join(path, 'tracked.txt'), 'late change')
      return count
    })
    const result = captureAutomationWorkspaceIdentity(path)
    expect(result.complete).toBe(false)
    expect(result.coverage.issues).toContainEqual({ code: 'changed_during_scan', path: 'tracked.txt' })
  })

  it.skipIf(process.platform === 'win32')('refuses special files without opening a blocking FIFO', () => {
    const { path } = workspace()
    execFileSync('mkfifo', [join(path, 'pipe')])
    const result = captureAutomationWorkspaceIdentity(path)
    expect(result.complete).toBe(false)
    expect(result.coverage.issues).toContainEqual({ code: 'unsupported_entry', path: 'pipe' })
  })
})
