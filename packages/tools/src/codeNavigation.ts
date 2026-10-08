import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { CodeNavigationRequest, CodeNavigationResult, Result } from '@fluxos/contracts/toolExecutor'

const require = createRequire(import.meta.url)

export function validateNavigation(request: CodeNavigationRequest): string | undefined {
  if (!['definition', 'references', 'diagnostics'].includes(request.operation)) return 'Unsupported navigation operation'
  if (!request.path || request.path.includes('\0')) return 'A nonempty source path is required'
  if (request.operation !== 'diagnostics' && (!Number.isSafeInteger(request.line) || request.line! < 1 || !Number.isSafeInteger(request.column) || request.column! < 1)) return 'Definition/references require one-based line and UTF-16 column'
  if (request.operation === 'diagnostics' && (request.line !== undefined || request.column !== undefined)) return 'Diagnostics operate on a file; omit line and column'
  for (const version of [request.sourceVersion, request.projectVersion]) if (version !== undefined && !/^[a-f0-9]{64}$/.test(version)) return 'Versions must be SHA-256 values returned by code_navigation'
  if (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0)) return 'offset must be a nonnegative safe integer'
  if ((request.offset ?? 0) > 0 && !request.projectVersion) return 'Nonzero offset requires project_version; refresh if the project changed'
  if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 500)) return 'limit must be an integer from 1 to 500'
  return undefined
}

/** One disposable compiler worker per invocation; never blocks the host event loop. */
export class CodeNavigationService {
  private active = 0
  constructor(private readonly timeoutMs = 10_000) {}

  async run(workspace: string, request: CodeNavigationRequest): Promise<Result<CodeNavigationResult>> {
    const invalid = validateNavigation(request)
    if (invalid) return { success: false, errorKind: 'validation', error: invalid }
    if (request.signal?.aborted) return { success: false, errorKind: 'abort', error: 'Code navigation cancelled' }
    if (this.active >= 2) return { success: false, errorKind: 'environment', error: 'Two compiler queries are already running; retry after one completes' }
    this.active++
    try {
      const { signal, ...input } = request
      const workerPath = require.resolve('@fluxos/tools/codeNavigationWorker').replace(/\.asar([\\/])/, '.asar.unpacked$1')
      const worker = new Worker(workerPath, { workerData: { workspace, request: input },
        resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 } })
      return await new Promise<Result<CodeNavigationResult>>(resolveResult => {
        let settled = false
        const finish = async (result: Result<CodeNavigationResult>) => {
          if (settled) return
          settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
          try { await worker.terminate() } finally { resolveResult(result) }
        }
        const abort = () => { void finish({ success: false, errorKind: 'abort', error: 'Code navigation cancelled; compiler worker terminated' }) }
        const timeoutMs = Number.isFinite(this.timeoutMs) ? Math.max(1, Math.min(10_000, this.timeoutMs)) : 10_000
        const timer = setTimeout(() => { void finish({ success: false, errorKind: 'environment', error: `Code navigation exceeded ${timeoutMs} ms; compiler worker terminated. Narrow the project.` }) }, timeoutMs)
        worker.once('message', (result: Result<CodeNavigationResult>) => { void finish(result) })
        worker.once('error', error => { void finish({ success: false, errorKind: 'environment', error: `Compiler worker failed: ${error.message}` }) })
        worker.once('exit', code => { if (!settled) void finish({ success: false, errorKind: 'environment', error: `Compiler worker exited without a result (${code})` }) })
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
    } catch (error) {
      return { success: false, errorKind: 'environment', error: error instanceof Error ? error.message : String(error) }
    } finally { this.active-- }
  }
}
