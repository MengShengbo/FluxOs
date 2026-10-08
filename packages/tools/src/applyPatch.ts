export type ApplyPatchOperation =
  | {
      kind: 'add'
      path: string
      content: string
    }
  | {
      kind: 'delete'
      path: string
    }
  | {
      kind: 'update'
      path: string
      moveTo?: string
      hunks: ApplyPatchHunk[]
    }

export interface ApplyPatchHunk {
  header: string
  lines: string[]
  endOfFile?: boolean
}

export const MAX_APPLY_PATCH_CHARS = 1_000_000
export const MAX_APPLY_PATCH_OPERATIONS = 200
export const MAX_APPLY_PATCH_HUNKS = 1_000
export const MAX_APPLY_PATCH_LINE_CHARS = 256_000

export function parseApplyPatch(source: string): ApplyPatchOperation[] {
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new Error('Patch must be a non-empty string')
  }
  if (source.length > MAX_APPLY_PATCH_CHARS) {
    throw new Error(`Patch exceeds the ${MAX_APPLY_PATCH_CHARS.toLocaleString()} character limit`)
  }

  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0] !== '*** Begin Patch') {
    throw new Error("Patch must start with '*** Begin Patch'")
  }
  if (lines[lines.length - 1] === '') lines.pop()
  if (lines[lines.length - 1] !== '*** End Patch') {
    throw new Error("Patch must end with '*** End Patch'")
  }

  const operations: ApplyPatchOperation[] = []
  const seenPaths = new Set<string>()
  let index = 1
  while (index < lines.length - 1) {
    if (operations.length >= MAX_APPLY_PATCH_OPERATIONS) {
      throw new Error(`Patch exceeds the ${MAX_APPLY_PATCH_OPERATIONS} file operation limit`)
    }
    const header = lines[index]
    const match = header.match(/^\*\*\* (Add|Delete|Update) File: (.+)$/)
    if (!match) throw new Error(`Invalid patch header on line ${index + 1}: ${header || '(empty)'}`)

    const kind = match[1].toLowerCase() as 'add' | 'delete' | 'update'
    const path = match[2]
    if (!path.trim()) throw new Error(`Patch path is empty on line ${index + 1}`)
    // Only literal duplicates are parser errors. Native path identity belongs
    // to the executor that owns the target filesystem.
    const pathKey = path
    if (seenPaths.has(pathKey)) throw new Error(`Patch contains duplicate file path: ${path}`)
    seenPaths.add(pathKey)
    index += 1

    if (kind === 'add') {
      const contentLines: string[] = []
      while (index < lines.length - 1 && !isFileHeader(lines[index])) {
        const line = lines[index]
        if (line.length > MAX_APPLY_PATCH_LINE_CHARS) {
          throw new Error(`Patch line ${index + 1} exceeds the ${MAX_APPLY_PATCH_LINE_CHARS.toLocaleString()} character limit`)
        }
        if (!line.startsWith('+')) {
          throw new Error(`Add file content must use '+' prefixes on line ${index + 1}`)
        }
        contentLines.push(line.slice(1))
        index += 1
      }
      operations.push({ kind, path, content: contentLines.map(line => `${line}\n`).join('') })
      continue
    }

    if (kind === 'delete') {
      if (index < lines.length - 1 && !isFileHeader(lines[index])) {
        throw new Error(`Delete file entry cannot contain content on line ${index + 1}`)
      }
      operations.push({ kind, path })
      continue
    }

    let moveTo: string | undefined
    if (index < lines.length - 1 && lines[index].startsWith('*** Move to: ')) {
      moveTo = lines[index].slice('*** Move to: '.length)
      if (!moveTo.trim()) throw new Error(`Move destination is empty on line ${index + 1}`)
      index += 1
    }

    const hunks: ApplyPatchHunk[] = []
    while (index < lines.length - 1 && !isFileHeader(lines[index])) {
      const hunkHeader = lines[index]
      const location = parseHunkLocation(hunkHeader)
      index += 1
      const hunkLines: string[] = []
      let endOfFile = false
      while (index < lines.length - 1 && !isFileHeader(lines[index]) && !lines[index].startsWith('@@')) {
        const line = lines[index]
        if (line === '*** End of File') {
          endOfFile = true
          index += 1
          if (index < lines.length - 1 && !isFileHeader(lines[index])) {
            throw new Error(`End of File must be the final marker for '${path}'`)
          }
          break
        }
        if (line.length > MAX_APPLY_PATCH_LINE_CHARS) {
          throw new Error(`Patch line ${index + 1} exceeds the ${MAX_APPLY_PATCH_LINE_CHARS.toLocaleString()} character limit`)
        }
        if (!line.startsWith(' ') && !line.startsWith('+') && !line.startsWith('-')) {
          throw new Error(`Invalid patch line on line ${index + 1}: ${line || '(empty)'}`)
        }
        hunkLines.push(line)
        index += 1
      }
      const anchorOnly = location.kind === 'anchor' && hunkLines.length === 0 && !endOfFile
      if (!anchorOnly && !hunkLines.some(line => line.startsWith('+') || line.startsWith('-'))) {
        throw new Error(`Update hunk on line ${index} must contain an addition or deletion`)
      }
      if (hunks.length >= MAX_APPLY_PATCH_HUNKS) {
        throw new Error(`Patch exceeds the ${MAX_APPLY_PATCH_HUNKS.toLocaleString()} hunk limit`)
      }
      hunks.push({ header: hunkHeader, lines: hunkLines, ...(endOfFile ? { endOfFile: true } : {}) })
    }
    if (hunks.length === 0) throw new Error(`Update file '${path}' has no hunks`)
    if (!hunks.some(hunk => hunk.lines.some(line => line.startsWith('+') || line.startsWith('-')))) {
      throw new Error(`Update file '${path}' must contain an addition or deletion`)
    }
    operations.push({ kind, path, ...(moveTo ? { moveTo } : {}), hunks })
  }

  if (operations.length === 0) throw new Error('Patch contains no file operations')
  return operations
}

