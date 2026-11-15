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
 * with `O_CREAT | O_EXCL` instead (same guarantees) and the bytes copied in.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { finished, pipeline } from 'node:stream/promises'
import { numberedName } from '@slayzone/task-artifacts/download-plan'
import { onExitOrSignal } from './export/signal-cleanup'

/** Writes the whole download into `out` (resolves once everything is written). */
export type WriteBody = (out: fs.WriteStream) => Promise<void>

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
  // Which file we created: removed on failure only if it is still that one.
  const { dev, ino } = fs.fstatSync(fd)
  try {
    await pipeline(fs.createReadStream(tmp), fs.createWriteStream(dest, { fd }))
  } catch (err) {
    try {
      const now = fs.lstatSync(dest)
      if (now.dev === dev && now.ino === ino) fs.rmSync(dest, { force: true })
    } catch {
      // Already gone.
    }
    throw err
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

/** The temp file could not be created beside the target: its directory is not ours to write. */
const NO_TEMP_HERE = new Set(['EACCES', 'EPERM', 'EROFS'])

/**
 * Save at `target`, replacing what is there (the person named the path). The new
 * bytes go to a temp file first and are renamed over the target once complete, so a
 * failed download leaves the old file as it was. As before, a symlink at `target` is
 * followed (its target is replaced; the link stays) and an existing file keeps its
 * permission bits. Where a rename cannot stand in for writing into the file, it is
 * written in place as before: a device or pipe (`/dev/stdout`), a file with other
 * hard links (they must see the new bytes), a dangling symlink, or a directory that
 * does not let us create the temp file.
 */
export async function saveReplacing(target: string, write: WriteBody): Promise<string> {
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
  if (existing && (!existing.isFile() || existing.nlink > 1)) {
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
