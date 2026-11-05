/**
 * A path as SlayZone compares it — the ONE canonical form shared by the hub's owner
 * policy (`@slayzone/api` access.ts: whose path is this?), git routing
 * (`@slayzone/worktrees`: whose checkout is this?) and the computer's path jail
 * (`apps/computer` path-jail.ts: may a hub frame touch this?). Each of them once had
 * its own normalizer, and every difference between them was a hole (G2, K1, K2).
 *
 * {@link canonicalComputerPath}:
 *   - the flavour comes from the path itself, never the reader's OS: Windows is a
 *     drive (`C:\…`, `C:/…`) or a backslash UNC (`\\server\share\…`), where `\` and
 *     `/` both separate and `..` stops at the drive or share; anything else is POSIX,
 *     where only `/` separates (a `\` is part of a name) and `//x` is `/x` — a
 *     leading `//` is NOT a UNC path (K1: it skipped the owner check);
 *   - lexical: `.`/`..` collapsed, repeated and trailing separators dropped;
 *   - Unicode NFC: APFS and NTFS store either form and match both;
 *   - case-folded when the volume is case-insensitive (Windows always; macOS unless
 *     the volume was formatted case-sensitive — {@link volumeIsCaseInsensitive}).
 *     Only the machine that HOLDS a path can tell: the computer's jail asks its own
 *     disk; the hub folds only its own state roots and otherwise compares a computer's
 *     path exactly (L3: a macOS hub's probe folded two users' roots on a Linux
 *     computer into one).
 *
 * It is a comparison KEY: what an op opens stays the path it was handed (resolved by
 * its own reader); only "is this the same path / inside that one" goes through here.
 *
 * @module platform/computer-path
 */
import { statSync } from 'node:fs'
import { basename, dirname, join, posix, win32 } from 'node:path'

export function isWindowsComputerPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

/**
 * The lexical form, NFC: `.`/`..` collapsed, repeated and trailing separators
 * dropped (a root keeps its own: `/`, `C:\`, `\\srv\share\`). Windows paths use `\`.
 */
export function normalizeComputerPath(p: string): string {
  const nfc = p.normalize('NFC')
  if (isWindowsComputerPath(nfc)) {
    const n = win32.normalize(nfc)
    const root = win32.parse(n).root
    return n.length > root.length ? n.replace(/\\+$/, '') : n
  }
  const n = posix.normalize(nfc)
  return n.length > 1 ? n.replace(/\/+$/, '') : n
}

/**
 * THE canonical comparison key of a path: {@link normalizeComputerPath}, case-folded
 * when `caseInsensitive` (a Windows path always is).
 */
export function canonicalComputerPath(p: string, caseInsensitive: boolean): string {
  const n = normalizeComputerPath(p)
  return caseInsensitive || isWindowsComputerPath(n) ? n.toLowerCase() : n
}

/**
 * `child` is `root` or inside it, compared as {@link canonicalComputerPath} keys. The
 * boundary is the root's own separator (`\` for a Windows root, `/` otherwise).
 */
export function computerPathWithin(child: string, root: string, caseInsensitive = false): boolean {
  const c = canonicalComputerPath(child, caseInsensitive)
  const r = canonicalComputerPath(root, caseInsensitive)
  if (c === r) return true
  const sep = isWindowsComputerPath(r) ? '\\' : '/'
  return c.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * Whether comparisons against `root` fold case: a Windows path always; otherwise
 * whether the volume holding it HERE does ({@link volumeIsCaseInsensitive}; a path
 * that does not exist here is judged by the nearest part that does, else by this
 * OS's default). So only for a path on this machine's own disk: the computer's jail
 * for its folders, the hub for its own state roots — never the hub for a computer's
 * path (L3).
 */
export function pathFoldsCase(root: string): boolean {
  if (isWindowsComputerPath(root)) return true
  const hit = foldsByRoot.get(root)
  if (hit && Date.now() - hit.at < FOLDS_TTL_MS) return hit.folds
  const folds = volumeIsCaseInsensitive(root)
  if (foldsByRoot.size > 20_000) foldsByRoot.clear()
  foldsByRoot.set(root, { folds, at: Date.now() })
  return folds
}
/** Every stored root is asked about on each check: remembered for a while. */
const FOLDS_TTL_MS = 30_000
const foldsByRoot = new Map<string, { folds: boolean; at: number }>()

/** The OS default when a volume cannot be probed: macOS and Windows fold case. */
const PLATFORM_FOLDS_CASE = process.platform === 'darwin' || process.platform === 'win32'
const probed = new Map<number, boolean>()

/**
 * Whether the volume holding `path` matches names case-insensitively (APFS and NTFS
 * by default; a case-sensitive APFS or any ext4 does not). Probed once per volume:
 * the deepest existing part of `path` is looked up again with its last name's case
 * swapped — the same file means the volume folds case. Nothing to probe (no letter,
 * nothing exists): the platform's default.
 */
export function volumeIsCaseInsensitive(path: string): boolean {
  let current = path
  for (;;) {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(current)
    } catch {
      const parent = dirname(current)
      if (parent === current) return PLATFORM_FOLDS_CASE
      current = parent
      continue
    }
    const known = probed.get(st.dev)
    if (known !== undefined) return known
    const name = basename(current)
    const swapped = [...name]
      .map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
      .join('')
    if (swapped === name) {
      const parent = dirname(current)
      if (parent === current) return PLATFORM_FOLDS_CASE
      current = parent
      continue
    }
    let folds: boolean
    try {
      const other = statSync(join(dirname(current), swapped))
      folds = other.dev === st.dev && other.ino === st.ino
    } catch {
      folds = false
    }
    probed.set(st.dev, folds)
    return folds
  }
}
