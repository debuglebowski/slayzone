// Saving a download onto THIS machine — artifact file, folder and zip downloads. The
// hub only serves the bytes, in bounded pieces (`artifacts.readBytesChunk`); the
// renderer streams them here and main writes them, so a download lands on the
// person's own disk whether the hub is local or remote, and no size has to fit in
// memory. A zip is compressed by archiver on zlib's thread pool: off the UI and off
// main's event loop. Reached over `app:save-target-*`.
import { createWriteStream, mkdirSync, rmSync, type WriteStream } from 'fs'
import { open, rename, unlink, type FileHandle } from 'fs/promises'
import { randomUUID } from 'crypto'
import { basename, dirname, extname, join } from 'path'
import { PassThrough } from 'stream'
import { once } from 'events'
import { BrowserWindow, app, dialog, shell } from 'electron'
import { ZipArchive } from 'archiver'
import { containedPath } from '@slayzone/platform/safe-path'
import type {
  HostSaveResult,
  SaveTargetOpenResult,
  SaveTargetRequest
} from '@slayzone/platform/electron-bootstrap-contract'

/** A cleanup step whose failure must not replace the error being reported. */
const ignore = (): void => undefined

/** The renderer's request, checked: it crosses the IPC boundary untyped. */
export function parseSaveTargetRequest(raw: unknown): SaveTargetRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.title !== 'string') return null
  const reveal = r.reveal === true
  if ((r.kind === 'file' || r.kind === 'zip') && typeof r.fileName === 'string')
    return { kind: r.kind, fileName: r.fileName, title: r.title, reveal }
  if (r.kind === 'directory' && typeof r.folderName === 'string')
    return { kind: 'directory', folderName: r.folderName, title: r.title }
  return null
}

interface Target {
  write(path: string, data: Uint8Array): Promise<void>
  mkdir(path: string): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

/** Already compressed: stored as is, not deflated again. */
const STORED = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.heic',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.mp3',
  '.mp4',
  '.m4a',
  '.mov',
  '.webm',
  '.mkv',
  '.woff2'
])

/**
 * Where a file is written until it is complete: a hidden sibling, renamed into place
 * on success. A download is never visible half-written, and one that fails or is
 * aborted leaves nothing at the destination.
 */
function partialPath(dest: string): string {
  return join(dirname(dest), `.${basename(dest)}.slayzone-partial-${randomUUID().slice(0, 8)}`)
}

/** One file, appended piece by piece, then moved into place. */
async function fileTarget(filePath: string, reveal: boolean): Promise<Target> {
  const partial = partialPath(filePath)
  const handle = await open(partial, 'w')
  let closed = false
  return {
    async write(_path, data) {
      await handle.write(data)
    },
    async mkdir() {
      throw new Error('A file download has no folders')
    },
    async close() {
      closed = true
      await handle.close()
      await rename(partial, filePath)
      if (reveal) shell.showItemInFolder(filePath)
    },
    async abort() {
      if (!closed) await handle.close().catch(ignore)
      await unlink(partial).catch(ignore)
    }
  }
}

/**
 * A tree of files inside `root`. Every path is resolved with `containedPath`, so one
 * that would leave `root` is refused (titles and folder names are free text). Each
 * file is moved into place once the next one starts, or the target closes.
 */
function directoryTarget(root: string): Target {
  const placed: string[] = []
  let current: { path: string; dest: string; partial: string; handle: FileHandle } | null = null
  const finishCurrent = async (): Promise<void> => {
    const c = current
    current = null
    if (!c) return
    await c.handle.close()
    await rename(c.partial, c.dest)
    placed.push(c.dest)
  }
  return {
    async write(path, data) {
      if (current?.path !== path) {
        await finishCurrent()
        const dest = containedPath(root, ...path.split('/'))
        mkdirSync(dirname(dest), { recursive: true })
        const partial = partialPath(dest)
        current = { path, dest, partial, handle: await open(partial, 'w') }
      }
      await current.handle.write(data)
    },
    async mkdir(path) {
      mkdirSync(containedPath(root, ...path.split('/')), { recursive: true })
    },
    close: finishCurrent,
    async abort() {
      const c = current
      current = null
      if (c) {
        await c.handle.close().catch(ignore)
        await unlink(c.partial).catch(ignore)
      }
      for (const f of placed) rmSync(f, { force: true })
    }
  }
}

