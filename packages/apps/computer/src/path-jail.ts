/**
 * The computer's ONE path jail (T-27). Every fs., git., agentConfig. and spawn-cwd
 * path the hub names is judged here, and every write the hub asks for is done
 * here — no other module checks or writes a hub-named path.
 *
 * Judging a path ({@link judgePath}):
 *
 * 1. Refuse a NUL byte; normalize LEXICALLY (`path.resolve`: `.`/`..` collapsed, a
 *    `\` a separator only on Windows). From here on only this normalized form is
 *    used — the raw string never reaches the kernel, so how the kernel would have
 *    read `root/miss/../l` or `root/s/../y` does not matter: the op runs on what was
 *    judged.
 * 2. Find the allowed root holding it (by the root's spelling, or — when the part
 *    above the root is spelled through a link, `/tmp` → `/private/tmp` — by the
 *    canonical form of its existing part).
 * 3. Walk each component below the root with `lstat`. A symlink is resolved by the
 *    kernel (`realpath`) and must land inside that root; a DANGLING link is refused
 *    for writes (a write through it would create its target). A missing component
 *    ends the walk: nothing below it exists yet.
 * 4. Refuse the computer's own protected state paths.
 *
 * Writing ({@link jailedFs}): folders are created one level at a time, each parent
 * re-checked with `realpath` right before it is used (a folder swapped for a link
 * after the judgement is refused), files opened with `O_NOFOLLOW` (and `O_EXCL` to
 * create), so a link put in place after the judgement is never written through.
 *
 * WHAT THIS BOUNDS: hub frames. A shell or agent the hub starts runs as this OS user
 * and can touch anything that user can; the real boundary is the OS account.
 *
 * @module computer/path-jail
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  canonicalComputerPath,
  computerPathWithin,
  pathFoldsCase
} from '@slayzone/platform/computer-path'

/**
 * A path or spawn cwd the computer refuses by its own policy (T-27). The dispatcher
 * maps it to `refusedByComputer` and logs the request as `refused`.
 */
export class JailViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JailViolationError'
  }
}

/** Symlinks followed while judging one path, before it is refused as a loop. */
const MAX_LINK_HOPS = 40

/**
 * - `read`: links are followed; a dangling one is judged by where it points.
 * - `write`: as read, but no dangling link anywhere on the way (a write through it
 *   creates its target).
 * - `entry`: the op acts on the last component ITSELF (delete, rename, an exists
 *   probe): it is not followed; everything before it is judged as for `write`.
 */
export type JailAccess = 'read' | 'write' | 'entry'

export interface JailOptions {
  access?: JailAccess
  /**
   * The op takes everything under the path with it (delete, move, overwrite): an
   * ANCESTOR of a protected path is refused too.
   */
  subtree?: boolean
}

// --- protected paths --------------------------------------------------------

/**
 * The computer's own state — its config (which holds `allowedRoots`), credentials and
 * request log — refused to every hub frame even when an allowed root contains it.
 * Canonical absolute paths; set once at startup.
 */
let protectedPaths: readonly string[] = []

export function setProtectedPaths(paths: readonly string[]): void {
  protectedPaths = paths.map((p) => canonical(resolve(p)))
}

/** Is `absolute` (already judged) one of the protected state paths, or under one? */
export function isProtectedPath(absolute: string): boolean {
  return protectedHit(absolute, false)
}

/** `dev:ino` of `p` itself (a link is not followed), or null when it does not exist. */
function identity(p: string): string | null {
  try {
    const st = lstatSync(p)
    return `${st.dev}:${st.ino}`
  } catch {
    return null
  }
}

/** Identities of `p` and every ancestor of it that exists. */
function identityChain(p: string): Set<string> {
  const out = new Set<string>()
  let current = p
  for (;;) {
    const id = identity(current)
    if (id) out.add(id)
    const parent = dirname(current)
    if (parent === current) return out
    current = parent
  }
}

/**
 * Does `judged` touch the computer's own state? Matched by IDENTITY (the file or
 * folder itself, whatever the spelling: on APFS / NTFS `COMPUTER.CONFIG.JSON` and an
 * NFD name ARE the protected file, K2) and by canonical name — case-folded on such a
 * volume, NFC — for a protected path that does not exist yet. `subtree`: an ancestor
 * of a protected path counts too.
 */
function protectedHit(judged: string, subtree: boolean): boolean {
  if (protectedPaths.length === 0) return false
  const chain = identityChain(judged)
  const self = identity(judged)
  for (const guarded of protectedPaths) {
    if (isInside(judged, guarded) || (subtree && isInside(guarded, judged))) return true
    const id = identity(guarded)
    if (id && chain.has(id)) return true
    if (subtree && self && identityChain(guarded).has(self)) return true
  }
  return false
}

