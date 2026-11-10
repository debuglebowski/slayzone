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
import { lstat as lstatAsync, open as openAsync, readdir as readdirAsync } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { promisify } from 'node:util'
import { write as writeCb } from 'node:fs'
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
  /**
   * A file the user picked on this machine to copy IN (`fs.copyIn` source): on a
   * hub without login it may lie outside the request's path scope (still inside
   * the machine bound), as a desktop drag from Finder always could.
   */
  hostRead?: boolean
  /** A folder the request makes a NEW root of (see {@link ScopeJail.foreign}). */
  newRoot?: boolean
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
  start: LiveRoot,
  parts: readonly string[],
  access: JailAccess,
  candidate: string,
  allowedRoots: readonly string[],
  hops: { n: number }
): string {
  // The root the walk is in: a link may lead into ANOTHER allowed root (a computer
  // with several), and the rest of the path is judged there.
  let root = start
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
    if (!isInside(target, root.real)) {
      const other = liveRoots(allowedRoots).find((r) => isInside(target, r.real))
      if (!other) throw outside(candidate, allowedRoots)
      root = other
    }
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
  const judged = judgeMachine(candidate, allowedRoots, opts)
  const scope = scopeStore.getStore()
  if (!scope || (opts.hostRead === true && scope.hostReads)) return judged
  if (opts.newRoot === true) return judgeNewRoot(judged, candidate, scope)
  return judgeScope(judged, candidate, scope)
}

// --- the request's path scope (§9 Phase 7b) -----------------------------------

/**
 * The roots ONE hub request may touch: the task's or project's own folders on this
 * computer (`roots`), minus the roots of other tasks nested inside them
 * (`excluded`: a task working in its project's folder never reaches into another
 * task's worktree there). Opened by the dispatcher from the request's path scope;
 * every path judged while it runs must ALSO lie inside it — on top of the machine
 * bound (`allowedRoots`), never instead of it.
 */
export interface ScopeJail {
  /** What the request is about, for refusals ("task t1", "project p1"). */
  label: string
  roots: readonly string[]
  excluded: readonly string[]
  /** Every root here that is someone else's (other tasks', other projects'). */
  foreign: readonly string[]
  /** The hub has no login: a user-chosen file to copy IN may lie outside the scope. */
  hostReads: boolean
}

const scopeStore = new AsyncLocalStorage<ScopeJail>()

/** Serve one request under `jail`: every path it judges is confined to it. */
export function runInScopeJail<T>(jail: ScopeJail, fn: () => T): T {
  return scopeStore.run(jail, fn)
}

/**
 * Run `fn` OUTSIDE the request's scope jail: only for the computer-level provider
 * dirs under home (`~/.claude`, …), which a project's AI-config ops read beside its
 * own files and which belong to no task or project. Callers still judge every path
 * by the machine bound (their own roots).
 */
export function outsideScopeJail<T>(fn: () => T): T {
  return scopeStore.exit(fn)
}

/** The scope jail of the request being served, if it named one. */
export function currentScopeJail(): ScopeJail | undefined {
  return scopeStore.getStore()
}

/** The canonical (real) spelling of a root, or null when it does not exist here. */
function realRoot(root: string): string | null {
  try {
    return canonical(resolve(root))
  } catch {
    return null
  }
}

/**
 * `judged` (already the canonical path the op will use, inside the machine bound)
 * must lie inside one of the scope's roots and inside none of its excluded ones.
 * Both sides compared canonically: a link from a scope root into another task's
 * worktree was already resolved by the machine walk, so it is judged by where it
 * lands.
 */
function judgeScope(judged: string, candidate: string, scope: ScopeJail): string {
  const roots = scope.roots.map(realRoot).filter((r): r is string => r !== null)
  const home = roots.find((r) => isInside(judged, r))
  if (!home) {
    throw new JailViolationError(
      roots.length === 0
        ? `${scope.label} has no folder on this computer; refusing '${candidate}'`
        : `path '${candidate}' is outside the folders of ${scope.label}; refused`
    )
  }
  for (const excluded of scope.excluded) {
    const real = realRoot(excluded)
    // Another task's root that IS (or holds) this scope's own root is not carved out.
    if (!real || isInside(home, real)) continue
    if (isInside(judged, real)) {
      throw new JailViolationError(
        `path '${candidate}' is inside another task's folder, not ${scope.label}'s; refused`
      )
    }
  }
  return judged
}

/**
 * A folder the request is about to MAKE a root (`git worktree add`'s target): inside
 * the scope as any path, or outside it but inside nobody else's root — the rule the
 * hub applied to a new root before it stopped knowing roots.
 *
 * A foreign root that IS or HOLDS one of the scope's own roots is not someone else's
 * here (S5, nested projects): project A `~/dev`, project B `~/dev/web` — B's worktree
 * beside its folder (`~/dev/web-workspaces/…`) lies inside A and is B's to make, as
 * {@link judgeScope} already lets a task work in a folder another task's root holds.
 * Any other foreign root under it (another task's worktree, project C `~/dev/c`)
 * still refuses.
 */
function judgeNewRoot(judged: string, candidate: string, scope: ScopeJail): string {
  try {
    return judgeScope(judged, candidate, scope)
  } catch (err) {
    if (!(err instanceof JailViolationError)) throw err
  }
  const own = scope.roots.map(realRoot).filter((r): r is string => r !== null)
  for (const root of scope.foreign) {
    const real = realRoot(root)
    if (!real || own.some((r) => isInside(r, real))) continue
    if (isInside(judged, real)) {
      throw new JailViolationError(
        `path '${candidate}' is inside a folder that is not ${scope.label}'s; refused`
      )
    }
  }
  return judged
}

