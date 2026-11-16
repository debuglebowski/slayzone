// Saving a download onto THIS machine — artifact file, folder and zip downloads. The
// hub only serves the bytes, in bounded pieces (`artifacts.readBytesChunk`); the
// renderer streams them here and main writes them, so a download lands on the
// person's own disk whether the hub is local or remote, and no size has to fit in
// memory. A zip is compressed by archiver on zlib's thread pool: off the UI and off
// main's event loop. Reached over `app:save-target-*`.
import {
  constants as fsConstants,
  createWriteStream,
  lstatSync,
  mkdirSync,
  rmdirSync,
  unlinkSync
} from 'fs'
import { access, link, lstat, open, rename, unlink, type FileHandle } from 'fs/promises'
import { randomUUID } from 'crypto'
import { basename, dirname, extname, join } from 'path'
import { PassThrough, type Writable } from 'stream'
import { once } from 'events'
import { BrowserWindow, app, dialog, shell } from 'electron'
import { ZipArchive } from 'archiver'
import { containedPath } from '@slayzone/platform/safe-path'
import { numberedName } from '@slayzone/task-artifacts/download-plan'
import { type EntryWidth, entryWidth, writeZip64Entries } from './zip64-entries'
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
  /** `size`: the entry's total bytes when known (only a zip needs it, see zip64). */
  write(path: string, data: Uint8Array, size?: number): Promise<void>
  mkdir(path: string): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
  /** The app is quitting: remove what is on disk now, synchronously, best effort. */
  abortNow(): void
  /**
   * Make whatever operation is in flight settle at once (destroy streams it waits on),
   * so an abort is never held up by an operation that would otherwise never finish.
   */
  interrupt(): void
}

const unlinkNow = (p: string): void => {
  try {
    unlinkSync(p)
  } catch {
    // Already gone, or held open on Windows: nothing more to do while quitting.
  }
}

/**
 * Paths a target has started, case-folded (APFS and NTFS are case-blind): a repeated
 * one is refused rather than continued, so two artifacts never merge into one file
 * or zip entry (the planner makes paths unique; this is the host's own guard).
 */
function newPathGuard(): (path: string) => void {
  const started = new Set<string>()
  return (path) => {
    const key = path.normalize('NFC').toLowerCase()
    if (started.has(key)) throw new Error(`${path} was already written in this download`)
    started.add(key)
  }
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
  // Short and fixed-length, whatever the final name: a name at the 255-byte limit
  // must not fail because its partial's name would be longer.
  return join(dirname(dest), `.slz-${randomUUID().slice(0, 13)}.partial`)
}

/** One file, appended piece by piece, then moved into place. */
async function fileTarget(filePath: string, reveal: boolean): Promise<Target> {
  const partial = partialPath(filePath)
  const handle = await open(partial, 'w')
  let closed = false
  return {
    async write(_path, data) {
      await writeAll(handle, data)
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
    },
    abortNow() {
      // The close starts now (no handle is left for garbage collection); the unlink
      // can't wait for it. Unlinked again once closed, for Windows, where an open file
      // can't be removed.
      if (!closed) {
        closed = true
        handle.close().then(() => unlinkNow(partial), ignore)
      }
      unlinkNow(partial)
    },
    interrupt() {
      // Plain fs operations: they settle by themselves.
    }
  }
}

/**
 * Commit a finished partial at `dest` WITHOUT replacing anything there: a hard link
 * fails if the name exists, so an existing file is never overwritten — the next free
 * `name (n).ext` is used instead. A filesystem without hard links (FAT, some network
 * shares) gets an exclusive copy, equally unable to clobber. Returns the path used.
 */
/**
 * A path this download created, with the identity it had: cleanup removes a path only
 * while it is still that same file. A name that was the person's own (or that they
 * replaced since) has another identity and is never touched.
 */
interface Created {
  path: string
  dev: bigint
  ino: bigint
}