// --- judging ----------------------------------------------------------------

/**
 * `path` is `dir` or inside it, compared as the one canonical key every SlayZone
 * path comparison uses (`@slayzone/platform/computer-path`): NFC, and case-folded on
 * a case-insensitive volume — where `ROOT/x` IS `root/x`.
 */
function isInside(path: string, dir: string): boolean {
  return computerPathWithin(path, dir, pathFoldsCase(dir))
}

/**
 * The real spelling of an entry WITHOUT following it: a link's own name as its
 * folder lists it (same canonical key), anything else by `realpath`. Missing: as is.
 */
function canonicalEntry(p: string): string {
  const parent = canonical(dirname(p))
  const name = basename(p)
  let isLink: boolean
  try {
    isLink = lstatSync(join(parent, name)).isSymbolicLink()
  } catch {
    return join(parent, name)
  }
  if (!isLink) return canonical(join(parent, name))
  const folds = pathFoldsCase(parent)
  const key = canonicalComputerPath(name, folds)
  try {
    const listed = readdirSync(parent).find((n) => canonicalComputerPath(n, folds) === key)
    return join(parent, listed ?? name)
  } catch {
    return join(parent, name)
  }
}

/** The realpath of `p`'s deepest existing ancestor, plus the rest (links trusted). */
function canonical(p: string): string {
  const tail: string[] = []
  let current = p
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return tail.length > 0 ? join(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return p
      tail.push(basename(current))
      current = parent
    }
  }
}

interface LiveRoot {
  lexical: string
  real: string
}

function liveRoots(allowedRoots: readonly string[]): LiveRoot[] {
  const out: LiveRoot[] = []
  for (const root of allowedRoots) {
    const lexical = resolve(root)
    try {
      out.push({ lexical, real: realpathSync.native(lexical) })
    } catch {
      // A configured root that does not exist cannot contain anything.
    }
  }
  return out
}

/**
 * The components of `path` below `base` — which it is inside by the canonical key
 * (possibly in another case or Unicode form, so not a string prefix): both are
 * resolved absolute paths, so `base`'s components are `path`'s first ones.
 */
function components(path: string, base: string): string[] {
  const of = (p: string) => p.split(sep).filter(Boolean)
  return of(path).slice(of(base).length)
}

function outside(candidate: string, allowedRoots: readonly string[]): JailViolationError {
  return new JailViolationError(
    `path '${candidate}' is outside the computer's allowedRoots [${allowedRoots.join(', ')}]`
  )
}

/**
 * Walk `parts` from `root.real` (see the module doc, step 3). Returns the judged
 * path: its existing part real and canonical, the missing rest appended.
 */
function walk(
  root: LiveRoot,
  parts: readonly string[],
  access: JailAccess,
  candidate: string,
  allowedRoots: readonly string[],
  hops: { n: number }
): string {
  let current = root.real
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    const next = join(current, part)
    const last = i === parts.length - 1
    let isLink: boolean
    try {
      isLink = lstatSync(next).isSymbolicLink()
    } catch {
      // Missing (or under a file): nothing below exists yet.
      current = join(next, ...parts.slice(i + 1))
      break
    }
    if (!isLink || (last && access === 'entry')) {
      current = next
      continue
    }
    if (++hops.n > MAX_LINK_HOPS) {
      throw new JailViolationError(`path '${candidate}' runs through too many symlinks; refused`)
    }
    let target: string
    try {
      target = realpathSync.native(next)
    } catch {
      if (access !== 'read') {
        throw new JailViolationError(
          `path '${candidate}' runs through a dangling symlink ('${next}'); refused for a write`
        )
      }
      // Reading through a dangling link reads nothing; judge where it points.
      target = within(
        root,
        resolve(current, readlinkSync(next)),
        'read',
        candidate,
        allowedRoots,
        hops
      )
    }
    if (!isInside(target, root.real)) throw outside(candidate, allowedRoots)
    current = target
  }
  // The canonical spelling of what exists (letter case on a case-insensitive disk);
  // for `entry`, of its folder only — the entry itself is never followed.
  const real =
    access === 'entry' && current !== root.real ? canonicalEntry(current) : canonical(current)
  if (!isInside(real, root.real)) throw outside(candidate, allowedRoots)
  return real
}

