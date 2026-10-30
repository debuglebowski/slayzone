/**
 * Where a folder picker on another machine opens (desktop's `WorkspaceDirPicker`, the
 * mobile app's folder picker). Pure, no imports: also exported alone as
 * `@slayzone/file-editor/dir-picker` for clients that must not load Node or the DOM.
 *
 * Paths are the TARGET machine's (`workspace.listRoots`: its roots, separator, home),
 * never the client's.
 */

/** `path` is one of `roots` or below one, by the target machine's separator. */
export function isInsideRoots(path: string, roots: readonly string[], sep: string): boolean {
  return roots.some((r) => path === r || path.startsWith(r + sep))
}

/**
 * Where to open: the caller's path if it is actually inside the target's roots, else
 * home, else the first root. A stale project path from ANOTHER machine would otherwise
 * open the picker on a directory the computer will refuse. Null = the computer allows
 * no folder at all (its `allowedRoots` are unset): nothing to open.
 */
export function pickerStartDir({
  roots,
  sep,
  home,
  defaultPath
}: {
  roots: readonly string[]
  sep: string
  home: string | null
  defaultPath?: string | null
}): string | null {
  if (roots.length === 0) return null
  if (defaultPath && isInsideRoots(defaultPath, roots, sep)) return defaultPath
  if (home && isInsideRoots(home, roots, sep)) return home
  return roots[0]
}