/** Remove `c` only if the path still holds the file this download made. */
function removeIfOursNow(c: Created): void {
  try {
    const st = lstatSync(c.path, { bigint: true })
    if (st.dev === c.dev && st.ino === c.ino) unlinkSync(c.path)
  } catch {
    // Gone already.
  }
}

/**
 * Commit a finished partial (created by this download) at `dest` without replacing
 * anything there, taking `name (n).ext` when the name is taken.
 *  - A hard link shares the partial's identity, so the candidate is recorded with that
 *    identity BEFORE the link: whenever the commit is cut short, cleanup removes the
 *    name only if the link did create it — never the person's own file there.
 *  - Any link error but EEXIST (no hard links: FAT/exFAT gives EPERM/EISDIR/ENOTSUP,
 *    SMB, another volume) falls back to an exclusive create (`wx`: an existing name is
 *    never opened) and a copy into it, recorded once the file exists.
 * `track` receives each candidate while it is in play; the committed one is returned.
 */
async function commitNoClobber(
  partial: Created,
  dest: string,
  fsOps: CommitFs,
  track: (candidate: Created | null) => void
): Promise<Created> {
  const dir = dirname(dest)
  const name = basename(dest)
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? dest : join(dir, numberedName(name, n))
    const linked: Created = { path: candidate, dev: partial.dev, ino: partial.ino }
    track(linked)
    const linkErr = await fsOps.link(partial.path, candidate).then(
      () => null,
      (err: unknown) => err as NodeJS.ErrnoException
    )
    if (!linkErr) {
      await unlink(partial.path).catch(ignore)
      return linked
    }
    track(null)
    if (linkErr.code === 'EEXIST') continue
    const handle = await open(candidate, 'wx').catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw err
    })
    if (!handle) continue
    const st = await handle.stat({ bigint: true })
    const copy: Created = { path: candidate, dev: st.dev, ino: st.ino }
    track(copy)
    await fsOps
      .copyTo(partial.path, handle)
      .finally(() => handle.close())
      .catch((err: unknown) => {
        removeIfOursNow(copy)
        throw err
      })
    await unlink(partial.path).catch(ignore)
    return copy
  }
}

/** Copy `src` into an open file, in pieces. */
/**
 * Write every byte of `data`: one write(2) may write fewer than asked (a nearly full
 * disk, some network filesystems), and `FileHandle.write` does not retry. A write that
 * makes no progress at all is an error, never a short file reported saved.
 */
async function writeAll(handle: FileHandle, data: Uint8Array): Promise<void> {
  let off = 0
  while (off < data.byteLength) {
    const { bytesWritten } = await handle.write(data, off, data.byteLength - off)
    if (bytesWritten <= 0) throw new Error('The disk accepted no more bytes')
    off += bytesWritten
  }
}

/**
 * Write `data` to `dest` whole or not at all: into a hidden partial beside it, then
 * renamed over it. A failure (a full disk) leaves whatever was at `dest` untouched and
 * removes the partial. For a file the person picked in a save dialog (an export),
 * where replacing is what they asked for.
 *
 * Only a plain file of ours (or nothing) is replaced that way. Anything else is written
 * in place, as main did, so the OS keeps deciding: a file we may not write refuses
 * (EACCES), a symlink's target and a hard link's shared file get the bytes, and a file
 * someone else owns keeps its owner.
 */
export async function writeFileWhole(
  dest: string,
  data: Uint8Array,
  ops: { write: (handle: FileHandle, data: Uint8Array) => Promise<void> } = { write: writeAll }
): Promise<void> {
  const existing = await lstat(dest).catch(() => null)
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  const replaceable =
    !existing ||
    (existing.isFile() &&
      existing.nlink === 1 &&
      (uid === null || existing.uid === uid) &&
      (await access(dest, fsConstants.W_OK).then(
        () => true,
        () => false
      )))
  if (!replaceable) {
    const handle = await open(dest, 'w')
    try {
      await ops.write(handle, data)
    } finally {
      await handle.close()
    }
    return
  }
  const partial = partialPath(dest)
  const handle = await open(partial, 'wx')
  try {
    await ops.write(handle, data)
    await handle.close()
    await rename(partial, dest)
  } catch (err) {
    await handle.close().catch(ignore)
    await unlink(partial).catch(ignore)
    throw err
  }
}