/** Judge a normalized absolute path that must lie in `root`. */
function within(
  root: LiveRoot,
  normalized: string,
  access: JailAccess,
  candidate: string,
  allowedRoots: readonly string[],
  hops: { n: number }
): string {
  for (const base of [root.lexical, root.real]) {
    if (isInside(normalized, base)) {
      return walk(root, components(normalized, base), access, candidate, allowedRoots, hops)
    }
  }
  throw outside(candidate, allowedRoots)
}

/**
 * Judge `candidate` (see the module doc) and return the path every op must use.
 * Throws {@link JailViolationError} outside every root, on a link out of its root, a
 * dangling link for a write, a NUL byte, or a protected path.
 */
export function judgePath(
  candidate: string,
  allowedRoots: readonly string[],
  opts: JailOptions = {}
): string {
  const access = opts.access ?? 'read'
  if (allowedRoots.length === 0) {
    throw new JailViolationError(
      `computer has no allowedRoots configured; refusing filesystem access to '${candidate}'`
    )
  }
  if (candidate.includes('\0')) {
    throw new JailViolationError('path contains a NUL byte; refused')
  }
  const normalized = resolve(candidate)
  const roots = liveRoots(allowedRoots)
  const hops = { n: 0 }
  let judged: string | null = null
  for (const root of roots) {
    if (isInside(normalized, root.lexical) || isInside(normalized, root.real)) {
      judged = within(root, normalized, access, candidate, allowedRoots, hops)
      break
    }
  }
  if (judged === null) {
    // Spelled through a link above a root (`/tmp/r` for a root `/private/tmp/r`).
    const canon = canonical(normalized)
    const root = roots.find((r) => isInside(canon, r.real))
    if (!root) throw outside(candidate, allowedRoots)
    judged = walk(root, components(canon, root.real), access, candidate, allowedRoots, hops)
  }
  if (protectedHit(judged, opts.subtree === true)) {
    throw new JailViolationError(
      `path '${candidate}' holds this computer's own state (config, credentials or request log); refused`
    )
  }
  return judged
}

/**
 * Judge a ROOT-SCOPED path (the file editor's, a repo's): `rel` must stay inside
 * `rootPath` lexically (the workspace bound), then both are judged. Returns the
 * judged root and target.
 */
export function judgePathIn(
  rootPath: string,
  rel: string,
  allowedRoots: readonly string[],
  opts: JailOptions = {}
): { root: string; path: string } {
  const root = judgePath(rootPath, allowedRoots)
  if (rel.includes('\0')) throw new JailViolationError('path contains a NUL byte; refused')
  const target = resolve(root, rel)
  if (!isInside(target, root)) {
    throw new JailViolationError(`Path traversal denied: '${rel}' leaves '${rootPath}'`)
  }
  return { root, path: judgePath(target, allowedRoots, opts) }
}

/**
 * The working directory for a process the HUB starts (pty, proc, chat agent, exec):
 * an explicit `cwd` is judged; none runs in the first allowed root that exists,
 * never the computer's own launch directory. It decides where a process STARTS,
 * not what it does after.
 */
export function spawnCwd(cwd: string | undefined, allowedRoots: readonly string[]): string {
  if (cwd !== undefined) return judgePath(cwd, allowedRoots)
  const first = liveRoots(allowedRoots)[0]
  if (first) return first.real
  throw new JailViolationError('computer has no existing allowedRoots; refusing to start a process')
}

// --- writing ----------------------------------------------------------------

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

/** Right before `judged` is created or changed: its folder is still exactly that real folder. */
function assertParentUnchanged(judged: string): void {
  assertUnchanged(dirname(judged))
}

function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** `mkdir -p` of a judged folder, one level at a time, never through a link. */
function mkdirs(dir: string): void {
  const missing: string[] = []
  let current = dir
  for (;;) {
    const st = lstatOrNull(current)
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new JailViolationError(`'${current}' is not a plain folder; refused`)
      }
      break
    }
    missing.unshift(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const p of missing) {
    assertParentUnchanged(p)
    try {
      mkdirSync(p)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const st = lstatSync(p)
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new JailViolationError(`'${p}' became a link; refused`)
      }
    }
  }
  assertUnchanged(dir)
}

/** `p` is still exactly the real folder it was judged to be. */
function assertUnchanged(p: string): void {
  let real: string
  try {
    real = realpathSync.native(p)
  } catch {
    throw new JailViolationError(`folder '${p}' is gone; refused`)
  }
  if (real !== p) throw new JailViolationError(`'${p}' changed after it was judged; refused`)
}

