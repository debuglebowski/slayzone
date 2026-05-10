import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'

const requireFromHere = createRequire(import.meta.url)
function getElectronUserData(): string {
  // Lazy-loaded so unit tests can import this module without electron app context.
  // Tests pass a baseDirOverride and never reach this path.
  const electron = requireFromHere('electron') as typeof import('electron')
  return electron.app.getPath('userData')
}

const DEFAULT_CAP_BYTES = 10 * 1024 * 1024
const ROTATE_DROP_BYTES = 2 * 1024 * 1024
const READ_CHUNK_SIZE = 64 * 1024
const TAIL_HARD_CAP_BYTES = 5 * 1024 * 1024

const UUID_LIKE = /^[a-zA-Z0-9_-]+$/

export interface HistorySnapshot {
  data: string
  earliestOffset: number
  totalSize: number
}

export interface HistoryRange {
  data: string
  earliestOffset: number
}

function isSafeId(s: string): boolean {
  return s.length > 0 && s.length < 128 && UUID_LIKE.test(s)
}

interface SessionWriter {
  stream: fs.WriteStream
  bytesWritten: number
}

export class ScrollbackArchive {
  private baseDirOverride: string | null = null
  private writers = new Map<string, SessionWriter>()
  private rotating = new Set<string>()
  private capBytes = DEFAULT_CAP_BYTES

  constructor(baseDirOverride?: string) {
    if (baseDirOverride) this.baseDirOverride = baseDirOverride
  }

  setCapBytes(bytes: number): void {
    if (bytes >= 1 * 1024 * 1024) this.capBytes = bytes
  }

  getCapBytes(): number {
    return this.capBytes
  }

  private getBaseDir(): string {
    if (this.baseDirOverride) return this.baseDirOverride
    return join(process.env.SLAYZONE_DB_DIR || getElectronUserData(), 'scrollback')
  }

  private parseStableId(stableId: string): { taskId: string; tabId: string } | null {
    const idx = stableId.indexOf(':')
    if (idx <= 0 || idx === stableId.length - 1) return null
    const taskId = stableId.slice(0, idx)
    const tabId = stableId.slice(idx + 1)
    if (!isSafeId(taskId) || !isSafeId(tabId)) return null
    return { taskId, tabId }
  }

  private filePath(stableId: string): string | null {
    const ids = this.parseStableId(stableId)
    if (!ids) return null
    return join(this.getBaseDir(), ids.taskId, `${ids.tabId}.log`)
  }

  private taskDir(taskId: string): string {
    return join(this.getBaseDir(), taskId)
  }

  private getWriter(stableId: string): SessionWriter | null {
    const cached = this.writers.get(stableId)
    if (cached) return cached
    const filePath = this.filePath(stableId)
    if (!filePath) return null
    try {
      fs.mkdirSync(dirname(filePath), { recursive: true })
      let initialSize = 0
      try { initialSize = fs.statSync(filePath).size } catch { /* file missing → 0 */ }
      const stream = fs.createWriteStream(filePath, { flags: 'a' })
      stream.on('error', () => { /* swallow; archive is best-effort */ })
      const writer: SessionWriter = { stream, bytesWritten: initialSize }
      this.writers.set(stableId, writer)
      return writer
    } catch {
      return null
    }
  }

  append(stableId: string, data: string): void {
    if (data.length === 0) return
    // Drop during rotation. The bytes were destined for the front-truncated region
    // anyway, so the loss is bounded to a few MB at most and only on overflow.
    if (this.rotating.has(stableId)) return
    const writer = this.getWriter(stableId)
    if (!writer) return
    writer.stream.write(data)
    writer.bytesWritten += Buffer.byteLength(data, 'utf8')
    if (writer.bytesWritten > this.capBytes) {
      void this.rotate(stableId)
    }
  }

  // Wait for all queued writes to be flushed to the OS before reading.
  // Without this, a getTailLines() racing a recent append() could miss bytes
  // that are still in the WriteStream's internal buffer.
  private drain(stableId: string): Promise<void> {
    const writer = this.writers.get(stableId)
    if (!writer) return Promise.resolve()
    return new Promise<void>((resolve) => {
      writer.stream.write('', () => resolve())
    })
  }