export async function copyInto(src: string, dest: FileHandle): Promise<void> {
  const from = await open(src, 'r')
  const buf = Buffer.alloc(4 * 1024 * 1024)
  const pump = async (): Promise<void> => {
    for (;;) {
      const { bytesRead } = await from.read(buf, 0, buf.length, null)
      if (bytesRead === 0) return
      await writeAll(dest, buf.subarray(0, bytesRead))
    }
  }
  await pump().finally(() => from.close())
}

/** Create `dir` (and parents); returns the folders this call created, outermost first. */
function mkdirTracked(dir: string): string[] {
  const first = mkdirSync(dir, { recursive: true })
  if (!first) return []
  const created: string[] = []
  for (let d = dir; d.length >= first.length; d = dirname(d)) {
    created.unshift(d)
    if (d === first) break
  }
  return created
}

/**
 * A tree of files inside `root`. Every path is resolved with `containedPath`, so one
 * that would leave `root` is refused (titles and folder names are free text). Each
 * file is committed once the next one starts, or the target closes — never over a
 * file that is already there (see `commitNoClobber`). Abort removes exactly what this
 * download created: its files and the folders it made, never anything that existed.
 */
function directoryTarget(root: string, fsOps: CommitFs): Target {
  /** Committed files of this download, by identity. Cleared once it finished. */
  const placed: Created[] = []
  const madeDirs: string[] = []
  const startPath = newPathGuard()
  let current: { path: string; dest: string; partial: Created; handle: FileHandle } | null = null
  /**
   * The file being committed: its partial and the candidate name in play, tracked until
   * the commit has settled, so a failed commit or an abort/quit mid-commit removes
   * exactly what this download made — by identity, never a pre-existing file.
   */
  let committing: { partial: Created; candidate: Created | null } | null = null
  /** Aborted: an operation still in flight undoes what it creates and fails. */
  let dead = false
  /** Closed successfully: nothing of it is ever removed again. */
  let finished = false
  let aborting: Promise<void> | null = null
  const cancelled = (): Error => new Error('The download was cancelled')

  const commitCurrent = async (): Promise<void> => {
    const c = current
    if (!c) return
    const commit = { partial: c.partial, candidate: null as Created | null }
    committing = commit
    current = null
    const committed = await c.handle
      .close()
      .then(() =>
        commitNoClobber(c.partial, c.dest, fsOps, (candidate) => {
          commit.candidate = candidate
        })
      )
      .catch((err: unknown) => {
        // A failed commit leaves nothing of this download (each removed only if it is
        // still ours): not the partial, not a half-copied name.
        removeIfOursNow(commit.partial)
        if (commit.candidate) removeIfOursNow(commit.candidate)
        if (committing === commit) committing = null
        throw err
      })
    if (committing === commit) committing = null
    if (dead) {
      // Aborted while committing: this file belongs to a download that failed.
      removeIfOursNow(committed)
      throw cancelled()
    }
    placed.push(committed)
  }
  const removeCreated = (): void => {
    if (finished) return
    for (const f of placed) removeIfOursNow(f)
    placed.length = 0
    // Deepest first; only folders this download made, and only while empty.
    for (const d of [...madeDirs].reverse()) {
      try {
        rmdirSync(d)
      } catch {
        // Not empty (something else is in it) or already gone: leave it.
      }
    }
    madeDirs.length = 0
  }
  const dropCommitting = (): void => {
    const c = committing
    committing = null
    if (!c) return
    removeIfOursNow(c.partial)
    if (c.candidate) removeIfOursNow(c.candidate)
  }
  return {
    async write(path, data) {
      if (dead) throw cancelled()
      if (current?.path !== path) {
        startPath(path)
        await commitCurrent()
        if (dead) throw cancelled()
        const dest = containedPath(root, ...path.split('/'))
        madeDirs.push(...mkdirTracked(dirname(dest)))
        const partialName = partialPath(dest)
        const handle = await open(partialName, 'wx')
        const st = await handle.stat({ bigint: true })
        const partial: Created = { path: partialName, dev: st.dev, ino: st.ino }
        if (dead) {
          await handle.close().catch(ignore)
          removeIfOursNow(partial)
          throw cancelled()
        }
        current = { path, dest, partial, handle }
      }
      await writeAll(current.handle, data)
    },
    async mkdir(path) {
      if (dead) throw cancelled()
      madeDirs.push(...mkdirTracked(containedPath(root, ...path.split('/'))))
    },
    async close() {
      await commitCurrent()
      // Finished: every file is the person's now.
      finished = true
      placed.length = 0
      madeDirs.length = 0
    },
    // Single-flight: two aborts at once (a failed close and a window going away) must
    // not interleave, or one clears the folder list while the other still holds a file.
    abort() {
      aborting ??= (async () => {
        dead = true
        const c = current
        current = null
        if (c) {
          await c.handle.close().catch(ignore)
          removeIfOursNow(c.partial)
        }
        dropCommitting()
        removeCreated()
      })()
      return aborting
    },
    abortNow() {
      dead = true
      const c = current
      current = null
      if (c) {
        // As the file target: start the close, remove now, and again once closed.
        c.handle.close().then(() => removeIfOursNow(c.partial), ignore)
        removeIfOursNow(c.partial)
      }
      dropCommitting()
      removeCreated()
    },
    interrupt() {
      // Plain fs operations: they settle by themselves.
    }
  }
}