export function applyPatchHunks(original: string, hunks: ApplyPatchHunk[], path: string): string {
  const sourceLines = splitSourceLines(original)
  const lines = sourceLines.map(line => line.text)
  const result: SourceLine[] = []
  const preferredEnding = sourceLines.find(line => line.ending)?.ending || '\n'
  let cursor = 0
  let copiedUntil = 0

  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter(line => line.startsWith(' ') || line.startsWith('-')).map(line => line.slice(1))
    const newLines = hunk.lines.filter(line => line.startsWith(' ') || line.startsWith('+')).map(line => line.slice(1))
    const location = parseHunkLocation(hunk.header)
    if (location.kind === 'anchor') {
      cursor = findUniqueSequence(lines, [location.text], path, `anchor '${location.text}'`, cursor) + 1
      if (hunk.lines.length === 0) continue
    }

    let start: number
    if (location.kind === 'line') {
      start = location.start
      if (location.oldCount !== oldLines.length || location.newCount !== newLines.length) {
        throw new Error(`Patch hunk line count does not match ${hunk.header} in ${path}`)
      }
      if (start < cursor || start > lines.length || !matchesAt(lines, oldLines, start)) {
        throw new Error(`Patch location does not match ${hunk.header} in ${path}`)
      }
    } else if (hunk.endOfFile) {
      start = lines.length - oldLines.length
      if (start < cursor || !matchesAt(lines, oldLines, start)) {
        throw new Error(`Failed to find expected lines at end of file in ${path}`)
      }
    } else if (oldLines.length === 0) {
      // Codex's unlocated pure additions append. Explicit numeric locations
      // remain available for insertion before a specific original source line.
      start = lines.length
    } else if (location.kind === 'anchor' && matchesAt(lines, oldLines, cursor)) {
      // The unique anchor and adjacent context form one exact location, even
      // when the same body appears in a later declaration.
      start = cursor
    } else {
      start = findUniqueSequence(lines, oldLines, path, hunk.header, cursor)
    }
    if (hunk.endOfFile && start + oldLines.length !== lines.length) {
      throw new Error(`Patch location is not at end of file in ${path}`)
    }
    for (let index = copiedUntil; index < start; index += 1) result.push(sourceLines[index])
    let sourceIndex = start
    let removed = 0
    let added: string[] = []
    const flushChange = () => {
      if (removed === 0 && added.length === 0) return
      const localEnding = sourceLines[sourceIndex + removed - 1]?.ending
        || sourceLines[sourceIndex - 1]?.ending || sourceLines[sourceIndex]?.ending || preferredEnding
      const generated = added.map((text, offset) => ({
        text,
        ending: offset < removed ? sourceLines[sourceIndex + offset].ending || localEnding : localEnding,
      }))
      if (generated.length > 0 && sourceIndex + removed === sourceLines.length && sourceLines.length > 0) {
        generated[generated.length - 1].ending = sourceLines[sourceLines.length - 1].ending
      }
      for (const line of generated) result.push(line)
      sourceIndex += removed
      removed = 0
      added = []
    }
    for (const line of hunk.lines) {
      if (line.startsWith(' ')) {
        flushChange()
        result.push(sourceLines[sourceIndex++])
      } else if (line.startsWith('-')) removed += 1
      else if (line.startsWith('+')) added.push(line.slice(1))
    }
    flushChange()
    copiedUntil = start + oldLines.length
    cursor = copiedUntil
  }

  for (let index = copiedUntil; index < lines.length; index += 1) result.push(sourceLines[index])
  // An unterminated original last line needs a separator only if an append
  // moved it into the interior. The resulting last line keeps its convention.
  return result.map((line, index) => line.text + (line.ending || (index < result.length - 1 ? preferredEnding : ''))).join('')
}

