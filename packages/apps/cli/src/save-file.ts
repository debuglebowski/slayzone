/**
 * How `slay tasks artifacts download` puts a file on disk. Two cases:
 *
 *  - {@link saveNew} (no `--output`): the name comes from an artifact title — free
 *    text — so it may already be taken in the cwd, by a file the person cares about
 *    or a symlink to one. Nothing there is ever replaced or written through: the
 *    download is numbered `name (2).ext`, `name (3).ext`, … as file managers do
 *    (`numberedName`, the shared planner desktop and web use too).
 *  - {@link saveReplacing} (`--output <path>`): the person chose the path, so what is
 *    there is replaced, as before — but whole: never left cut by a failed download.
 *
 * Both write into a temp file beside the final name first (same directory, so the
 * final step is a link / rename, not a copy across filesystems) and only then place
 * it. A failed or interrupted download (dropped stream, Ctrl-C) removes the temp file
 * and leaves the destination as it was.
 *
 * The no-clobber placement is `link(temp, name)`: it fails with EEXIST for anything
 * already at `name` — a file, a directory, a symlink (dangling or not, never
 * followed) — and between checking and creating there is no window. Where the
 * filesystem has no hard links (FAT/exFAT, some network shares) the name is created
 * with `O_CREAT | O_EXCL` instead (same guarantees) and the bytes copied in; until
 * the copy is complete an interrupted `slay` removes that file again.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { numberedName } from '@slayzone/task-artifacts/download-plan'
import { onExitOrSignal } from './export/signal-cleanup'

/** Writes the whole download into `out` (resolves once everything is written). */
export type WriteBody = (out: Writable) => Promise<void>

/** Numbers tried before giving up (`name (2)` … `name (10000)`). */
const MAX_NUMBER = 10_000

/** A complete download in a temp file next to its destination. */
interface TempFile {
  path: string
  /** Remove the temp file (if still there) and drop its exit/signal hook. */
  discard(): void
}

/** An empty temp file in `dir`, created exclusively (it never opens something already there). */
function openTemp(dir: string): TempFile & { fd: number } {
  const tmp = path.join(dir, `.slay-download-${randomBytes(6).toString('hex')}.part`)
  const fd = fs.openSync(tmp, 'wx', 0o666)
  const remove = (): void => fs.rmSync(tmp, { force: true })
  // A Ctrl-C'd or killed `slay` leaves no temp file behind.
  const unhook = onExitOrSignal(remove)
  return {
    path: tmp,
    fd,
    discard: () => {
      unhook()
      remove()
    }
  }
}

/** Write `write`'s bytes into the opened temp file. On any failure it is removed. */
async function writeTemp(
  { path: tmp, fd, discard }: TempFile & { fd: number },
  write: WriteBody
): Promise<TempFile> {
  const out = fs.createWriteStream(tmp, { fd })
  const closed = new Promise<void>((resolve) => out.once('close', () => resolve()))
  try {
    await write(out)
    if (!out.writableEnded) out.end()
    // Rejects on a write error the writer did not see (e.g. a failed flush).
    await finished(out)
    await closed
  } catch (err) {
    out.destroy()
    await closed
    discard()
    throw err
  }
  return { path: tmp, discard }
}

/**
 * Put `tmp`'s bytes at `dest` only if nothing is there. True when placed, false when
 * `dest` is taken; anything else throws.
 */