/** One zip archive, each entry streamed in; zip64 is used when a size needs it. */
async function zipTarget(
  filePath: string,
  reveal: boolean,
  openOutput: (path: string) => Writable
): Promise<Target> {
  const partial = partialPath(filePath)
  const output = openOutput(partial)
  const archive = new ZipArchive({ zlib: { level: 9 } })
  /** Each entry's width, from the size the client declared with its first piece. */
  const widths = new Map<string, EntryWidth>()
  writeZip64Entries(archive, (name) => widths.get(name) ?? 'unknown')
  let failure: Error | null = null
  let rejectFailed: (err: Error) => void = ignore
  /** Rejects once the zip has failed: every wait races it, so none hangs. */
  const failed = new Promise<never>((_, reject) => {
    rejectFailed = reject
  })
  failed.catch(ignore)
  let current: { path: string; stream: PassThrough } | null = null
  // A failed output unpipes the archive, so a deflating entry would never drain
  // again: the failure ends the entry stream and every wait at once.
  const fail = (err: Error): void => {
    if (failure) return
    failure = err
    rejectFailed(err)
    current?.stream.destroy()
  }
  const settle = <T>(p: Promise<T>): Promise<T> => Promise.race([p, failed])
  archive.on('error', fail)
  archive.on('warning', fail)
  output.on('error', fail)
  archive.pipe(output)
  const startPath = newPathGuard()
  const check = (): void => {
    if (failure) throw failure
  }
  const finishCurrent = (): void => {
    current?.stream.end()
    current = null
  }
  return {
    async write(path, data, size) {
      check()
      if (current?.path !== path) {
        startPath(path)
        finishCurrent()
        const stream = new PassThrough()
        const store = STORED.has(extname(path).toLowerCase())
        widths.set(path, entryWidth(size, store))
        archive.append(stream, { name: path, store })
        current = { path, stream }
      }
      if (!current.stream.write(data)) await settle(once(current.stream, 'drain'))
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
      // A failure while finalizing rejects both; the caller learns it through `failed`.
      written.catch(ignore)
      await settle(archive.finalize())
      await settle(written)
      check()
      await rename(partial, filePath)
      if (reveal) shell.showItemInFolder(filePath)
    },
    async abort() {
      fail(new Error('The download was cancelled'))
      archive.abort()
      // The stream may still be opening the file: unlink only once it is closed, or
      // the late open would bring the file back.
      const closed = output.closed ? Promise.resolve() : once(output, 'close').then(ignore)
      output.destroy()
      await closed
      await unlink(partial).catch(ignore)
    },
    abortNow() {
      fail(new Error('The download was cancelled'))
      archive.abort()
      // A file still being opened would reappear after the unlink: unlink again once
      // the output has closed (in case the process lives that long).
      if (!output.closed) output.once('close', () => unlinkNow(partial))
      output.destroy()
      unlinkNow(partial)
    },
    interrupt() {
      fail(new Error('The download was cancelled'))
    }
  }
}

