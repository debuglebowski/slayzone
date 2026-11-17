/**
 * Paged reads of one large git text (a file's diff, an untracked file, a stash):
 * `readGitText` runs git ONCE, spooling its output to a temp file (never held in
 * memory), and answers it in pages of at most {@link DIFF_PAGE_BYTES}, each cut at a
 * line end (or, for one giant line, at a UTF-8 character boundary). Every page of
 * one read comes from that one run, so pages never mix two states of the tree.
 *
 * A spool is bound to the repo that made it, dropped when idle, after its last
 * page, or when the spools pass a disk bound (oldest first). A cursor to a spool
 * that is gone fails with {@link GIT_TEXT_EXPIRED}: the reader starts over.
 * Runs on the computer (the `git-ops` table); it spawns git, so hub-bundled code
 * never imports it.
 *
 * @module worktrees/server/git-text-spool
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { open, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GIT_TEXT_EXPIRED, type GitTextPage, type GitTextSource } from '../shared/git-text'
import { spoolCommand } from './exec-async'
import { DIFF_PAGE_BYTES, fileDiffCommand } from './git-worktree'

export { GIT_TEXT_EXPIRED }

interface Spool {
  file: string
  repoPath: string
  bytes: number
  usedAt: number
}

export interface GitTextSpoolOptions {
  now?: () => number
  /** Dropped when unused this long (default 5 min). */
  idleMs?: number
  /** Disk bound over all spools; the least recently used go first (default 1 GiB). */
  maxBytes?: number
}

const SPOOL_DIR_PREFIX = 'slayzone-git-text-'
/** A folder without its owner's pid (an older build) is left this long. */
const LEGACY_SPOOL_DIR_MS = 24 * 60 * 60_000

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, owned by someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Remove spool folders left in `root` by processes that are gone (killed by a
 * signal, so their exit handler never ran): `slayzone-git-text-<pid>-…` of a pid
 * that no longer runs, and an older build's pid-less folder after a day.
 */
export function sweepStaleGitTextDirs(root: string = tmpdir()): void {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    try {
      if (!name.startsWith(SPOOL_DIR_PREFIX)) continue
      const full = path.join(root, name)
      const pid = /^(\d+)-/.exec(name.slice(SPOOL_DIR_PREFIX.length))?.[1]
      const stale = pid
        ? Number(pid) !== process.pid && !processAlive(Number(pid))
        : Date.now() - statSync(full).mtimeMs > LEGACY_SPOOL_DIR_MS
      if (stale) rmSync(full, { recursive: true, force: true })
    } catch {
      /* another sweeper got it first, or it is not ours to remove */
    }
  }
}

let spoolDir: string | null = null
/** This process's spool folder, made on first use (sweeping exited processes'
 *  leftovers then) and removed when it exits. */
function dir(): string {
  if (!spoolDir) {
    sweepStaleGitTextDirs()
    const made = mkdtempSync(path.join(tmpdir(), `${SPOOL_DIR_PREFIX}${process.pid}-`))
    spoolDir = made
    process.once('exit', () => rmSync(made, { recursive: true, force: true }))
  }
  return spoolDir
}

export class GitTextSpool {
  private readonly spools = new Map<string, Spool>()
  private readonly now: () => number
  private readonly idleMs: number
  private readonly maxBytes: number
  /** Drops idle spools while any is held (unref'd: never keeps the process alive). */
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: GitTextSpoolOptions = {}) {
    this.now = opts.now ?? Date.now
    this.idleMs = opts.idleMs ?? 5 * 60_000
    this.maxBytes = opts.maxBytes ?? 1024 * 1024 * 1024
  }

  private arm(): void {
    if (this.timer || this.spools.size === 0) return
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.sweep()
        this.arm()
      },
      Math.max(1_000, this.idleMs / 2)
    )
    this.timer.unref?.()
  }

  /** Spools held. */
  get size(): number {
    return this.spools.size
  }

  private drop(id: string): void {
    const s = this.spools.get(id)
    if (!s) return
    this.spools.delete(id)
    void unlink(s.file).catch(() => {
      /* already gone */
    })
  }

  private sweep(): void {
    const cutoff = this.now() - this.idleMs
    for (const [id, s] of this.spools) if (s.usedAt < cutoff) this.drop(id)
  }

  /** Hold `file` (`bytes` long, made from `repoPath`); evicts the oldest over the disk bound. */
  hold(file: string, repoPath: string, bytes: number): string {
    this.sweep()
    const id = randomBytes(16).toString('hex')
    this.spools.set(id, { file, repoPath, bytes, usedAt: this.now() })
    let total = 0
    for (const s of this.spools.values()) total += s.bytes
    for (const [other, s] of [...this.spools].sort((a, b) => a[1].usedAt - b[1].usedAt)) {
      if (total <= this.maxBytes || other === id) break
      total -= s.bytes
      this.drop(other)
    }
    this.arm()
    return id
  }

  get(id: string, repoPath: string): Spool {
    this.sweep()
    const s = this.spools.get(id)
    if (!s || s.repoPath !== repoPath)
      throw new Error(`${GIT_TEXT_EXPIRED}: this diff's pages expired; read it again`)
    s.usedAt = this.now()
    return s
  }

  release(id: string): void {
    this.drop(id)
  }
}