function judgeMachine(
  candidate: string,
  allowedRoots: readonly string[],
  opts: JailOptions
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

/**
 * Where a process the hub starts FOR A TASK OR PROJECT starts (§9 Phase 7c): an
 * explicit `cwd` must lie inside that scope's own folders here (and the machine
 * bound); none runs in the scope's own folder — the task's worktree, else its base
 * dir, else its project's folder (the order `scopeBounds` lists them). The hub no
 * longer knows those folders, so this is the only check a cwd gets.
 */
export function scopedSpawnCwd(
  jail: ScopeJail,
  cwd: string | undefined,
  allowedRoots: readonly string[],
  /** The error for a scope with no folder here (a project not placed on this computer). */
  noFolder?: () => Error
): string {
  return runInScopeJail(jail, () => {
    if (cwd) return judgePath(cwd, allowedRoots)
    for (const root of jail.roots) {
      const real = realRoot(root)
      if (real && lstatOrNull(real)?.isDirectory()) return judgePath(real, allowedRoots)
    }
    if (noFolder) throw noFolder()
    throw new JailViolationError(
      `${jail.label} has no folder on this computer; refusing to start a process`
    )
  })
}

/**
 * `jail` with `root` DECLARED one of its own roots, ahead of the others (B3): a folder
 * the user chose for this request — a background process's own working folder (a
 * sibling repo `~/backend`) — which is the request's to work in although it lies
 * outside the task's / project's folders, inside another project's folder, or is
 * another task's folder. Judged like every path by the machine bound (allowed roots,
 * no link out of them, never this computer's own state); listed first, so a folder
 * nested in another task's root is not carved out of itself.
 */
export function withDeclaredRoot(jail: ScopeJail, root: string): ScopeJail {
  return { ...jail, roots: [root, ...jail.roots.filter((r) => r !== root)] }
}

/**
 * The scope a spawn's own params name: its task (with the project the hub recorded
 * for it), else its project. Null when it names neither — such a spawn is refused.
 */
export function implicitSpawnScope(
  params: unknown
):
  | { kind: 'task'; taskId: string; projectId: string | null }
  | { kind: 'project'; projectId: string }
  | null {
  if (!params || typeof params !== 'object') return null
  const p = params as { taskId?: unknown; projectId?: unknown }
  const projectId = typeof p.projectId === 'string' && p.projectId ? p.projectId : null
  if (typeof p.taskId === 'string' && p.taskId) return { kind: 'task', taskId: p.taskId, projectId }
  return projectId ? { kind: 'project', projectId } : null
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
  // The computer's own state is never copied, however deep in the tree (M7): judging
  // the top folder alone let a copy make its credentials readable in a project.
  if (protectedHit(src, false)) return
  const st = lstatSync(src)
  if (st.isSymbolicLink()) {
    // Copied as the link it is: a copy of a link is not a write through it. Its folder
    // is made first (judged, never through a link), as a file's is: a folder holding
    // only links — npm's `node_modules/.bin` — has no file to create it (L5).
    mkdirs(dirname(dest))
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

/** `fs.write` on the numeric fd `openForWrite` returns, as a promise. */
const writeAsync = promisify(writeCb)

/** How many entries a long copy handles before it lets the event loop run. */
const COPY_YIELD_EVERY = 32
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * {@link copyEntry}, asynchronously and in chunks: a tree of tens of thousands of
 * files (a worktree's `node_modules`) must not hold the computer's event loop — that
 * froze every terminal and agent on the machine, and past the heartbeat window the
 * hub declared the computer lost (K3). Same rules as the synchronous copy: each
 * write re-checked and opened `O_NOFOLLOW`, links copied as links. One buffer.
 */
async function copyEntryAsync(
  src: string,
  dest: string,
  state: { n: number; buf: Buffer }
): Promise<void> {
  if (++state.n % COPY_YIELD_EVERY === 0) await yieldToLoop()
  if (protectedHit(src, false)) return // see copyEntry (M7)
  const st = await lstatAsync(src)
  if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) {
    copyEntry(src, dest)
    return
  }
  if (st.isDirectory()) {
    mkdirs(dest)
    for (const name of await readdirAsync(src)) {
      await copyEntryAsync(join(src, name), join(dest, name), state)
    }
    return
  }
  const fd = openForWrite(dest, false)
  try {
    const source = await openAsync(src, 'r')
    try {
      for (;;) {
        const { bytesRead } = await source.read(state.buf, 0, state.buf.length, null)
        if (bytesRead === 0) break
        let off = 0
        while (off < bytesRead) {
          off += (await writeAsync(fd, state.buf, off, bytesRead - off)).bytesWritten
        }
      }
    } finally {
      await source.close()
    }
  } finally {
    closeSync(fd)
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
  },

  /** {@link jailedFs.copy} for big trees: asynchronous, yielding to the event loop. */
  async copyAsync(judgedSrc: string, judgedDest: string): Promise<void> {
    if (isInside(judgedDest, judgedSrc)) {
      throw new Error(`cannot copy '${judgedSrc}' into itself`)
    }
    await copyEntryAsync(judgedSrc, judgedDest, { n: 0, buf: Buffer.allocUnsafe(256 * 1024) })
  }
}