/** Open targets, each usable only by the window that opened it. */
interface Entry {
  owner: number
  target: Target
  /** The operation in flight: each runs after the previous one settles. */
  chain: Promise<unknown>
  /** Closing or aborting: no new operations; still tracked until it has settled. */
  ending: boolean
  aborted: boolean
}

/** How long an abort waits for an interrupted operation before cleaning up anyway. */
const ABORT_WAIT_MS = 5_000

/** How a folder download commits its files; a test injects failing ones. */
export interface CommitFs {
  link: (existing: string, path: string) => Promise<void>
  /** Copy a file's bytes into a file this download just created exclusively. */
  copyTo: (src: string, dest: FileHandle) => Promise<void>
}

export interface SaveTargetsOptions {
  /** Where a zip's bytes go; a test injects a failing disk here. */
  openZipOutput?: (path: string) => Writable
  commitFs?: CommitFs
}

/** Every SaveTargets of this process, for a forced exit (see abortAllSaveTargetsNow). */
const everyTargets = new Set<SaveTargets>()

/**
 * Remove every open download's partial now, synchronously. For an exit that skips
 * `will-quit` (`app.exit`: the quit watchdog, a relaunch).
 */
export function abortAllSaveTargetsNow(): void {
  for (const t of everyTargets) t.abortAllNow()
}

export class SaveTargets {
  /**
   * Every target until it has fully settled — open, closing or aborting — so a quit
   * (`abortAllNow`) still reaches one whose close or abort is still running.
   */
  private readonly targets = new Map<string, Entry>()
  private readonly openZipOutput: (path: string) => Writable
  private readonly commitFs: CommitFs

  constructor(options: SaveTargetsOptions = {}) {
    everyTargets.add(this)
    this.openZipOutput = options.openZipOutput ?? ((p) => createWriteStream(p))
    this.commitFs = options.commitFs ?? { link, copyTo: copyInto }
  }

  private entry(owner: number, id: unknown): Entry {
    const entry = typeof id === 'string' ? this.targets.get(id) : undefined
    if (!entry || entry.owner !== owner || entry.ending) throw new Error('Unknown save target')
    return entry
  }

  /**
   * Run one operation on a target after the one before it: a write still opening its
   * file is never overtaken by an abort, which would leave that file behind.
   */
  private run<T>(entry: Entry, op: (target: Target) => Promise<T>): Promise<T> {
    const result = entry.chain.then(() => {
      if (entry.aborted) throw new Error('The download was cancelled')
      return op(entry.target)
    })
    entry.chain = result.catch(ignore)
    return result
  }