/** This process's spools (the computer's, through the git-ops table). */
export const gitTextSpools = new GitTextSpool()

/** The command that writes `source`'s text. */
function commandOf(source: GitTextSource): { args: string[]; okExitCodes: number[] } {
  switch (source.kind) {
    case 'fileDiff':
      return fileDiffCommand({
        kind: source.staged ? 'staged' : 'unstaged',
        filePath: source.filePath,
        fromPath: source.fromPath,
        opts: source.opts
      })
    case 'rangeFileDiff':
      return fileDiffCommand({
        kind: 'range',
        filePath: source.filePath,
        fromPath: source.fromPath,
        opts: source.opts,
        fromSha: source.fromSha,
        toSha: source.toSha
      })
    case 'untrackedDiff':
      return fileDiffCommand({ kind: 'untracked', filePath: source.filePath })
    case 'stashDiff':
      return {
        args: ['stash', 'show', '-p', '--no-color', `stash@{${source.index}}`],
        okExitCodes: [0]
      }
  }
}

/** The page at `offset` of a `size`-byte spool: up to `maxBytes`, cut at a line end. */
async function pageAt(
  file: string,
  size: number,
  offset: number,
  maxBytes: number
): Promise<{ text: string; end: number }> {
  const fd = await open(file, 'r')
  // The first byte AFTER the budget tells us whether the cut splits a code point.
  const buf = Buffer.alloc(Math.min(maxBytes + 1, size - offset))
  let bytesRead = 0
  try {
    while (bytesRead < buf.length) {
      const part = await fd.read(buf, bytesRead, buf.length - bytesRead, offset + bytesRead)
      if (!part.bytesRead) throw new Error(`${GIT_TEXT_EXPIRED}: diff spool ended early`)
      bytesRead += part.bytesRead
    }
  } finally {
    await fd.close()
  }
  let n = Math.min(maxBytes, bytesRead)
  if (offset + n < size) {
    const nl = buf.lastIndexOf(10, n - 1)
    if (nl >= 0) n = nl + 1
    else {
      // A code point has at most 3 continuation bytes. Malformed runs must still
      // advance and keep Buffer's whole-read replacement-character behavior.
      let start = n
      while (start > 0 && n - start < 3 && (buf[start] & 0xc0) === 0x80) start--
      const lead = buf[start]
      const width =
        lead >= 0xc2 && lead <= 0xdf
          ? 2
          : lead >= 0xe0 && lead <= 0xef
            ? 3
            : lead >= 0xf0 && lead <= 0xf4
              ? 4
              : 1
      if (start + width > n) n = start
    }
  }
  return { text: buf.subarray(0, n).toString('utf8'), end: offset + n }
}

/**
 * One page of `source`'s text for `repoPath`: `cursor` null = run git and answer
 * the first page; else the page the cursor names. A text within one page is
 * answered whole with no spool left behind.
 */
export async function readGitText(
  spool: GitTextSpool,
  repoPath: string,
  source: GitTextSource,
  cursor: string | null,
  opts: { maxBytes?: number } = {}
): Promise<GitTextPage> {
  // Even a tiny test budget must fit one complete UTF-8 code point (at most 4 bytes).
  const maxBytes = Math.max(4, Math.min(opts.maxBytes ?? DIFF_PAGE_BYTES, DIFF_PAGE_BYTES))
  if (cursor !== null) {
    const m = /^([0-9a-f]{32}):(\d+)$/.exec(cursor)
    if (!m) throw new Error(`${GIT_TEXT_EXPIRED}: malformed cursor`)
    const s = spool.get(m[1], repoPath)
    const offset = Number(m[2])
    if (offset > s.bytes) throw new Error(`${GIT_TEXT_EXPIRED}: cursor past the end`)
    const page = await pageAt(s.file, s.bytes, offset, maxBytes)
    if (page.end >= s.bytes) spool.release(m[1])
    return {
      text: page.text,
      cursor: page.end < s.bytes ? `${m[1]}:${page.end}` : null,
      totalBytes: s.bytes
    }
  }
  const { args, okExitCodes } = commandOf(source)
  const file = path.join(dir(), `${randomBytes(16).toString('hex')}.txt`)
  let bytes: number
  try {
    bytes = await spoolCommand('git', args, { cwd: repoPath, okExitCodes }, file)
  } catch (err) {
    await unlink(file).catch(() => undefined)
    // A stash that cannot be shown reads as empty, as `getStashDiff` answers.
    if (source.kind === 'stashDiff') return { text: '', cursor: null, totalBytes: 0 }
    throw err
  }
  if (bytes <= maxBytes) {
    const text = await readFile(file, 'utf8').finally(() => unlink(file).catch(() => undefined))
    return { text, cursor: null, totalBytes: bytes }
  }
  const id = spool.hold(file, repoPath, bytes)
  const page = await pageAt(file, bytes, 0, maxBytes)
  return { text: page.text, cursor: `${id}:${page.end}`, totalBytes: bytes }
}
