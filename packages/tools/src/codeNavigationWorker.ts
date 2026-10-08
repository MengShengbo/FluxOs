import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync, type Stats } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { Minimatch } from 'minimatch'
import ts from 'typescript'
import type { CodeLocation, CodeNavigationRequest, CodeNavigationResult, Result } from '@fluxos/contracts/toolExecutor'

class NavigationError extends Error {
  constructor(message: string, readonly kind: 'validation' | 'environment' | 'permission') { super(message) }
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const contained = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }
const signature = (stat: Stats) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
const extensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const internalDirectories = new Set(['.git', '.hg', '.svn', '.fluxagent'])
const require = createRequire(import.meta.url)

interface Source { text: string; version: string; signature: string }

/** All compiler filesystem callbacks pass through this finite, canonical workspace. */
class ProjectSources {
  readonly sources = new Map<string, Source>()
  readonly issues = new Set<string>()
  readonly libRoot = realpathSync.native(dirname(require.resolve('typescript')))
  private bytes = 0
  private directoryEntries = 0
  constructor(readonly root: string) {}

  path(input: string, libraryDirectory = false): string | undefined {
    const full = resolve(input)
    const library = contained(this.libRoot, full) && (libraryDirectory || /^lib(?:\..+)?\.d\.ts$/.test(basename(full)))
    if (!contained(this.root, full) && !library) return undefined
    if (contained(this.root, full) && relative(this.root, full).split(sep).some(part => internalDirectories.has(part) || part.toLowerCase().startsWith('.env'))) return undefined
    try {
      const canonical = realpathSync.native(full)
      if (contained(this.root, canonical) || (library && contained(this.libRoot, canonical))) return canonical
      this.issues.add('dependency_outside_workspace')
    } catch { /* A missing module candidate is an ordinary resolution miss. */ }
    return undefined
  }

  fileExists = (path: string): boolean => { const canonical = this.path(path); return !!canonical && statSync(canonical).isFile() }
  directoryExists = (path: string): boolean => { const canonical = this.path(path, true); return !!canonical && statSync(canonical).isDirectory() }

  readFile = (path: string): string | undefined => {
    const canonical = this.path(path)
    if (!canonical) return undefined
    const existing = this.sources.get(canonical)
    if (existing) return existing.text
    let fd: number | undefined
    try {
      fd = openSync(canonical, 'r')
      const before = fstatSync(fd)
      if (!before.isFile()) return undefined
      if (before.size > 2 * 1024 * 1024 || this.bytes + before.size > 16 * 1024 * 1024 || this.sources.size >= 2000) {
        throw new NavigationError('Project source budget exceeded (2000 files, 2 MiB/file, 16 MiB total); narrow the project', 'environment')
      }
      const bytes = readFileSync(fd)
      if (bytes.length !== before.size || signature(before) !== signature(fstatSync(fd)) || this.path(path) !== canonical || signature(before) !== signature(statSync(canonical))) {
        throw new NavigationError('Source changed while it was read; retry the query', 'environment')
      }
      // Preserve BOM and reject undecodable data rather than inventing character positions.
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      this.bytes += bytes.length
      this.sources.set(canonical, { text, version: hash(bytes), signature: signature(before) })
      return text
    } finally { if (fd !== undefined) closeSync(fd) }
  }

  directories = (input: string): string[] => {
    const path = this.path(input, true)
    if (!path) return []
    return readdirSync(path, { withFileTypes: true }).filter(item => item.isDirectory() && !internalDirectories.has(item.name)).map(item => item.name)
  }