/** One zip archive, each entry streamed in; zip64 is used when a size needs it. */
async function zipTarget(filePath: string, reveal: boolean): Promise<Target> {
  const partial = partialPath(filePath)
  const output: WriteStream = createWriteStream(partial)
  const archive = new ZipArchive({ zlib: { level: 9 } })
  let failure: Error | null = null
  const fail = (err: Error): void => {
    failure ??= err
  }
  archive.on('error', fail)
  archive.on('warning', fail)
  output.on('error', fail)
  archive.pipe(output)
  let current: { path: string; stream: PassThrough } | null = null
  const check = (): void => {
    if (failure) throw failure
  }
  const finishCurrent = (): void => {
    current?.stream.end()
    current = null
  }
  return {
    async write(path, data) {
      check()
      if (current?.path !== path) {
        finishCurrent()
        const stream = new PassThrough()
        archive.append(stream, { name: path, store: STORED.has(extname(path).toLowerCase()) })
        current = { path, stream }
      }
      if (!current.stream.write(data)) await once(current.stream, 'drain')
      check()
    },
    async mkdir(path) {
      check()
      finishCurrent()
      archive.append(Buffer.alloc(0), { name: `${path.replace(/\/+$/, '')}/` })
    },
    async close() {
      check()
      finishCurrent()
      const written = once(output, 'close')
      await archive.finalize()
      await written
      check()
      await rename(partial, filePath)
      if (reveal) shell.showItemInFolder(filePath)
    },
    async abort() {
      current?.stream.destroy()
      archive.abort()
      // The stream may still be opening the file: unlink only once it is closed, or
      // the late open would bring the file back.
      const closed = output.closed ? Promise.resolve() : once(output, 'close').then(ignore)
      output.destroy()
      await closed
      await unlink(partial).catch(ignore)
    }
  }
}

/** Open targets, each usable only by the window that opened it. */
export class SaveTargets {
  private readonly targets = new Map<string, { owner: number; target: Target }>()

  private get(owner: number, id: unknown): Target {
    const entry = typeof id === 'string' ? this.targets.get(id) : undefined
    if (!entry || entry.owner !== owner) throw new Error('Unknown save target')
    return entry.target
  }

  async open(
    owner: number,
    parent: BrowserWindow | null,
    raw: unknown
  ): Promise<SaveTargetOpenResult> {
    const req = parseSaveTargetRequest(raw)
    if (!req) return { ok: false, error: 'Invalid save request' }
    let target: Target
    if (req.kind === 'directory') {
      const options: Electron.OpenDialogOptions = {
        title: req.title,
        properties: ['openDirectory', 'createDirectory']
      }
      const picked = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true }
      target = directoryTarget(picked.filePaths[0])
    } else {
      const ext = extname(req.fileName).slice(1)
      const options: Electron.SaveDialogOptions = {
        title: req.title,
        defaultPath: join(app.getPath('downloads'), req.fileName),
        ...(ext ? { filters: [{ name: ext.toUpperCase(), extensions: [ext] }] } : {})
      }
      const picked = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options)
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
      target =
        req.kind === 'zip'
          ? await zipTarget(picked.filePath, req.reveal === true)
          : await fileTarget(picked.filePath, req.reveal === true)
    }
    const targetId = randomUUID()
    this.targets.set(targetId, { owner, target })
    return { ok: true, targetId }
  }

  async write(owner: number, id: unknown, path: unknown, data: unknown): Promise<void> {
    if (typeof path !== 'string' || !(data instanceof Uint8Array))
      throw new Error('Invalid save write')
    await this.get(owner, id).write(path, data)
  }

  async mkdir(owner: number, id: unknown, path: unknown): Promise<void> {
    if (typeof path !== 'string') throw new Error('Invalid save folder')
    await this.get(owner, id).mkdir(path)
  }

  async close(owner: number, id: unknown): Promise<HostSaveResult> {
    const target = this.get(owner, id)
    this.targets.delete(id as string)
    return target.close().then(
      () => ({ ok: true }) as const,
      async (err: unknown) => {
        await target.abort().catch(ignore)
        return { ok: false, error: err instanceof Error ? err.message : String(err) } as const
      }
    )
  }

  async abort(owner: number, id: unknown): Promise<void> {
    const entry = typeof id === 'string' ? this.targets.get(id) : undefined
    if (!entry || entry.owner !== owner) return
    this.targets.delete(id as string)
    await entry.target.abort()
  }

  /** A window went away: abort what it left open. */
  async dropOwner(owner: number): Promise<void> {
    for (const [id, entry] of this.targets)
      if (entry.owner === owner) {
        this.targets.delete(id)
        await entry.target.abort().catch(ignore)
      }
  }
}