function openForWrite(judged: string, exclusive: boolean): number {
  mkdirs(dirname(judged))
  assertParentUnchanged(judged)
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    NOFOLLOW |
    (exclusive ? fsConstants.O_EXCL : fsConstants.O_TRUNC)
  try {
    return openSync(judged, flags, 0o644)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new Error('File already exists')
    if (code === 'ELOOP') throw new JailViolationError(`'${judged}' became a link; refused`)
    throw err
  }
}

/** Copy `src`'s bytes into an open fd, in chunks (no whole file in memory). */
function pipeFile(src: string, fd: number): void {
  const srcFd = openSync(src, fsConstants.O_RDONLY)
  try {
    if (!fstatSync(srcFd).isFile()) throw new Error('Source is not a file')
    const buf = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const n = readSync(srcFd, buf, 0, buf.length, null)
      if (n === 0) break
      let off = 0
      while (off < n) off += writeSync(fd, buf, off, n - off)
    }
  } finally {
    closeSync(srcFd)
  }
}

function copyEntry(src: string, dest: string): void {
  const st = lstatSync(src)
  if (st.isSymbolicLink()) {
    // Copied as the link it is: a copy of a link is not a write through it.
    const existing = lstatOrNull(dest)
    if (existing) {
      if (existing.isDirectory() && !existing.isSymbolicLink()) {
        throw new Error(`cannot replace folder '${dest}' with a link`)
      }
      assertParentUnchanged(dest)
      rmSync(dest)
    }
    assertParentUnchanged(dest)
    symlinkSync(readlinkSync(src), dest)
  } else if (st.isDirectory()) {
    mkdirs(dest)
    for (const name of readdirSync(src)) copyEntry(join(src, name), join(dest, name))
  } else if (st.isFile()) {
    const fd = openForWrite(dest, false)
    try {
      pipeFile(src, fd)
    } finally {
      closeSync(fd)
    }
  }
}

/**
 * The only writes a hub frame can cause. Every path is one {@link judgePath}
 * returned (with the access the op needs); each op re-checks right before it acts.
 */
export const jailedFs = {
  /** Create or overwrite a file (its folders too). */
  writeFile(judged: string, content: string | Uint8Array): void {
    const fd = openForWrite(judged, false)
    try {
      writeFileSync(fd, content)
    } finally {
      closeSync(fd)
    }
  },

  /** Create a NEW file; `File already exists` (a dangling link counts) otherwise. */
  createFile(judged: string, content: string | Uint8Array = ''): void {
    const fd = openForWrite(judged, true)
    try {
      writeFileSync(fd, content)
    } finally {
      closeSync(fd)
    }
  },

  /** Copy a file (judged for reading) to a NEW file; false when the name is taken. */
  copyFileToNew(src: string, judgedDest: string): boolean {
    let fd: number
    try {
      fd = openForWrite(judgedDest, true)
    } catch (err) {
      if ((err as Error).message === 'File already exists') return false
      throw err
    }
    try {
      pipeFile(src, fd)
    } finally {
      closeSync(fd)
    }
    return true
  },

  /** `mkdir -p`. */
  mkdir(judged: string): void {
    mkdirs(judged)
  },

  /**
   * Rename an entry (both judged as `entry`). Refuses an existing target unless
   * `replace` (then a file target is replaced, as `rename(2)` does).
   */
  rename(judgedFrom: string, judgedTo: string, opts: { replace?: boolean } = {}): void {
    if (!opts.replace && lstatOrNull(judgedTo)) throw new Error('Target already exists')
    assertParentUnchanged(judgedFrom)
    assertParentUnchanged(judgedTo)
    renameSync(judgedFrom, judgedTo)
  },

  /** Remove an entry (judged as `entry`), recursively; a link is removed, not followed. */
  remove(judged: string, opts: { force?: boolean } = {}): void {
    if (opts.force && !lstatOrNull(judged)) return
    assertParentUnchanged(judged)
    rmSync(judged, { recursive: true, force: opts.force ?? false })
  },

  /** Remove one file or link (judged as `entry`); a link is removed, not followed. */
  unlink(judged: string): void {
    assertParentUnchanged(judged)
    unlinkSync(judged)
  },

  /** Remove one EMPTY folder (judged as `entry`). */
  rmdir(judged: string): void {
    assertParentUnchanged(judged)
    rmdirSync(judged)
  },

  /** Copy a file or folder tree (src judged for reading, dest for writing). */
  copy(judgedSrc: string, judgedDest: string): void {
    if (isInside(judgedDest, judgedSrc)) {
      throw new Error(`cannot copy '${judgedSrc}' into itself`)
    }
    copyEntry(judgedSrc, judgedDest)
  }
}
