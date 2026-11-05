/**
 * A path on a COMPUTER, as the hub compares it: the one lexical form shared by the
 * owner policy (`@slayzone/api` access.ts, "whose path is this?") and the git
 * routing (`@slayzone/worktrees`, "whose checkout is this?"). Two normalizers drifted
 * apart (G2): routing took a `\` as a boundary on every path and missed UNC paths,
 * the policy took a POSIX `\` as a name character and UNC as Windows — so
 * `/home/a/wt/feat\x` was A's task to one and nobody's to the other.
 *
 * The flavour comes from the path itself, never from the hub's own OS:
 *   - Windows: a drive (`C:\…`, `C:/…`) or UNC (`\\server\share\…`); `\` and `/` both
 *     separate; `..` stops at the drive or share.
 *   - anything else is POSIX: only `/` separates, a `\` is part of a name.
 *
 * @module platform/computer-path
 */
import { posix, win32 } from 'node:path'

export function isWindowsComputerPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('//')
}

/**
 * The comparable lexical form: `.`/`..` collapsed, repeated and trailing separators
 * dropped (a root keeps its own: `/`, `C:\`, `\\srv\share\`). Windows paths use `\`.
 */
export function normalizeComputerPath(p: string): string {
  if (isWindowsComputerPath(p)) {
    const n = win32.normalize(p)
    const root = win32.parse(n).root
    return n.length > root.length ? n.replace(/\\+$/, '') : n
  }
  const n = posix.normalize(p)
  return n.length > 1 ? n.replace(/\/+$/, '') : n
}

/** `child` is `root` or inside it; both in {@link normalizeComputerPath} form. */
export function computerPathWithin(child: string, root: string): boolean {
  if (child === root) return true
  const sep = isWindowsComputerPath(root) ? '\\' : '/'
  return child.startsWith(root.endsWith(sep) ? root : root + sep)
}