  /**
   * Abort after whatever is in flight — interrupted first, so it settles instead of
   * hanging, and waited on for a bounded time; nothing queued after this runs. The
   * entry stays tracked until its cleanup is done.
   */
  private async abortEntry(id: string, entry: Entry): Promise<void> {
    if (entry.aborted) return
    entry.aborted = true
    entry.ending = true
    entry.target.interrupt()
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      entry.chain,
      new Promise((resolve) => {
        timer = setTimeout(resolve, ABORT_WAIT_MS)
      })
    ])
    clearTimeout(timer)
    await entry.target.abort().catch(ignore)
    this.targets.delete(id)
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
      target = directoryTarget(picked.filePaths[0], this.commitFs)
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
          ? await zipTarget(picked.filePath, req.reveal === true, this.openZipOutput)
          : await fileTarget(picked.filePath, req.reveal === true)
    }
    const targetId = randomUUID()
    this.targets.set(targetId, {
      owner,
      target,
      chain: Promise.resolve(),
      ending: false,
      aborted: false
    })
    return { ok: true, targetId }
  }

  async write(
    owner: number,
    id: unknown,
    path: unknown,
    data: unknown,
    size?: unknown
  ): Promise<void> {
    if (typeof path !== 'string' || !(data instanceof Uint8Array))
      throw new Error('Invalid save write')
    if (size !== undefined && (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0))
      throw new Error('Invalid save write size')
    await this.run(this.entry(owner, id), (t) => t.write(path, data, size as number | undefined))
  }

  async mkdir(owner: number, id: unknown, path: unknown): Promise<void> {
    if (typeof path !== 'string') throw new Error('Invalid save folder')
    await this.run(this.entry(owner, id), (t) => t.mkdir(path))
  }

  async close(owner: number, id: unknown): Promise<HostSaveResult> {
    const entry = this.entry(owner, id)
    const closed = this.run(entry, (t) => t.close())
    entry.ending = true
    return closed
      .then(
        () => ({ ok: true }) as const,
        async (err: unknown) => {
          entry.aborted = true
          await entry.target.abort().catch(ignore)
          return { ok: false, error: err instanceof Error ? err.message : String(err) } as const
        }
      )
      .finally(() => this.targets.delete(id as string))
  }

  async abort(owner: number, id: unknown): Promise<void> {
    const entry = typeof id === 'string' ? this.targets.get(id) : undefined
    if (!entry || entry.owner !== owner) return
    await this.abortEntry(id as string, entry)
  }

  /** A window went away (closed, crashed, reloaded, navigated): abort what it left open. */
  async dropOwner(owner: number): Promise<void> {
    const mine = [...this.targets].filter(([, e]) => e.owner === owner)
    await Promise.all(mine.map(([id, e]) => this.abortEntry(id, e)))
  }

  /**
   * The app is quitting: remove every partial now, synchronously — open targets and
   * those still closing or aborting alike.
   */
  abortAllNow(): void {
    for (const [id, entry] of this.targets) {
      entry.aborted = true
      entry.ending = true
      this.targets.delete(id)
      entry.target.abortNow()
    }
  }
}

/** The part of a webContents a save target's owner is watched through. */
export interface SaveTargetOwner {
  readonly id: number
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

const watchedOwners = new WeakSet<object>()

/**
 * Abort a window's open targets when its page goes away. A crash or a reload keeps
 * the same webContents ('destroyed' never fires), so those count too: a renderer
 * crash, and a main-frame navigation to a new document. Watched once per webContents.
 */
export function watchSaveTargetOwner(sender: SaveTargetOwner, targets: SaveTargets): void {
  if (watchedOwners.has(sender)) return
  watchedOwners.add(sender)
  const id = sender.id
  const drop = (): void => void targets.dropOwner(id)
  sender.on('destroyed', drop)
  sender.on('render-process-gone', drop)
  sender.on('did-start-navigation', (...args: unknown[]) => {
    const details = args[0] as { isMainFrame?: boolean; isSameDocument?: boolean } | undefined
    if (details?.isMainFrame && !details.isSameDocument) drop()
  })
}
