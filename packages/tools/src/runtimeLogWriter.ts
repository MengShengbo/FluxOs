import { appendFile, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { runtimeLogSegments, type RuntimeLogSegment } from './runtimeLogSegments'

export interface RuntimeLogWriterOptions {
  maxFileBytes?: number
  maxFiles?: number
  batchBytes?: number
  highWaterBytes?: number
  onDrain?: () => void
  onError?: (error: Error) => void
}

const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_FILES = 8
const DEFAULT_BATCH_BYTES = 256 * 1024
const DEFAULT_HIGH_WATER_BYTES = 2 * 1024 * 1024

export class RuntimeLogWriter {
  private queue: string[] = []
  private queuedBytes = 0
  private fileBytes = 0
  private draining = false
  private closing = false
  private closed = false
  private failed = false
  private initialized = false
  private waiters: Array<() => void> = []
  private readonly maxFileBytes: number
  private readonly maxFiles: number
  private readonly batchBytes: number
  private readonly highWaterBytes: number
  private activePath: string
  private activeStart = 0
  private segments: RuntimeLogSegment[] = []
  private readonly decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }

  constructor(private readonly path: string, private readonly options: RuntimeLogWriterOptions = {}) {
    this.activePath = path
    this.maxFileBytes = Math.max(1024, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES)
    this.batchBytes = Math.max(1024, options.batchBytes ?? DEFAULT_BATCH_BYTES)
    this.highWaterBytes = Math.max(this.batchBytes, options.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES)
  }

  append(channel: 'stdout' | 'stderr', data: Buffer | string, sequence?: number): boolean {
    if (this.failed) return true
    if (this.closing || this.closed) return false
    const text = typeof data === 'string' ? this.decoders[channel].end() + data : this.decoders[channel].write(data)
    if (text) this.enqueue(channel, text, sequence)
    return this.queuedBytes < this.highWaterBytes
  }

  private enqueue(channel: 'stdout' | 'stderr', text: string, sequence?: number): void {
    const record = `${JSON.stringify({
      timestamp: Date.now(),
      channel,
      data: text,
      ...(typeof sequence === 'number' ? { seq: sequence } : {}),
    })}\n`
    this.queue.push(record)
    this.queuedBytes += Buffer.byteLength(record)
    void this.drain()
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0 && !this.draining) return
    await new Promise<void>(resolve => this.waiters.push(resolve))
  }

  async close(): Promise<void> {
    if (this.closed) return
    if (!this.closing && !this.failed) {
      for (const channel of ['stdout', 'stderr'] as const) {
        const tail = this.decoders[channel].end()
        if (tail) this.enqueue(channel, tail)
      }
    }
    this.closing = true
    await this.flush()
    this.closed = true
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    await mkdir(dirname(this.path), { recursive: true })
    this.segments = runtimeLogSegments(this.path)
    const last = this.segments.at(-1)
    this.activePath = last?.path ?? this.path
    this.activeStart = last?.start ?? 0
    this.fileBytes = last?.size ?? 0
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closed) return
    this.draining = true
    try {
      await this.initialize()
      while (this.queue.length > 0) {
        const batch: string[] = []
        let batchSize = 0
        while (this.queue.length > 0 && batchSize < this.batchBytes) {
          const record = this.queue.shift()!
          const recordBytes = Buffer.byteLength(record)
          batch.push(record)
          batchSize += recordBytes
          this.queuedBytes -= recordBytes
        }
        if (this.fileBytes > 0 && this.fileBytes + batchSize > this.maxFileBytes) {
          await this.rotate()
        }
        await appendFile(this.activePath, batch.join(''), { encoding: 'utf8', mode: 0o600 })
        this.fileBytes += batchSize
        if (this.segments.at(-1)?.path !== this.activePath) this.segments.push({ path: this.activePath, start: this.activeStart, size: 0 })
        this.segments.at(-1)!.size = this.fileBytes
        // Publish the new segment before evicting retained data. Never rename/reuse a cursor's file.
        while (this.segments.length > this.maxFiles) await rm(this.segments.shift()!.path, { force: true })
        if (this.queuedBytes < this.highWaterBytes) this.options.onDrain?.()
      }
    } catch (error) {
      this.failed = true
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
      this.queue = []
      this.queuedBytes = 0
      this.options.onDrain?.()
    } finally {
      this.draining = false
      if (this.queue.length > 0 && !this.closed) {
        void this.drain()
        return
      }
      const waiters = this.waiters.splice(0)
      for (const resolve of waiters) resolve()
    }
  }

  private async rotate(): Promise<void> {
    this.activeStart += this.fileBytes
    this.activePath = `${this.path}.offset-${this.activeStart}`
    this.fileBytes = 0
  }
}
