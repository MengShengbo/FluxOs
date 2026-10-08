import { promises as fs } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { PatchPathIdentity } from '@fluxos/contracts/toolExecutor'

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code

/** Paths must already have passed the executor's write-capability boundary. */
export async function resolvePatchPathIdentities(paths: string[], signal?: AbortSignal): Promise<Omit<PatchPathIdentity, 'relativePath'>[]> {
  const results = new Array<Omit<PatchPathIdentity, 'relativePath'>>(paths.length)
  const missingByAncestor = new Map<string, Array<{ index: number; suffix: string }>>()
  for (let index = 0; index < paths.length; index += 1) {
    signal?.throwIfAborted()
    const path = paths[index]
    let missing = false
    try { await fs.lstat(path) } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      missing = true
    }
    if (!missing) {
      // Resolving a dangling symlink fails here, rather than treating it as a
      // new file. Existing links and case aliases share the physical identity.
      const canonical = await fs.realpath(path)
      const stat = await fs.stat(canonical, { bigint: true })
      if (!stat.isFile()) throw new Error(`Patch path is not a file: ${path}`)
      if (stat.ino === 0n) throw new Error(`Filesystem identity unavailable for patch path: ${path}`)
      results[index] = { path: canonical, identity: `existing:${stat.dev}:${stat.ino}` }
      continue
    }

    let ancestor = dirname(path)
    for (;;) {
      try { await fs.lstat(ancestor); break } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
        const parent = dirname(ancestor)
        if (parent === ancestor) throw error
        ancestor = parent
      }
    }
    const canonicalAncestor = await fs.realpath(ancestor)
    if (!(await fs.stat(canonicalAncestor)).isDirectory()) throw new Error(`Patch parent is not a directory: ${ancestor}`)
    const suffix = relative(ancestor, path)
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`)) throw new Error(`Invalid patch path: ${path}`)
    const group = missingByAncestor.get(canonicalAncestor) || []
    group.push({ index, suffix })
    missingByAncestor.set(canonicalAncestor, group)
    results[index] = { path: join(canonicalAncestor, suffix), identity: '' }
  }

  const temporary: string[] = []
  const failures: unknown[] = []
  try {
    for (const [ancestor, group] of missingByAncestor) {
      signal?.throwIfAborted()
      if (group.length === 1) {
        const entry = group[0]
        results[entry.index].identity = `new-path:${results[entry.index].path}`
        continue
      }
      // Mirror only missing paths in a private sibling namespace. Native
      // exclusive creation detects case/normalization aliases without a
      // guessed lowercase key or creating any of the requested target files.
      const staging = await fs.mkdtemp(join(ancestor, '.fluxagent-patch-'))
      temporary.push(staging)
      const parentProbe = `${staging}-caseprobe`
      const parentHandle = await fs.open(parentProbe, 'wx', 0o600)
      temporary.push(parentProbe)
      await parentHandle.close()
      const childProbe = join(staging, 'caseprobe')
      await fs.writeFile(childProbe, '', { flag: 'wx', mode: 0o600 })
      if (await hasCaseAlias(parentProbe) !== await hasCaseAlias(childProbe)) {
        throw new Error(`Unable to mirror directory lookup rules for patch preflight: ${ancestor}`)
      }
      await fs.unlink(parentProbe)
      await fs.unlink(childProbe)

      for (const entry of group) {
        signal?.throwIfAborted()
        const marker = join(staging, entry.suffix)
        await fs.mkdir(dirname(marker), { recursive: true })
        try { await fs.writeFile(marker, '', { flag: 'wx', mode: 0o600 }) } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error
        }
        const stat = await fs.stat(marker, { bigint: true })
        if (!stat.isFile()) throw new Error(`Patch path is both a file and a parent directory: ${results[entry.index].path}`)
        if (stat.ino === 0n) throw new Error(`Filesystem identity unavailable for patch probe: ${ancestor}`)
        results[entry.index].identity = `new:${staging}:${stat.dev}:${stat.ino}`
      }
    }
  } catch (error) { failures.push(error) }
  // Cleanup failure is observable and blocks target writes; never swallow it.
  for (const path of temporary.reverse()) {
    try { await fs.rm(path, { recursive: true, force: true }) } catch (error) {
      failures.push(new Error(`Unable to clean patch path probe: ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }))
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join('; '))
  return results
}

async function hasCaseAlias(path: string): Promise<boolean> {
  const alternative = join(dirname(path), basename(path).toUpperCase())
  try {
    const original = await fs.stat(path, { bigint: true })
    const alias = await fs.stat(alternative, { bigint: true })
    if (original.ino === 0n || alias.ino === 0n) throw new Error(`Filesystem identity unavailable for patch probe: ${path}`)
    return original.dev === alias.dev && original.ino === alias.ino
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}