  async closeStream(stableId: string): Promise<void> {
    const writer = this.writers.get(stableId)
    if (!writer) return
    this.writers.delete(stableId)
    await new Promise<void>((resolve) => {
      writer.stream.end(() => resolve())
    })
  }

  async size(stableId: string): Promise<number> {
    const filePath = this.filePath(stableId)
    if (!filePath) return 0
    await this.drain(stableId)
    try {
      return (await fs.promises.stat(filePath)).size
    } catch {
      return 0
    }
  }

  async delete(stableId: string): Promise<void> {
    await this.closeStream(stableId)
    const filePath = this.filePath(stableId)
    if (!filePath) return
    try {
      await fs.promises.rm(filePath, { force: true })
    } catch { /* ignore */ }
    const ids = this.parseStableId(stableId)
    if (ids) {
      try {
        const dir = this.taskDir(ids.taskId)
        const entries = await fs.promises.readdir(dir)
        if (entries.length === 0) await fs.promises.rmdir(dir)
      } catch { /* ignore */ }
    }
  }

  async deleteTask(taskId: string): Promise<void> {
    if (!isSafeId(taskId)) return
    const dir = this.taskDir(taskId)
    const idsToClose: string[] = []
    for (const id of this.writers.keys()) {
      if (id.startsWith(`${taskId}:`)) idsToClose.push(id)
    }
    await Promise.all(idsToClose.map((id) => this.closeStream(id)))
    try {
      await fs.promises.rm(dir, { recursive: true, force: true })
    } catch { /* ignore */ }
  }

