import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface AtomicJsonLoadResult<T> {
  value: T
  warnings: string[]
}

export class AtomicJsonStore<T> {
  constructor(
    readonly filePath: string,
    private readonly createDefault: () => T,
    private readonly validate: (value: unknown) => value is T,
  ) {}

  load(): AtomicJsonLoadResult<T> {
    let text: string
    try { text = readFileSync(this.filePath, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: this.createDefault(), warnings: [] }
      throw error
    }
    try {
      const parsed = JSON.parse(text) as unknown
      if (!this.validate(parsed)) throw new Error('unsupported schema')
      return { value: parsed, warnings: [] }
    } catch (error) {
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`
      // Recovery may return an empty store only after preserving the original.
      renameSync(this.filePath, backupPath)
      return {
        value: this.createDefault(),
        warnings: [`Recovered an invalid store at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`],
      }
    }
  }

  save(value: T): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporaryPath, this.filePath)
    } finally {
      try { rmSync(temporaryPath, { force: true }) } catch {}
    }
  }
}
