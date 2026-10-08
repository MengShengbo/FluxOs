import type { RetrievalResult } from '@fluxos/contracts/retrievalTypes'
import type { CodeNavigationResult, SearchContentPage, SearchFilesPage } from '@fluxos/contracts/toolExecutor'

export function codeNavigationResult(result: CodeNavigationResult, relativePath: (path: string) => string): RetrievalResult {
  const { locations, ...metadata } = result
  return { operation: 'code_navigation', scope: relativePath(result.path),
    resources: locations.map(location => ({ path: relativePath(location.path), kind: 'file', state: 'found',
      line: location.line, column: location.column, endLine: location.endLine, endColumn: location.endColumn,
      sourceVersion: location.sourceVersion, preview: location.preview,
      symbolName: location.name, isWriteAccess: location.isWriteAccess,
      lines: [{ line: location.line, text: location.preview }],
      ...(location.message && location.code !== undefined ? { annotation: `${location.category} TS${location.code}: ${location.message}`,
        diagnostic: { code: location.code, category: location.category ?? 'message', message: location.message } } : {}) })),
    total: result.total, totalIsExact: result.totalIsExact, truncated: result.truncated, nextOffset: result.nextOffset, warning: result.warning,
    navigation: { ...metadata, workspaceRoot: '.', path: relativePath(result.path), projectPath: result.projectPath ? relativePath(result.projectPath) : undefined,
      ...(result.fallback ? { fallback: { ...result.fallback, path: relativePath(result.fallback.path) } } : {}) } }
}

export function formatCodeNavigation(result: RetrievalResult): string {
  const info = result.navigation!
  const lines = [`${info.operation}: ${info.path}; status: ${info.status}; language: ${info.language}`, info.warning]
  if (info.projectPath) lines.push(`Project: ${info.projectPath}`)
  if (info.sourceVersion) lines.push(`source_version: ${info.sourceVersion}; project_version: ${info.projectVersion}`)
  lines.push(`Returned ${result.resources.length} of ${result.totalIsExact ? '' : 'at least '}${result.total} locations; positions use one-based UTF-16 columns and exclusive ends.`)
  for (const resource of result.resources) lines.push(`${resource.path}:${resource.line}:${resource.column}-${resource.endLine}:${resource.endColumn} (source_version=${resource.sourceVersion})\n${resource.annotation ? `${resource.annotation}\n` : ''}${resource.preview ?? ''}`)
  if (info.nextOffset !== undefined) lines.push(`Continue with the same query, offset=${info.nextOffset}, project_version=${info.projectVersion}; changed projects require a fresh query.`)
  return lines.join('\n')
}

export function fileSearchResult(page: Partial<SearchFilesPage> & { matches: string[] }, scope: string, query: string, relativePath: (path: string) => string): RetrievalResult {
  return {
    operation: 'search_files', scope, query,
    resources: page.matches.map(path => ({ path: relativePath(path), kind: 'file', state: 'found' })),
    total: page.totalMatches,
    totalIsExact: page.totalIsExact === true,
    truncated: page.truncated === true,
    nextOffset: page.nextOffset,
    nextCursor: page.nextCursor,
    snapshot: page.snapshot,
    incompleteReasons: page.incompleteReasons,
    warning: page.warning,
  }
}

export function contentSearchResult(page: SearchContentPage, scope: string, query: string, relativePath: (path: string) => string): RetrievalResult {
  return {
    operation: 'search_content', scope, query, outputMode: page.outputMode || 'content',
    resources: page.outputMode === 'files' || page.outputMode === 'count'
      ? (page.files || []).map(item => ({ path: relativePath(item.file), kind: 'file', state: 'matched', matchCount: item.count }))
      : page.hits.map(hit => ({
          path: relativePath(hit.file), kind: 'file', state: 'matched', line: hit.line, endLine: hit.endLine ?? hit.line,
          preview: [hit.text, hit.context].filter(Boolean).join('\n'), textTruncated: hit.textTruncated,
          lines: [
            ...hit.text.split('\n').map((text, offset) => ({ line: hit.line + offset, text, matched: true })),
            ...(hit.contextLines || []),
          ].sort((left, right) => left.line - right.line),
        })),
    total: page.totalMatches,
    totalIsExact: page.totalIsExact !== false,
    truncated: page.truncated,
    nextOffset: page.nextOffset,
    nextCursor: page.nextCursor,
    snapshot: page.snapshot,
    incompleteReasons: page.incompleteReasons,
    warning: page.warning,
  }
}

export function formatRetrievalResult(result: RetrievalResult): string {
  const count = result.resources.length
  const unit = result.outputMode === 'content' ? 'matching lines/blocks' : 'files'
  const total = result.total === undefined ? '' : ` of ${result.totalIsExact ? '' : 'at least '}${result.total}`
  const lines = [
    `Scope: ${result.scope || '.'}; query: ${JSON.stringify(result.query || '')}; mode: ${result.outputMode || 'files'}`,
    `${count === 0 ? 'No results in this page.' : `Returned ${count}${total} ${unit}.`}`,
  ]
  for (const resource of result.resources) {
    const location = resource.line ? `${resource.path}:${resource.line}` : resource.path
    lines.push(`${location}${resource.matchCount === undefined ? '' : `: ${resource.matchCount} matching lines/blocks`}${resource.preview ? `\n${resource.preview}` : ''}`)
    if (resource.textTruncated) lines.push('[Text preview shortened; read this file range for full text.]')
  }
  if (result.snapshot) lines.push(`Capture started: ${result.snapshot.capturedAt}; expires: ${result.snapshot.expiresAt}; consistency: ${result.snapshot.consistency}.`)
  if (result.warning) lines.push(result.warning)
  if (result.nextCursor) lines.push(`More captured results available. Keep query, scope, mode and filters unchanged; omit offset and continue with cursor=${JSON.stringify(result.nextCursor)}.`)
  else if (result.truncated) lines.push('Results are incomplete. Narrow the scope or query; absence is not established.')
  return lines.join('\n')
}