  readDirectory = (input: string, supported?: readonly string[], excludes?: readonly string[], includes?: readonly string[], depth?: number): string[] => {
    const start = this.path(input, true)
    if (!start || !contained(this.root, start)) return []
    const glob = (pattern: string) => {
      const normalized = relative(start, resolve(start, pattern)).replace(/\\/g, '/')
      const matcher = new Minimatch(normalized, { dot: true, nocase: !ts.sys.useCaseSensitiveFileNames })
      return (path: string) => matcher.match(path) || matcher.match(`${path}/`) || (!matcher.hasMagic() && path.startsWith(`${normalized}/`))
    }
    const includePatterns = includes?.length ? includes : ['**/*']
    const include = includePatterns.map(glob)
    const exclude = (excludes ?? []).map(glob)
    const files: string[] = []
    const visit = (directory: string, level: number) => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (++this.directoryEntries > 50_000) throw new NavigationError('Project inventory exceeds 50000 entries; narrow the project', 'environment')
        const full = join(directory, entry.name); const rel = relative(start, full).replace(/\\/g, '/')
        if (internalDirectories.has(entry.name) || entry.name.toLowerCase().startsWith('.env') || exclude.some(match => match(rel))) continue
        // Dependencies are resolved on demand, not treated as project root scripts.
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && (depth === undefined || level < depth)) visit(full, level + 1)
        } else if (entry.isFile() && (!supported || supported.some(extension => full.endsWith(extension))) && include.some(match => match(rel))) {
          files.push(full)
          if (files.length > 2000) throw new NavigationError('Project inventory exceeds 2000 scripts; narrow the project', 'environment')
        } else if (entry.isSymbolicLink()) this.issues.add('symlink_roots_excluded')
      }
    }
    // TS configs can explicitly include siblings (for example ../shared/**/*.ts).
    // Visit their literal base as well; never expand a root outside the workspace.
    const bases = new Set([start])
    for (const pattern of includePatterns) {
      const parts = pattern.replace(/\\/g, '/').split('/')
      const magic = parts.findIndex(part => /[*?\[\]{}]/.test(part))
      let base = resolve(start, ...(magic < 0 ? parts : parts.slice(0, magic)))
      if (!contained(this.root, base)) throw new NavigationError('Project include escapes the workspace', 'permission')
      const canonical = this.path(base, true)
      if (!canonical) continue
      base = statSync(canonical).isDirectory() ? canonical : dirname(canonical)
      bases.add(base)
    }
    for (const base of [...bases].filter(path => ![...bases].some(other => other !== path && contained(other, path)))) visit(base, 0)
    return files
  }

  verify(): void {
    for (const [path, source] of this.sources) {
      if (this.path(path) !== path || !existsSync(path) || signature(statSync(path)) !== source.signature) throw new NavigationError('Project changed during analysis; rerun to refresh locations', 'environment')
    }
  }
}

function language(path: string): CodeNavigationResult['language'] {
  const extension = extname(path).toLowerCase()
  return !extensions.has(extension) ? 'unsupported' : /\.[cm]?jsx?$/.test(extension) ? 'javascript' : 'typescript'
}

