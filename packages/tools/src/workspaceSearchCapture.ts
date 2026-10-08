import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rgPath } from '@vscode/ripgrep'
import type { SearchIncompleteReason } from '@fluxos/contracts/toolExecutor'
import { SearchError } from './searchSnapshotStore'

const execFileAsync = promisify(execFile)
export interface SearchCapture { output: string; reasons: SearchIncompleteReason[] }
export type SearchCaptureBackend = (args: string[], cwd: string, signal?: AbortSignal) => Promise<SearchCapture>

/** Process options allow isolated process fixtures and smaller test limits. */
export function createSearchCapture(options: { executable?: string; timeoutMs?: number; maxBytes?: number } = {}): SearchCaptureBackend {
  const packagedPath = rgPath.replace(/\.asar([\\/])/, '.asar.unpacked$1')
  const executable = options.executable ?? (process.platform === 'win32' && !/\.exe$/i.test(packagedPath) ? `${packagedPath}.exe` : packagedPath)
  const timeout = Math.max(1, Math.min(options.timeoutMs ?? 15_000, 15_000))
  const maxBuffer = Math.max(1, Math.min(options.maxBytes ?? 8 * 1024 * 1024, 8 * 1024 * 1024))
  return async (args, cwd, signal) => {
    if (signal?.aborted) throw new SearchError('Search cancelled', 'abort')
    type ProcessError = Error & { code?: string | number; stdout?: string; stderr?: string; killed?: boolean }
    try {
      const pending = execFileAsync(executable, args, { cwd, signal, encoding: 'utf8', windowsHide: true,
        timeout, maxBuffer, killSignal: 'SIGKILL' })
      // Cancellation may precede release of directory handles. Do not return until close.
      const closed = new Promise<void>(resolveClose => pending.child.once('close', () => resolveClose()))
      const { stdout } = await pending.finally(() => closed)
      return { output: stdout, reasons: [] }
    } catch (error) {
      const failure = error as ProcessError
      if (signal?.aborted || failure.code === 'ABORT_ERR') throw new SearchError('Search cancelled', 'abort')
      const output = String(failure.stdout || '')
      if (failure.code === 1) return { output, reasons: [] }
      if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { output, reasons: ['capture_budget'] }
      if (failure.killed) return { output, reasons: ['timeout'] }
      if (failure.code === 2 && output) return { output, reasons: ['path_error'] }
      throw new SearchError(String(failure.stderr || failure.message || failure).trim(), failure.code === 'ENOENT' ? 'environment' : 'execution')
    }
  }
}
