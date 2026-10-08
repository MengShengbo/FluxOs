import { statSync } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import { Minimatch } from 'minimatch'
import type { Result, SearchContentHit, SearchContentOptions, SearchContentPage, SearchFilesOptions, SearchFilesPage, SearchIncompleteReason } from '@fluxos/contracts/toolExecutor'

import { SearchError, SearchSnapshotStore, searchFailure, type SearchCacheLimits } from './searchSnapshotStore'
import { createSearchCapture, type SearchCaptureBackend } from './workspaceSearchCapture'
const INTERNAL_DIRECTORIES = ['.git', '.hg', '.svn', '.fluxagent']
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template', '.env.defaults'])

function searchable(path: string): boolean {
  const name = basename(path).toLowerCase()
  return !name.startsWith('.env') || ENV_TEMPLATES.has(name)
}

function searchArguments(includeIgnored: boolean): string[] {
  return [
    '--no-config', '--hidden', '--no-require-git', '--sort=path',
    ...(includeIgnored ? ['--no-ignore'] : []),
    ...INTERNAL_DIRECTORIES.map(directory => `--glob=!**/${directory}/**`),
  ]
}

function globMatcher(pattern: string): Minimatch {
  return new Minimatch(pattern.replace(/\\/g, '/'), { dot: true, matchBase: true, nonegate: true, nocomment: true })
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value!))) : fallback
}

function terminatedRecords(output: string, delimiter: string, reasons: SearchIncompleteReason[]): string[] {
  const records = output.split(delimiter)
  if (records.pop()) reasons.push('decode_error')
  return records
}

interface SearchEvent {
  type: 'match' | 'context'
  file: string
  line: number
  endLine: number
  text: string
}

function rgText(value: { text?: string; bytes?: string } | undefined): string {
  return value?.text ?? (value?.bytes ? Buffer.from(value.bytes, 'base64').toString('utf8') : '')
}

export class WorkspaceSearch {
  private readonly snapshots: SearchSnapshotStore
  constructor(private readonly capture: SearchCaptureBackend = createSearchCapture(), limits: SearchCacheLimits = {}) {
    this.snapshots = new SearchSnapshotStore(limits)
  }

