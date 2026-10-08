import type { ToolResult } from '@fluxos/contracts/agentTypes'
import type { FileMutationResult, FileMutationState, PatchPathIdentity, ToolExecutor } from '@fluxos/contracts/toolExecutor'
import type { PatchFileEffect, PatchReceipt } from '@fluxos/contracts/toolResultData'
import { hashText } from '@fluxos/platform/fileIO'
import { applyPatchHunks, parseApplyPatch, type ApplyPatchOperation } from '@fluxos/tools/applyPatch'

type Effect = PatchFileEffect & { state: FileMutationState }
type Prepared = {
  operation: ApplyPatchOperation
  source: PatchPathIdentity
  target?: PatchPathIdentity
  sourceHash?: string
  targetHash?: string
  nextContent?: string
  effects: Effect[]
}

function resultFromEffects(effects: Effect[], failure?: PatchReceipt['failure']): Pick<ToolResult, 'output' | 'isError' | 'errorKind'> & { data: PatchReceipt } {
  const select = (state: FileMutationState) => effects.filter(effect => effect.state === state).map(({ state: _state, ...effect }) => effect)
  const committed = select('committed')
  const pending = select('not_committed')
  const unknown = select('unknown')
  const status = !failure ? 'completed' : committed.length ? 'partial' : unknown.length ? 'unknown' : 'failed'
  const data: PatchReceipt = { kind: 'patch', status, committed, pending, unknown, ...(failure ? { failure } : {}) }
  // Keep status and complete counts first, including when the model's output
  // budget later limits the path listing. The full typed receipt is persisted.
  const lines = [`Patch status: ${status}`, `committed=${committed.length}; pending=${pending.length}; unknown=${unknown.length}`]
  if (failure) {
    lines.push(`Failure stage: ${failure.stage}${failure.operationIndex === undefined ? '' : `; operation=${failure.operationIndex}`}; ${failure.message}`)
    lines.push('Do not blindly retry or roll back this patch. Inspect unknown paths and current contents before preparing a remaining patch. Committed facts may have been changed by another writer since acknowledgement.')
  } else lines.push('Patch applied. All requested file effects acknowledged.')
  for (const [label, entries] of [['Unknown', unknown], ['Committed', committed], ['Pending', pending]] as const) {
    if (entries.length) lines.push(`${label}:`, ...entries.map(entry => JSON.stringify(entry)))
  }
  return { output: lines.join('\n'), data, isError: Boolean(failure), ...(failure ? { errorKind: failure.stage === 'cancelled' ? 'abort' : failure.stage === 'parse' || failure.stage === 'preflight' ? 'validation' : 'execution' } : {}) }
}