  async sweepOrphans(isLiveTask: (taskId: string) => boolean, isLiveTab: (taskId: string, tabId: string) => boolean): Promise<void> {
    const baseDir = this.getBaseDir()
    let taskDirs: string[]
    try {
      taskDirs = await fs.promises.readdir(baseDir)
    } catch {
      return
    }
    for (const taskId of taskDirs) {
      if (!isSafeId(taskId)) continue
      const tDir = join(baseDir, taskId)
      let stat: fs.Stats
      try {
        stat = await fs.promises.stat(tDir)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      if (!isLiveTask(taskId)) {
        try { await fs.promises.rm(tDir, { recursive: true, force: true }) } catch { /* ignore */ }
        continue
      }
      let tabFiles: string[]
      try {
        tabFiles = await fs.promises.readdir(tDir)
      } catch {
        continue
      }
      for (const f of tabFiles) {
        if (!f.endsWith('.log')) continue
        const tabId = f.slice(0, -4)
        if (!isSafeId(tabId)) continue
        if (!isLiveTab(taskId, tabId)) {
          try { await fs.promises.rm(join(tDir, f), { force: true }) } catch { /* ignore */ }
        }
      }
    }
  }

  async getTailLines(stableId: string, lineCount: number): Promise<HistorySnapshot> {
    const filePath = this.filePath(stableId)
    if (!filePath || lineCount <= 0) return { data: '', earliestOffset: 0, totalSize: 0 }
    await this.drain(stableId)
    try {
      const stats = await fs.promises.stat(filePath)
      if (stats.size === 0) return { data: '', earliestOffset: 0, totalSize: 0 }
      const fh = await fs.promises.open(filePath, 'r')
      try {
        const earliestOffset = await scanBackwardForLines(fh, stats.size, lineCount)
        const len = stats.size - earliestOffset
        const out = Buffer.alloc(len)
        if (len > 0) await fh.read(out, 0, len, earliestOffset)
        return { data: out.toString('utf8'), earliestOffset, totalSize: stats.size }
      } finally {
        await fh.close()
      }
    } catch {
      return { data: '', earliestOffset: 0, totalSize: 0 }
    }
  }

  async getRangeLinesBefore(stableId: string, currentEarliestOffset: number, lineCount: number): Promise<HistoryRange> {
    const filePath = this.filePath(stableId)
    if (!filePath || lineCount <= 0 || currentEarliestOffset <= 0) {
      return { data: '', earliestOffset: Math.max(0, currentEarliestOffset) }
    }
    await this.drain(stableId)
    try {
      const fh = await fs.promises.open(filePath, 'r')
      try {
        const earliestOffset = await scanBackwardForLines(fh, currentEarliestOffset, lineCount)
        const len = currentEarliestOffset - earliestOffset
        const out = Buffer.alloc(len)
        if (len > 0) await fh.read(out, 0, len, earliestOffset)
        return { data: out.toString('utf8'), earliestOffset }
      } finally {
        await fh.close()
      }
    } catch {
      return { data: '', earliestOffset: currentEarliestOffset }
    }
  }

  private async rotate(stableId: string): Promise<void> {
    if (this.rotating.has(stableId)) return
    this.rotating.add(stableId)
    try {
      const filePath = this.filePath(stableId)
      if (!filePath) return
      // Close the live writer first so we can safely rewrite the file.
      const writer = this.writers.get(stableId)
      if (writer) {
        this.writers.delete(stableId)
        await new Promise<void>((resolve) => writer.stream.end(() => resolve()))
      }
      const stats = await fs.promises.stat(filePath).catch(() => null)
      if (!stats || stats.size <= this.capBytes) return
      // Drop ~20% of cap (or ROTATE_DROP_BYTES, whichever is smaller).
      // Scaling with cap protects small-cap configurations where the static
      // drop would consume the entire keep budget.
      const dropBytes = Math.min(ROTATE_DROP_BYTES, Math.floor(this.capBytes / 5))
      const keepBytes = this.capBytes - dropBytes
      let cutOffset = Math.max(0, stats.size - keepBytes)
      const fh = await fs.promises.open(filePath, 'r')
      try {
        // Align to next '\n' boundary forward so partial-line corruption can't happen.
        const probe = Buffer.alloc(8192)
        const { bytesRead: probed } = await fh.read(probe, 0, probe.length, cutOffset)
        const nlIdx = probe.indexOf(0x0a, 0)
        if (nlIdx >= 0 && nlIdx < probed) cutOffset += nlIdx + 1
        const tempPath = filePath + '.tmp'
        const out = await fs.promises.open(tempPath, 'w')
        try {
          const buf = Buffer.alloc(64 * 1024)
          let pos = cutOffset
          while (pos < stats.size) {
            const remaining = stats.size - pos
            const r = await fh.read(buf, 0, Math.min(buf.length, remaining), pos)
            if (r.bytesRead === 0) break
            await out.write(buf, 0, r.bytesRead)
            pos += r.bytesRead
          }
        } finally {
          await out.close()
        }
        await fs.promises.rename(tempPath, filePath)
      } finally {
        await fh.close()
      }
    } catch {
      // best-effort; if rotation fails, the file just stays oversized
    } finally {
      this.rotating.delete(stableId)
    }
  }
}

async function scanBackwardForLines(fh: fs.promises.FileHandle, endOffset: number, lineCount: number): Promise<number> {
  if (endOffset <= 0) return 0
  const buf = Buffer.alloc(READ_CHUNK_SIZE)
  let offset = endOffset
  let newlines = 0
  const minOffset = Math.max(0, endOffset - TAIL_HARD_CAP_BYTES)
  // Skip a trailing '\n' so it doesn't count as a blank final line.
  // Read 1 byte before endOffset to check.
  if (offset > 0) {
    const probe = Buffer.alloc(1)
    await fh.read(probe, 0, 1, offset - 1)
    if (probe[0] === 0x0a) {
      // Treat the trailing newline as part of the last line, not a separator.
      // Don't increment newlines for it.
    }
  }
  while (offset > minOffset) {
    const readSize = Math.min(buf.length, offset - minOffset)
    const readFrom = offset - readSize
    const { bytesRead } = await fh.read(buf, 0, readSize, readFrom)
    for (let i = bytesRead - 1; i >= 0; i--) {
      // Skip the very last byte of file if it's '\n' (it terminates the final line)
      if (readFrom + i === endOffset - 1 && buf[i] === 0x0a) continue
      if (buf[i] === 0x0a) {
        newlines++
        if (newlines >= lineCount) {
          return readFrom + i + 1
        }
      }
    }
    offset = readFrom
  }
  return offset
}

export const scrollbackArchive = new ScrollbackArchive()
