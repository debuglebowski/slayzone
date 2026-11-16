import { mkdtemp, open, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A generation's lossless overflow. One pipe chunk (or complete protocol record)
 * may be in memory; subsequent input waits for its async file write, NEVER for
 * chat SQLite. Control responses are consumed before entering this queue.
 *
 * Unlink immediately after opening: no named content copy survives a crash.
 * Close/erasure wait for drain and physical file close. No durability claim is
 * made for this transient buffer; committed history remains SQLite's job.
 */
export class ChatOutputSpool {
  private file: Promise<FileHandle> | null = null
  private pending: string[] = []
  private writing: Promise<void> | null = null
  private reading: Promise<void> | null = null
  private written = 0
  private read = 0
  private resetting: Promise<void> | null = null
  private failed: Error | null = null
  private closed = false
  private closing: Promise<void> | null = null
  private waiters = new Set<() => void>()
  private peakMemoryBytes = 0
  private memoryBytes = 0
  private totalRecords = 0

  constructor(
    private readonly io: {
      flow(paused: boolean): void
      available(): boolean
      consume(line: string): void
      failure(error: Error): void
    }
  ) {}

  get busy(): boolean {
    return (
      !this.closed &&
      (!!this.writing || !!this.reading || this.pending.length > 0 || this.read < this.written)
    )
  }

  get stats() {
    return {
      pendingInputBytes: this.memoryBytes,
      peakPendingInputBytes: this.peakMemoryBytes,
      diskBytes: this.written - this.read,
      totalRecords: this.totalRecords
    }
  }

  push(line: string): void {
    if (this.closed || this.failed) return
    this.pending.push(line)
    this.totalRecords++
    this.memoryBytes += Buffer.byteLength(line) + 4
    this.peakMemoryBytes = Math.max(this.peakMemoryBytes, this.memoryBytes)
    this.io.flow(true)
    if (this.writing) return
    // Batch the remainder of this chunk, rather than one promise/write per line.
    this.writing = Promise.resolve()
      .then(() => this.write())
      .catch((e) => this.fail(e))
      .finally(() => {
        this.writing = null
        this.io.flow(false)
        this.pump()
        this.wake()
      })
  }

  private async open(): Promise<FileHandle> {
    const dir = await mkdtemp(join(tmpdir(), 'slay-chat-output-'))
    const path = join(dir, 'output')
    let file: FileHandle | undefined
    try {
      file = await open(path, 'wx+', 0o600)
      await unlink(path)
      await rmdir(dir)
      return file
    } catch (error) {
      await file?.close()
      await unlink(path).catch(() => undefined)
      await rmdir(dir).catch(() => undefined)
      throw error
    }
  }

  private async write(): Promise<void> {
    await this.resetting
    const file = await (this.file ??= this.open())
    while (this.pending.length && !this.closed) {
      const batch = this.pending
      this.pending = []
      const records = batch
        .map((line) => {
          const body = Buffer.from(line)
          const header = Buffer.allocUnsafe(4)
          header.writeUInt32LE(body.length)
          return [header, body]
        })
        .flat()
      const data = Buffer.concat(records)
      let offset = 0
      while (offset < data.length) {
        const { bytesWritten } = await file.write(
          data,
          offset,
          data.length - offset,
          this.written + offset
        )
        if (!bytesWritten) throw new Error('Chat output spool made no write progress')
        offset += bytesWritten
      }
      this.written += data.length
      this.memoryBytes -= data.length
      this.pump()
    }
  }

  pump(): void {
    if (this.reading || this.closed || this.failed) return
    if (this.read === this.written && this.written > 0 && !this.writing && this.file) {
      this.resetting = this.file.then(async (file) => {
        await file.truncate(0)
        this.read = this.written = 0
      })
      this.reading = this.resetting
        .catch((e) => this.fail(e))
        .finally(() => {
          this.resetting = null
          this.reading = null
          this.wake()
          this.pump()
        })
      return
    }
    if (!this.io.available() || this.read === this.written) return
    this.reading = this.consume()
      .catch((e) => this.fail(e))
      .finally(() => {
        this.reading = null
        this.wake()
        // A release can race the last read's finally.
        this.pump()
      })
  }

  private async consume(): Promise<void> {
    const file = await this.file!
    while (!this.closed && this.io.available() && this.read < this.written) {
      const header = Buffer.allocUnsafe(4)
      await this.readExactly(file, header, this.read)
      const body = Buffer.allocUnsafe(header.readUInt32LE())
      await this.readExactly(file, body, this.read + 4)
      if (this.closed) return
      this.read += body.length + 4
      this.io.consume(body.toString('utf8'))
    }
  }

  private async readExactly(file: FileHandle, data: Buffer, position: number) {
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, position + offset)
      if (!bytesRead) throw new Error('Chat output spool ended before its published prefix')
      offset += bytesRead
    }
  }

  private fail(error: unknown) {
    this.failed ??= error instanceof Error ? error : new Error(String(error))
    this.io.failure(this.failed)
  }

  private wake() {
    for (const resolve of this.waiters) resolve()
    this.waiters.clear()
  }

  async drain(): Promise<void> {
    // isolation: fatal — A failed output prefix must reject its entire generation drain.
    while (this.busy && !this.failed && !this.closed) {
      const changed = new Promise<void>((r) => this.waiters.add(r))
      this.pump()
      await changed
    }
    if (this.failed) throw this.failed
  }

  async acceptInput(): Promise<void> {
    while (this.writing) await this.writing
    if (this.failed) throw this.failed
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    const work = this.closeOwned()
    this.closing = work
    void work.catch(() => {
      if (this.closing === work) this.closing = null
    })
    return work
  }

  private async closeOwned(): Promise<void> {
    this.closed = true
    this.pending = []
    this.memoryBytes = 0
    this.wake()
    await Promise.all([this.writing, this.reading])
    await (await this.file)?.close()
    this.file = null
    this.io.flow(false)
  }
}