/** Sequential file effects with receipts; intentionally no rollback or transaction claim. */
export async function executePatch(
  patch: string,
  basePath: string,
  executor: ToolExecutor,
  captureBeforeSnapshot: (path: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<Pick<ToolResult, 'output' | 'isError' | 'errorKind'> & { data: PatchReceipt }> {
  const effects: Effect[] = []
  const prepared: Prepared[] = []
  let stage: NonNullable<PatchReceipt['failure']>['stage'] = 'parse'
  let operationIndex: number | undefined
  let path: string | undefined
  const checkCancellation = () => { if (signal?.aborted) { stage = 'cancelled'; signal.throwIfAborted() } }
  try {
    const operations = parseApplyPatch(patch)
    const operationEffects = operations.map((operation, index) => {
      const entries: Effect[] = operation.kind === 'update' && operation.moveTo
        ? [{ operationIndex: index, path: operation.moveTo, displayPath: operation.moveTo, action: 'write', state: 'not_committed' },
          { operationIndex: index, path: operation.path, displayPath: operation.path, action: 'delete', state: 'not_committed' }]
        : [{ operationIndex: index, path: operation.path, displayPath: operation.path, action: operation.kind === 'delete' ? 'delete' : 'write', state: 'not_committed' }]
      effects.push(...entries)
      return entries
    })
    stage = 'paths'
    checkCancellation()
    const requested = operations.flatMap(operation => operation.kind === 'update' && operation.moveTo ? [operation.path, operation.moveTo] : [operation.path])
    const resolved = await executor.resolvePatchPaths(requested, basePath, signal)
    checkCancellation()
    if (!resolved.success || !resolved.data || resolved.data.length !== requested.length) throw new Error(resolved.error || 'Incomplete patch path preflight')
    if (resolved.data.some(entry => !entry || typeof entry.path !== 'string' || !entry.path || typeof entry.identity !== 'string' || !entry.identity || typeof entry.relativePath !== 'string')) throw new Error('Invalid patch path identity from executor')
    const touched = new Set<string>()
    let cursor = 0
    for (const [index, operation] of operations.entries()) {
      const source = resolved.data[cursor++]!
      const target = operation.kind === 'update' && operation.moveTo ? resolved.data[cursor++]! : undefined
      const entries = operationEffects[index]
      const fileIdentities = target ? [target, source] : [source]
      for (const [entryIndex, identity] of fileIdentities.entries()) {
        entries[entryIndex].path = identity.path
        entries[entryIndex].displayPath = identity.relativePath
      }
      prepared.push({ operation, source, target, effects: entries })
    }
    stage = 'preflight'
    const read = async (identity: PatchPathIdentity) => {
      const result = await executor.readFile(identity.path)
      if (result.success) {
        if (typeof result.data !== 'string') throw new Error(`Missing file contents: ${identity.relativePath}`)
        return { content: result.data, hash: hashText(result.data) }
      }
      const error = result.error || 'Unknown read failure'
      if (/not found|no such file|does not exist/i.test(error)) return { content: null, hash: undefined }
      throw new Error(`Unable to inspect ${identity.relativePath}: ${error}`)
    }
    for (const [index, item] of prepared.entries()) {
      operationIndex = index
      path = item.source.path
      checkCancellation()
      for (const identity of item.target ? [item.source, item.target] : [item.source]) {
        if (touched.has(identity.identity)) throw new Error(`Patch touches the same file more than once: ${identity.relativePath}`)
        touched.add(identity.identity)
      }
      const source = await read(item.source)
      item.sourceHash = source.hash
      if (item.operation.kind === 'add') { item.nextContent = item.operation.content; continue }
      if (source.content === null) throw new Error(`${item.operation.kind} requires an existing file: ${item.operation.path}`)
      if (item.operation.kind === 'delete') continue
      item.nextContent = applyPatchHunks(source.content, item.operation.hunks, item.operation.path)
      if (item.target) item.targetHash = (await read(item.target)).hash
    }
    stage = 'snapshot'
    for (const [index, item] of prepared.entries()) {
      operationIndex = index
      for (const identity of item.target ? [item.source, item.target] : [item.source]) {
        path = identity.path
        checkCancellation()
        await captureBeforeSnapshot(identity.path)
      }
    }
    const mutate = async (effect: Effect, action: () => Promise<FileMutationResult>) => {
      path = effect.path
      checkCancellation()
      // Once called, lack of an acknowledgement is unknown, even if a later
      // read happens to equal the planned bytes. Reads cannot prove authorship.
      effect.state = 'unknown'
      const result = await action()
      if (!['committed', 'not_committed', 'unknown'].includes(result.mutation)) throw new Error('Executor returned no valid file mutation receipt')
      if (result.success && result.mutation !== 'committed') throw new Error('Executor acknowledged success without a committed mutation')
      effect.state = result.mutation
      if (!result.success) throw new Error(result.error)
    }
    for (const [index, item] of prepared.entries()) {
      operationIndex = index
      if (item.operation.kind === 'delete') {
        stage = 'delete'
        await mutate(item.effects[0], () => executor.deleteFile(item.source.path, { expectedHash: item.sourceHash }))
      } else if (item.target) {
        // Even unchanged-content moves use checked target publication followed
        // by checked source deletion, so either half has its own receipt.
        stage = 'move_target'
        await mutate(item.effects[0], () => executor.writeFile(item.target!.path, item.nextContent!, {
          source: 'ai', label: 'AI apply_patch move',
          ...(item.targetHash ? { expectedHash: item.targetHash } : { expectNotExists: true }),
        }))
        stage = 'move_cleanup'
        await mutate(item.effects[1], () => executor.deleteFile(item.source.path, { expectedHash: item.sourceHash }))
      } else {
        stage = 'write'
        await mutate(item.effects[0], () => executor.writeFile(item.source.path, item.nextContent!, {
          source: 'ai', label: `AI apply_patch ${item.operation.kind}`,
          ...(item.sourceHash ? { expectedHash: item.sourceHash } : { expectNotExists: true }),
        }))
      }
    }
    return resultFromEffects(effects)
  } catch (error) {
    return resultFromEffects(effects, { stage, ...(operationIndex === undefined ? {} : { operationIndex }), ...(path === undefined ? {} : { path }), message: error instanceof Error ? error.message : String(error) })
  }
}
