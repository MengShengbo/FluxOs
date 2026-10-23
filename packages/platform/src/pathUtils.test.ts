import { describe, expect, it } from 'vitest'
import { normalizePath, resolvePath, toWorkspaceRelative } from './pathUtils'

describe('resolvePath', () => {
  it('preserves network share roots and prevents parent traversal from removing the server or share', () => {
    expect(resolvePath('C:/workspace', '\\\\server\\share\\folder\\file.txt')).toBe('//server/share/folder/file.txt')
    expect(resolvePath('//server/share/project', '../../../file.txt')).toBe('//server/share/file.txt')
    expect(resolvePath('//server/share/project', '/src/app.ts')).toBe('//server/share/project/src/app.ts')
    expect(toWorkspaceRelative('//SERVER/SHARE', '//server/share/folder/file.txt')).toBe('folder/file.txt')
  })

  it('keeps Windows drive roots intact when traversing above them', () => {
    expect(resolvePath('C:/workspace', '../../../file.txt')).toBe('C:/file.txt')
    expect(normalizePath('C:/a/..')).toBe('C:/')
  })

  it('retains unresolved relative parent segments instead of silently selecting a different path', () => {
    expect(normalizePath('../../folder/file.txt')).toBe('../../folder/file.txt')
    expect(normalizePath('folder/../../file.txt')).toBe('../file.txt')
  })

  it('makes a file relative to a filesystem root workspace', () => {
    expect(toWorkspaceRelative('/', '/tmp/file.txt')).toBe('tmp/file.txt')
    expect(toWorkspaceRelative('/', '/')).toBe('.')
    expect(toWorkspaceRelative('C:/', 'C:/folder/file.txt')).toBe('folder/file.txt')
  })

  it('accepts absolute paths outside the initial workspace', () => {
    expect(resolvePath('C:/workspace/project', 'D:/shared/file.ts')).toBe('D:/shared/file.ts')
    expect(resolvePath('/workspace/project', '/tmp/shared/file.ts')).toBe('/tmp/shared/file.ts')
  })

  it('allows relative paths to traverse outside the initial workspace', () => {
    expect(resolvePath('C:/workspace/project', '../../shared/file.ts')).toBe('C:/shared/file.ts')
  })

  it('keeps model-style leading slashes relative on Windows', () => {
    expect(resolvePath('C:/workspace/project', '/src/app.ts')).toBe('C:/workspace/project/src/app.ts')
  })
})
