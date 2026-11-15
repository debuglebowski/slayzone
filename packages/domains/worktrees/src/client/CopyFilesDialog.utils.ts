import type { IgnoredEntry } from '../shared/types'

export type NodeState = 'checked' | 'indeterminate' | 'unchecked'

/**
 * The dialog's selection: ROOTS — a file, or a directory meaning its whole
 * subtree — each with its file count. Invariant: no ancestor and descendant
 * appear together (kept by {@link toggleSelection}; the server's preset match
 * answers roots that way too). It is what `copyIgnoredFiles` gets (`paths`).
 *
 * Everything a row shows follows from the roots alone, so the tree can load
 * lazily: nothing here needs a directory's unloaded children.
 */
export type Selection = ReadonlyMap<string, number>

/** A selection, sorted for range lookups ("roots under `dir/`"). */
export interface SelectionIndex {
  readonly roots: Selection
  readonly keys: readonly string[]
  /** prefix[i] = sum of the counts of keys[0..i). */
  readonly prefix: readonly number[]
  /** Files selected in all. */
  readonly total: number
}

export function indexSelection(roots: Selection): SelectionIndex {
  const keys = [...roots.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const prefix = [0]
  for (const k of keys) prefix.push(prefix[prefix.length - 1] + (roots.get(k) ?? 0))
  return { roots, keys, prefix, total: prefix[prefix.length - 1] }
}

function lowerBound(keys: readonly string[], value: string): number {
  let a = 0
  let b = keys.length
  while (a < b) {
    const mid = (a + b) >>> 1
    if (keys[mid] < value) a = mid + 1
    else b = mid
  }
  return a
}

/** Files selected by roots strictly below `dir`. */
function countBelow(idx: SelectionIndex, dir: string): number {
  const prefix = `${dir}/`
  const lo = lowerBound(idx.keys, prefix)
  // Roots below `dir/` are contiguous in sorted order: find where they end.
  let hi = lo
  let b = idx.keys.length
  while (hi < b) {
    const mid = (hi + b) >>> 1
    if (idx.keys[mid].startsWith(prefix)) hi = mid + 1
    else b = mid
  }
  return idx.prefix[hi] - idx.prefix[lo]
}

/** The root that selects `path` — itself or an ancestor — or null. */
export function ancestorRootOf(roots: Selection, path: string): string | null {
  if (roots.has(path)) return path
  for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
    const ancestor = path.slice(0, at)
    if (roots.has(ancestor)) return ancestor
  }
  return null
}

/** A row's checkbox: checked under a root, or once roots cover all its files. */
export function stateOf(idx: SelectionIndex, entry: IgnoredEntry): NodeState {
  if (ancestorRootOf(idx.roots, entry.path) !== null) return 'checked'
  if (!entry.isDirectory) return 'unchecked'
  const below = countBelow(idx, entry.path)
  if (below === 0) return 'unchecked'
  return below >= entry.fileCount ? 'checked' : 'indeterminate'
}

/** Files of `entry` that are selected. */
export function selectedCountOf(idx: SelectionIndex, entry: IgnoredEntry): number {
  if (ancestorRootOf(idx.roots, entry.path) !== null) return entry.fileCount
  return entry.isDirectory ? countBelow(idx, entry.path) : 0
}

/** The directories from `root` down to `target`'s parent (the ones an uncheck splits). */
export function chainDirs(root: string, target: string): string[] {
  const dirs = [root]
  for (let at = target.indexOf('/', root.length + 1); at !== -1; at = target.indexOf('/', at + 1))
    dirs.push(target.slice(0, at))
  return dirs
}

/** Remove `path` and every root below it. */
export function removeSubtree(roots: Map<string, number>, path: string): void {
  roots.delete(path)
  const prefix = `${path}/`
  for (const key of [...roots.keys()]) if (key.startsWith(prefix)) roots.delete(key)
}

/**
 * The selection after clicking `entry`'s checkbox (its current `state`):
 *  - not checked → `entry` becomes the one root of its subtree;
 *  - checked → `entry`'s subtree leaves the selection. When an ANCESTOR root held
 *    it, that root is split: every sibling along the way to `entry` stays
 *    selected. That needs those directories' complete child lists —
 *    `childrenOf(dir)` must answer every child of each {@link chainDirs} entry
 *    (the dialog loads them all first).
 */
export function toggleSelection(
  roots: Selection,
  entry: IgnoredEntry,
  state: NodeState,
  childrenOf: (dir: string) => readonly IgnoredEntry[]
): Map<string, number> {
  const next = new Map(roots)
  if (state !== 'checked') {
    removeSubtree(next, entry.path)
    next.set(entry.path, entry.fileCount)
    return next
  }
  const holder = ancestorRootOf(roots, entry.path)
  if (holder !== null && holder !== entry.path) {
    next.delete(holder)
    const chain = chainDirs(holder, entry.path)
    for (let i = 0; i < chain.length; i++) {
      const onPath = i + 1 < chain.length ? chain[i + 1] : entry.path
      for (const child of childrenOf(chain[i]))
        if (child.path !== onPath) next.set(child.path, child.fileCount)
    }
  }
  removeSubtree(next, entry.path)
  return next
}