  async files(pattern: string, scope: string, options: SearchFilesOptions = {}): Promise<Result<SearchFilesPage>> {
    try {
      this.snapshots.validateRequest(options)
      if (!pattern.trim()) throw new SearchError('File search pattern is required', 'validation')
      const key = JSON.stringify(['files', pattern, scope, options.includeIgnored === true])
      if (options.cursor !== undefined) {
        const { selected, ...pagination } = this.snapshots.continue<string>(key, options)
        return { success: true, data: { matches: selected, ...pagination } }
      }
      const capturedAt = Date.now()
      if (!statSync(scope).isDirectory()) throw new SearchError('File search path must be a directory', 'validation')
      const matcher = globMatcher(pattern)
      // Filtering the inventory preserves ignore rules. Positive rg --glob flags override them.
      const captured = await this.capture([...searchArguments(options.includeIgnored === true), '--files', '--null', '--', '.'], scope, options.signal)
      const records = terminatedRecords(captured.output, '\0', captured.reasons)
      const files = records.filter(path => searchable(path) && matcher.match(path.replace(/\\/g, '/').replace(/^\.\//, ''))).map(path => resolve(scope, path))
      const { selected, ...pagination } = this.snapshots.start(key, files, path => path, captured.reasons, capturedAt, options, path => path.length + 1)
      return { success: true, data: { matches: selected, ...pagination } }
    } catch (error) {
      return searchFailure(error)
    }
  }

  async content(
    pattern: string, scope: string, filePattern?: string, caseInsensitive = true, options: SearchContentOptions = {},
  ): Promise<Result<SearchContentPage>> {
    try {
      this.snapshots.validateRequest(options)
      if (!pattern) throw new SearchError('Content search pattern is required', 'validation')
      const outputMode = options.outputMode ?? 'content'
      if (!['content', 'files', 'count'].includes(outputMode)) throw new SearchError('Invalid output mode', 'validation')
      const before = boundedInteger(options.contextBefore, 0, 0, 20)
      const after = boundedInteger(options.contextAfter, 0, 0, 20)
      const maxColumns = boundedInteger(options.maxColumns, 500, 120, 2_000)
      const key = JSON.stringify(['content', pattern, scope, filePattern ?? null, caseInsensitive, outputMode,
        before, after, maxColumns, options.includeIgnored === true, options.fixedStrings === true, options.multiline === true, options.fileType ?? null])
      if (options.cursor !== undefined) {
        const { selected, ...pagination } = this.snapshots.continue<SearchContentHit | { file: string; count?: number }>(key, options)
        return { success: true, data: { hits: outputMode === 'content' ? selected as SearchContentHit[] : [],
          ...(outputMode !== 'content' ? { files: selected } : {}), outputMode, ...pagination } }
      }
      const capturedAt = Date.now()
      const fileScope = statSync(scope).isFile()
      if (fileScope && !searchable(scope)) throw new SearchError('Environment secrets are excluded from search', 'validation')
      const cwd = fileScope ? dirname(scope) : scope
      const target = fileScope ? basename(scope) : '.'
      const matcher = filePattern ? globMatcher(filePattern) : undefined
      const args = searchArguments(options.includeIgnored === true)
      args.push(outputMode === 'files' ? '--files-with-matches' : '--json')
      if (outputMode === 'files') args.push('--null')
      if (caseInsensitive) args.push('--ignore-case')
      if (options.fixedStrings) args.push('--fixed-strings')
      if (options.multiline) args.push('--multiline', '--multiline-dotall')
      if (options.fileType) args.push('--type', options.fileType)
      else if (filePattern && !filePattern.includes('/')) args.push('--type-add', `fluxagent:${filePattern}`, '--type', 'fluxagent')
      if (outputMode === 'content') args.push('-B', String(before), '-A', String(after))
      args.push('--', pattern, target)
      const captured = await this.capture(args, cwd, options.signal)
      const accepts = (path: string) => searchable(path) && (!matcher || matcher.match(relative(cwd, path).replace(/\\/g, '/')))
      if (outputMode === 'files') {
        const records = terminatedRecords(captured.output, '\0', captured.reasons)
        const files = records.map(path => ({ file: resolve(cwd, path) })).filter(item => accepts(item.file))
        const { selected, ...pagination } = this.snapshots.start(key, files, item => item, captured.reasons, capturedAt, options, item => item.file.length + 1)
        return { success: true, data: { hits: [], files: selected, outputMode, ...pagination } }
      }

      const events: SearchEvent[] = []
      const reasons = [...captured.reasons]
      const records = terminatedRecords(captured.output, '\n', reasons)
      for (const record of records) {
        if (!record) continue
        try {
          const event = JSON.parse(record)
          if (event.type !== 'match' && event.type !== 'context') continue
          const file = resolve(cwd, rgText(event.data.path))
          if (!accepts(file)) continue
          const line = Number(event.data.line_number)
          if (!Number.isFinite(line)) throw new Error('Missing match line')
          const text = rgText(event.data.lines).replace(/\r?\n$/, '')
          events.push({ type: event.type, file, line, endLine: line + text.split('\n').length - 1, text })
        } catch {
          reasons.push('decode_error')
        }
      }
      const matches = events.filter(event => event.type === 'match')
      if (outputMode === 'count') {
        const counts = new Map<string, number>()
        for (const match of matches) counts.set(match.file, (counts.get(match.file) || 0) + 1)
        const files = [...counts].map(([file, count]) => ({ file, count }))
        const { selected, ...pagination } = this.snapshots.start(key, files, item => item, reasons, capturedAt, options, item => item.file.length + 20)
        return { success: true, data: { hits: [], files: selected, outputMode, ...pagination } }
      }
      const byFile = new Map<string, SearchEvent[]>()
      if (before || after) {
        for (const event of events) {
          const fileEvents = byFile.get(event.file) || []
          fileEvents.push(event)
          byFile.set(event.file, fileEvents)
        }
      }
      const toHit = (match: SearchEvent) => {
        const fileEvents = byFile.get(match.file) || []
        // Ripgrep emits each file in line order. Bind context to this capture once.
        let low = 0
        let high = fileEvents.length
        while (low < high) {
          const middle = Math.floor((low + high) / 2)
          if (fileEvents[middle].endLine < match.line - before) low = middle + 1
          else high = middle
        }
        const contextLines: Array<{ line: number; text: string; matched: boolean }> = []
        let contextChars = 0
        let textTruncated = match.text.length > maxColumns
        for (let index = low; index < fileEvents.length && fileEvents[index].line <= match.endLine + after; index++) {
          const event = fileEvents[index]
          if (event === match) continue
          for (const [offset, text] of event.text.split('\n').entries()) {
            const line = event.line + offset
            if (line < match.line - before || line > match.endLine + after) continue
            const boundedText = text.slice(0, maxColumns)
            contextChars += boundedText.length + 20
            if (contextChars <= 8_000) contextLines.push({ line, text: boundedText, matched: event.type === 'match' })
            else textTruncated = true
            textTruncated ||= text.length > maxColumns
          }
        }
        const context = contextLines.map(item => `${item.line}: ${item.text}`).join('\n')
        return {
          file: match.file, line: match.line, endLine: match.endLine, text: match.text.slice(0, maxColumns),
          ...(context ? { context, contextLines } : {}),
          ...(textTruncated ? { textTruncated: true } : {}),
        }
      }
      const { selected, ...pagination } = this.snapshots.start(key, matches, toHit, reasons, capturedAt, options,
        hit => hit.file.length + hit.text.length + (hit.context?.length || 0) + 160)
      return { success: true, data: { hits: selected, outputMode, ...pagination } }
    } catch (error) {
      return searchFailure(error)
    }
  }
}