async function placeExclusive(tmp: string, dest: string): Promise<boolean> {
  try {
    fs.linkSync(tmp, dest)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    // No hard links here (EPERM / ENOTSUP / ENOSYS / EMLINK …): copy instead.
  }
  let fd: number
  try {
    fd = fs.openSync(dest, 'wx', 0o666)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  // Which file we created: removed on failure only if it is still that one, never
  // whatever has taken its name since.
  const { dev, ino } = fs.fstatSync(fd)
  const removeOurs = (): void => {
    try {
      const now = fs.lstatSync(dest)
      if (now.dev === dev && now.ino === ino) fs.rmSync(dest, { force: true })
    } catch {
      // Already gone.
    }
  }
  // Until the copy is complete `dest` is cut short: a Ctrl-C'd or killed `slay` takes
  // it away too, so the download lands whole or not at all.
  const unhook = onExitOrSignal(removeOurs)
  try {
    await pipeline(fs.createReadStream(tmp), fs.createWriteStream(dest, { fd }))
  } catch (err) {
    removeOurs()
    throw err
  } finally {
    unhook()
  }
  return true
}

/**
 * Save as `name` in `dir`, or the first free `name (N).ext` when it is taken. Never
 * replaces, truncates or writes through anything already there. Returns the path the
 * download landed at.
 */
export async function saveNew(dir: string, name: string, write: WriteBody): Promise<string> {
  fs.mkdirSync(dir, { recursive: true })
  const tmp = await writeTemp(openTemp(dir), write)
  try {
    for (let n = 1; n <= MAX_NUMBER; n++) {
      const dest = path.join(dir, n === 1 ? name : numberedName(name, n))
      if (await placeExclusive(tmp.path, dest)) return dest
    }
    throw new Error(`No free file name for ${name} in ${dir}`)
  } finally {
    tmp.discard()
  }
}

/** The old way: open `target` (following a symlink) and write straight into it. */
async function writeInPlace(target: string, write: WriteBody): Promise<void> {
  const out = fs.createWriteStream(target)
  const closed = new Promise<void>((resolve) => out.once('close', () => resolve()))
  try {
    await write(out)
    if (!out.writableEnded) out.end()
    await finished(out)
    await closed
  } catch (err) {
    out.destroy()
    await closed
    throw err
  }
}

/**
 * Write into `stream` (our stdout / stderr) as it stands. Its descriptor is the one the
 * shell set up, so a `>> file` keeps appending, a `> file` is not truncated again, and
 * what `slay` prints next (the saved path) follows the bytes instead of overwriting
 * them — reopening `/dev/stdout` would give none of that on Linux, where it opens the
 * file anew. Left open afterwards: it is not ours to close.
 */
async function writeToStdio(stream: NodeJS.WriteStream, write: WriteBody): Promise<void> {
  const sink = new Writable({
    write(chunk, _encoding, done) {
      stream.write(chunk, (err) => done(err ?? null))
    },
    final(done) {
      done()
    }
  })
  // A write error is reported to the callback above; the 'error' event must not crash.
  const onError = (err: Error): void => {
    sink.destroy(err)
  }
  stream.on('error', onError)
  try {
    await write(sink)
    if (!sink.writableEnded) sink.end()
    await finished(sink)
  } finally {
    stream.off('error', onError)
  }
}

/** The descriptor of ours a path names (`/dev/stdout`, `/dev/fd/1`, `/proc/self/fd/1`, …). */
function ownDescriptor(p: string): number | null {
  if (p === '/dev/stdout') return 1
  if (p === '/dev/stderr') return 2
  const dev = /^\/dev\/fd\/(\d+)$/.exec(p)
  if (dev) return Number(dev[1])
  const proc = /^\/proc\/(self|thread-self|\d+)\/fd\/(\d+)$/.exec(p)
  if (proc && (!/^\d+$/.test(proc[1]) || Number(proc[1]) === process.pid)) return Number(proc[2])
  return null
}

/** Our stdout / stderr when `p` names it. */
function stdioStream(p: string): NodeJS.WriteStream | null {
  if (process.platform === 'win32') return null
  const fd = ownDescriptor(p)
  return fd === 1 ? process.stdout : fd === 2 ? process.stderr : null
}

/** `p`, then each path its symlinks lead to in turn (the last one is no symlink). */
function linkChain(p: string): string[] {
  const chain = [p]
  // The kernel's own bound on a symlink chain.
  for (let hop = p; chain.length <= 40; ) {
    let next: string
    try {
      next = fs.readlinkSync(hop)
    } catch {
      break
    }
    hop = path.resolve(path.dirname(hop), next)
    chain.push(hop)
  }
  return chain
}

/**
 * A device or kernel file (`/dev/…`, `/proc/…`): written in place. There is no
 * directory there to put a temp file in, and replacing the name would not reach what
 * it stands for.
 */
const isSystemPath = (p: string): boolean =>
  process.platform !== 'win32' && /^\/(dev|proc)\//.test(p)

/**
 * The temp file could not be created beside the target: its directory is not ours to
 * write, or is no real directory (`/dev/fd`). Written in place instead.
 */
const NO_TEMP_HERE = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR'])

/**
 * Save at `target`, replacing what is there (the person named the path). The new
 * bytes go to a temp file first and are renamed over the target once complete, so a
 * failed download leaves the old file as it was. As before, a symlink at `target` is
 * followed (its target is replaced; the link stays) and an existing file keeps its
 * permission bits. Where a rename cannot stand in for writing into the file, it is
 * written in place as before: our own stdout / stderr (into the open descriptor), a
 * device, pipe or anything else under `/dev` or `/proc`, a file with other hard links
 * (they must see the new bytes), a dangling symlink, or a directory that does not let
 * us create the temp file.
 */
export async function saveReplacing(target: string, write: WriteBody): Promise<string> {
  // The path itself or a symlink it leads through (`out` → `/dev/stdout` → on Linux
  // `/proc/self/fd/1` → the redirect's file: the hop matters, not where it ends).
  for (const hop of linkChain(target)) {
    const stdio = stdioStream(hop)
    if (stdio) {
      await writeToStdio(stdio, write)
      return target
    }
    if (isSystemPath(hop)) {
      await writeInPlace(target, write)
      return target
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  let real: string
  let existing: fs.Stats | null = null
  try {
    real = fs.realpathSync(target)
    existing = fs.statSync(real)
  } catch {
    // Nothing there — or a dangling symlink, which writing creates the target of.
    let link = false
    try {
      link = fs.lstatSync(target).isSymbolicLink()
    } catch {
      // Nothing there.
    }
    if (link) {
      await writeInPlace(target, write)
      return target
    }
    real = target
  }
  // Reached through a directory symlink (realpath resolves those too).
  if (isSystemPath(real) || (existing && (!existing.isFile() || existing.nlink > 1))) {
    await writeInPlace(target, write)
    return target
  }

  let opened: ReturnType<typeof openTemp>
  try {
    opened = openTemp(path.dirname(real))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code && NO_TEMP_HERE.has(code)) {
      await writeInPlace(target, write)
      return target
    }
    throw err
  }
  const tmp = await writeTemp(opened, write)
  try {
    if (existing) fs.chmodSync(tmp.path, existing.mode & 0o7777)
    fs.renameSync(tmp.path, real)
  } finally {
    tmp.discard()
  }
  return target
}