function isFileHeader(line: string): boolean {
  return /^\*\*\* (?:Add|Delete|Update) File: /.test(line) || line === '*** End Patch'
}

interface SourceLine { text: string; ending: string }

function splitSourceLines(content: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  for (const match of content.matchAll(/\r\n|\r|\n/g)) {
    lines.push({ text: content.slice(start, match.index), ending: match[0] })
    start = match.index + match[0].length
  }
  if (start < content.length) lines.push({ text: content.slice(start), ending: '' })
  return lines
}

function findUniqueSequence(lines: string[], expected: string[], path: string, header: string, from: number): number {
  // KMP avoids rescanning a long repeated prefix at every source line.
  const prefix = new Array<number>(expected.length).fill(0)
  for (let index = 1, matched = 0; index < expected.length; index += 1) {
    while (matched > 0 && expected[index] !== expected[matched]) matched = prefix[matched - 1]
    if (expected[index] === expected[matched]) matched += 1
    prefix[index] = matched
  }
  let count = 0
  let start = -1
  for (let index = from, matched = 0; index < lines.length; index += 1) {
    while (matched > 0 && lines[index] !== expected[matched]) matched = prefix[matched - 1]
    if (lines[index] === expected[matched]) matched += 1
    if (matched === expected.length) {
      count += 1
      start = index - expected.length + 1
      matched = prefix[matched - 1]
    }
  }
  if (count === 0) {
    throw new Error(`Failed to find expected lines for ${header} in ${path}:\n${expected.join('\n')}`)
  }
  if (count > 1) {
    throw new Error(`Patch context is ambiguous in ${path}: found ${count} matching locations for ${header}`)
  }
  return start
}

function matchesAt(lines: string[], expected: string[], start: number): boolean {
  return start >= 0 && start + expected.length <= lines.length
    && expected.every((line, offset) => lines[start + offset] === line)
}

type HunkLocation = { kind: 'plain' } | { kind: 'anchor'; text: string }
  | { kind: 'line'; start: number; oldCount: number; newCount: number }

function parseHunkLocation(header: string): HunkLocation {
  if (header === '@@') return { kind: 'plain' }
  const range = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/)
  if (range) {
    const numbers = range.slice(1).map(value => value === undefined ? 1 : Number(value))
    if (numbers.some(value => !Number.isSafeInteger(value))) throw new Error(`Invalid patch location: ${header}`)
    return { kind: 'line', start: Math.max(0, numbers[0] - 1), oldCount: numbers[1], newCount: numbers[3] }
  }
  if (header.startsWith('@@ ') && header.slice(3).trim()) return { kind: 'anchor', text: header.slice(3) }
  throw new Error(`Invalid patch hunk header: ${header}. Use '@@' or '@@ <exact source line>'.`)
}