function navigation(workspace: string, request: CodeNavigationRequest): CodeNavigationResult {
  const root = realpathSync.native(workspace); const sources = new ProjectSources(root)
  const requestedRoot = resolve(workspace)
  const withinRequestedRoot = (path: string) => {
    const absolute = resolve(requestedRoot, path)
    return contained(requestedRoot, absolute) ? resolve(root, relative(requestedRoot, absolute)) : absolute
  }
  request = { ...request, path: withinRequestedRoot(request.path), ...(request.projectPath ? { projectPath: withinRequestedRoot(request.projectPath) } : {}) }
  const target = sources.path(request.path)
  if (!target || !contained(root, target)) throw new NavigationError('Source file is outside the canonical workspace or unavailable', 'permission')
  const capturedAt = new Date().toISOString(); const targetLanguage = language(target)
  if (targetLanguage === 'unsupported') return { operation: request.operation, status: 'unsupported', language: 'unsupported', path: target, workspaceRoot: root,
    locations: [], inferredProject: false, capturedAt, filesAnalyzed: 0, total: 0, totalIsExact: false, truncated: false,
    issues: ['unsupported_language'], warning: 'Semantic navigation supports TS/JS only. Use search_content with a literal query for text evidence; text matches are not definitions or references.',
    fallback: { tool: 'search_content', path: target, semantic: false } }
  const sourceText = sources.readFile(target)
  if (sourceText === undefined) throw new NavigationError('Source file is unavailable', 'environment')
  const sourceVersion = sources.sources.get(target)!.version
  if (request.sourceVersion && request.sourceVersion !== sourceVersion) throw new NavigationError('source_version changed; rerun without the old version to refresh the position', 'validation')

  let projectPath: string | undefined
  if (request.projectPath) {
    projectPath = sources.path(request.projectPath)
    if (!projectPath || !contained(root, projectPath) || !projectPath.endsWith('.json')) throw new NavigationError('project_path must be a JSON config inside the workspace', 'permission')
  } else {
    let directory = dirname(target)
    while (contained(root, directory)) {
      projectPath = ['tsconfig.json', 'jsconfig.json'].map(name => sources.path(join(directory, name))).find(Boolean)
      if (projectPath || directory === root) break
      directory = dirname(directory)
    }
  }
  let options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true, checkJs: true, strict: true, jsx: ts.JsxEmit.Preserve, noEmit: true }
  let files: string[]
  if (projectPath) {
    const config = ts.readConfigFile(projectPath, sources.readFile)
    if (config.error) throw new NavigationError(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'), 'validation')
    const parsed = ts.parseJsonConfigFileContent(config.config, { useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      readDirectory: sources.readDirectory, fileExists: sources.fileExists, readFile: sources.readFile }, dirname(projectPath), undefined, projectPath)
    if (parsed.errors.length) throw new NavigationError(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'), 'validation')
    options = { ...parsed.options, noEmit: true }
    // No tsserver/plugin loader is used; project settings remain data only.
    if (parsed.projectReferences?.length) sources.issues.add('project_references_not_built')
    files = parsed.fileNames
  } else {
    files = sources.readDirectory(root, [...extensions], ['node_modules', 'dist', 'build', 'coverage'], ['**/*'])
  }
  files = [...new Set(files.map(file => {
    const path = sources.path(file)
    if (!path || !contained(root, path)) sources.issues.add('project_root_unavailable_or_outside_workspace')
    return path
  }).filter((file): file is string => !!file && contained(root, file)))].sort()
  if (!files.includes(target)) throw new NavigationError('Source is not included by this project configuration; choose a project_path that includes it', 'validation')
  for (const file of files) sources.readFile(file)
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options, getScriptFileNames: () => files,
    getScriptVersion: file => { const canonical = sources.path(file); return canonical ? sources.sources.get(canonical)?.version ?? '0' : '0' },
    getScriptSnapshot: file => { const text = sources.readFile(file); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text) },
    getCurrentDirectory: () => projectPath ? dirname(projectPath) : root,
    getDefaultLibFileName: settings => ts.getDefaultLibFilePath(settings),
    fileExists: sources.fileExists, readFile: sources.readFile, readDirectory: sources.readDirectory,
    directoryExists: sources.directoryExists, getDirectories: sources.directories,
    realpath: path => sources.path(path, true) ?? path,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  }
  const service = ts.createLanguageService(host)
  try {
    const program = service.getProgram()!
    const source = program.getSourceFile(target)
    if (!source) throw new NavigationError('Compiler did not include the source file', 'environment')
    const makeLocation = (fileName: string, span: ts.TextSpan): CodeLocation | undefined => {
      const path = sources.path(fileName)
      if (!path || !contained(root, path)) { sources.issues.add('external_locations_omitted'); return undefined }
      const file = program.getSourceFile(fileName)
      if (!file) { sources.issues.add('unavailable_location'); return undefined }
      const start = file.getLineAndCharacterOfPosition(span.start)
      const end = file.getLineAndCharacterOfPosition(span.start + span.length)
      const lineStart = file.getPositionOfLineAndCharacter(start.line, 0)
      const nextStart = start.line + 1 < file.getLineStarts().length ? file.getPositionOfLineAndCharacter(start.line + 1, 0) : file.text.length
      return { path, line: start.line + 1, column: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1,
        sourceVersion: sources.sources.get(path)!.version, preview: file.text.slice(lineStart, nextStart).replace(/[\r\n]+$/, '').slice(0, 1000) }
    }
    const locations: CodeLocation[] = []
    const semanticDiagnostics = service.getSemanticDiagnostics(target)
    for (const diagnostic of semanticDiagnostics) if ([2307, 2688, 2792, 7016].includes(diagnostic.code)) sources.issues.add(`unresolved_dependency_${diagnostic.code}`)
    if (request.operation === 'diagnostics') {
      for (const diagnostic of [...service.getSyntacticDiagnostics(target), ...semanticDiagnostics]) {
        if (!diagnostic.file || diagnostic.start === undefined) { sources.issues.add('diagnostic_without_location'); continue }
        const location = makeLocation(diagnostic.file.fileName, { start: diagnostic.start, length: diagnostic.length ?? 0 })
        if (location) locations.push({ ...location, code: diagnostic.code,
          category: ts.DiagnosticCategory[diagnostic.category].toLowerCase() as CodeLocation['category'],
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') })
      }
      if (targetLanguage === 'javascript' && !options.checkJs && !/^\s*\/\/\s*@ts-check/m.test(sourceText)) sources.issues.add('javascript_checking_disabled_by_project')
    } else {
      const lineIndex = request.line! - 1; const columnIndex = request.column! - 1
      const starts = source.getLineStarts()
      if (lineIndex >= starts.length) throw new NavigationError('Line is outside the source file', 'validation')
      const lineEnd = lineIndex + 1 < starts.length ? starts[lineIndex + 1] : source.text.length
      const lineText = source.text.slice(starts[lineIndex], lineEnd).replace(/[\r\n]+$/, '')
      if (columnIndex > lineText.length) throw new NavigationError('Column is outside the source line (UTF-16 units)', 'validation')
      const position = starts[lineIndex] + columnIndex
      if (columnIndex && /[\uDC00-\uDFFF]/.test(lineText[columnIndex] ?? '') && /[\uD800-\uDBFF]/.test(lineText[columnIndex - 1])) throw new NavigationError('Column splits a UTF-16 surrogate pair', 'validation')
      const results = request.operation === 'definition' ? service.getDefinitionAtPosition(target, position) : service.getReferencesAtPosition(target, position)
      for (const item of results ?? []) {
        const location = makeLocation(item.fileName, item.textSpan)
        if (location) locations.push({ ...location, ...('name' in item ? { name: item.name } : {}), ...('isWriteAccess' in item ? { isWriteAccess: item.isWriteAccess } : {}) })
      }
    }
    // Configuration/global failures affect the scope, not fabricated source ranges.
    for (const diagnostic of service.getCompilerOptionsDiagnostics()) sources.issues.add(`compiler_option_${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`)
    sources.verify()
    const projectVersion = hash(JSON.stringify({ compiler: ts.version, options,
      inputs: [...sources.sources].map(([path, record]) => [path, record.version]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) }))
    if (request.projectVersion && request.projectVersion !== projectVersion) throw new NavigationError('project_version changed; rerun without the old version to refresh all locations', 'validation')
    const ordered = [...new Map(locations.map(item => [JSON.stringify([item.path, item.line, item.column, item.endLine, item.endColumn, item.code]), item])).values()]
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.column - b.column || (a.code ?? 0) - (b.code ?? 0))
    const offset = request.offset ?? 0; const limit = request.limit ?? 100
    const selected: CodeLocation[] = []; let chars = 0
    for (const location of ordered.slice(offset, offset + limit)) {
      const size = JSON.stringify(location).length
      if (selected.length && chars + size > 24_000) break
      selected.push(location); chars += size
    }
    const next = offset + selected.length; const issues = [...sources.issues]
    return { operation: request.operation, status: 'semantic', language: targetLanguage, path: target, workspaceRoot: root, locations: selected,
      compilerVersion: ts.version, projectPath, inferredProject: !projectPath, sourceVersion, projectVersion, capturedAt,
      filesAnalyzed: program.getSourceFiles().filter(file => contained(root, file.fileName)).length,
      total: ordered.length, totalIsExact: issues.length === 0, truncated: next < ordered.length || issues.length > 0,
      ...(next < ordered.length ? { nextOffset: next } : {}), issues,
      warning: `TypeScript ${ts.version}; ${projectPath ? 'configured project' : 'inferred project (strict TS and checked JS)'}. Captured source positions may change after edits.${issues.length ? ` Scope limitations: ${issues.join('; ')}.` : ''}` }
  } finally { service.dispose() }
}

if (parentPort) {
  let result: Result<CodeNavigationResult>
  try { result = { success: true, data: navigation(workerData.workspace, workerData.request) } }
  catch (error) { result = { success: false, errorKind: error instanceof NavigationError ? error.kind : 'environment', error: error instanceof Error ? error.message : String(error) } }
  parentPort.postMessage(result)
}
