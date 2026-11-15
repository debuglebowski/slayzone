/**
 * The ignored-file index behind the copy dialog's lazy tree.
 *
 * Holds the repo's ignored files as ONE sorted array of paths (≈ the bytes of the
 * paths, far less than a node object per segment). Every file under a directory
 * `d` lies in one contiguous range of it (the paths starting `d/`), found by binary
 * search, so:
 *  - `fileCount(d)` is that range's length — exact, O(log n);
 *  - `children(d)` walks the range one child at a time, jumping over each child
 *    directory's own range — O(children · log n), cached per directory;
 *  - `page(d, cursor)` / `matchPage(globs, cursor)` answer bounded pages
 *    (`@slayzone/platform/bounded-reads`).
 *
 * Children come in the order the dialog always showed: directories first, then by
 * `localeCompare` of the name. The preset match keeps the dialog's rules: a glob
 * without `/` matches a FILE's basename at any depth; a glob with `/` selects the
 * top-level directory named by its first segment; nothing inside a selected
 * directory is selected again (no ancestor + descendant pair).
 *
 * @module worktrees/server/ignored-index
 */
import { type Page, PAGE_MAX_BYTES, pageCut } from '@slayzone/platform/bounded-reads'
import { globToRegex } from '../shared/ignored-tree'
import type { IgnoredEntry, IgnoredFileNode, IgnoredMatch } from '../shared/types'

/** OS/editor artifacts that are never listed nor copied to a worktree. */
const ALWAYS_EXCLUDED = new Set(['.DS_Store', 'Thumbs.db', 'Desktop.ini'])
export function isAlwaysExcluded(name: string): boolean {
  return (
    ALWAYS_EXCLUDED.has(name) ||
    name.endsWith('~') ||
    name.endsWith('.swp') ||
    name.endsWith('.swo')
  )
}

/** Most entries one page of a directory (or of a selection) carries. */
export const IGNORED_TREE_PAGE_ITEMS = 1000

const byDisplayOrder = (a: IgnoredEntry, b: IgnoredEntry): number =>
  a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name)

function isSorted(paths: readonly string[]): boolean {
  for (let i = 1; i < paths.length; i++) if (paths[i - 1] > paths[i]) return false
  return true
}

function pageOf<T>(items: readonly T[], cursor: string | null): Page<T> {
  let start = 0
  if (cursor !== null) {
    if (!/^\d+$/.test(cursor)) throw new Error(`invalid ignored-tree cursor '${cursor}'`)
    start = Number(cursor)
    if (start > items.length) throw new Error(`invalid ignored-tree cursor '${cursor}'`)
  }
  const rest = items.slice(start)
  const n = pageCut(rest, { maxBytes: PAGE_MAX_BYTES, maxItems: IGNORED_TREE_PAGE_ITEMS })
  const end = start + n
  return { items: rest.slice(0, n), nextCursor: end < items.length ? String(end) : null }
}

export class IgnoredIndex {
  private readonly childCache = new Map<string, IgnoredEntry[]>()
  private lastMatch: { key: string; items: IgnoredMatch[] } | null = null

  private constructor(
    /** Every ignored file, repo-relative, sorted by code unit. */
    private readonly paths: readonly string[],
    /** Sizes of root-level files (the only sizes the dialog shows). */
    private readonly rootSizes: ReadonlyMap<string, number>
  ) {}

  /** An index of `paths` (any order; sorted here only when needed). */
  static build(paths: string[], rootSizes: ReadonlyMap<string, number> = new Map()): IgnoredIndex {
    if (!isSorted(paths)) paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    return new IgnoredIndex(paths, rootSizes)
  }

  get totalFiles(): number {
    return this.paths.length
  }

  /** First index in [lo, n) whose path is not below `prefix` (all below it are contiguous). */
  private rangeEnd(prefix: string, lo: number): number {
    let a = lo
    let b = this.paths.length
    while (a < b) {
      const mid = (a + b) >>> 1
      if (this.paths[mid].startsWith(prefix)) a = mid + 1
      else b = mid
    }
    return a
  }

  /** First index whose path is >= `prefix`. */
  private lowerBound(prefix: string): number {
    let a = 0
    let b = this.paths.length
    while (a < b) {
      const mid = (a + b) >>> 1
      if (this.paths[mid] < prefix) a = mid + 1
      else b = mid
    }
    return a
  }

  private range(dir: string): [number, number] {
    if (dir === '') return [0, this.paths.length]
    const prefix = `${dir}/`
    const lo = this.lowerBound(prefix)
    return [lo, this.rangeEnd(prefix, lo)]
  }

  /** Ignored files under `dir` ('' = the repo). */
  fileCount(dir: string): number {
    const [lo, hi] = this.range(dir)
    return hi - lo
  }

  /** `dir`'s direct children, in display order. */
  children(dir: string): IgnoredEntry[] {
    const cached = this.childCache.get(dir)
    if (cached) return cached
    const [lo, hi] = this.range(dir)
    const base = dir === '' ? '' : `${dir}/`
    const out: IgnoredEntry[] = []
    for (let i = lo; i < hi; ) {
      const rest = this.paths[i].slice(base.length)
      const slash = rest.indexOf('/')
      if (slash === -1) {
        const path = this.paths[i]
        out.push({
          name: rest,
          path,
          isDirectory: false,
          size: dir === '' ? (this.rootSizes.get(path) ?? 0) : 0,
          fileCount: 1
        })
        i++
        continue
      }
      const name = rest.slice(0, slash)
      const path = base + name
      const end = this.rangeEnd(`${path}/`, i)
      out.push({ name, path, isDirectory: true, size: 0, fileCount: end - i })
      i = end
    }
    out.sort(byDisplayOrder)
    this.childCache.set(dir, out)
    return out
  }

  /** One page of `dir`'s children; `cursor` from the previous page (null = first). */
  page(dir: string, cursor: string | null): Page<IgnoredEntry> {
    return pageOf(this.children(dir), cursor)
  }

  /** A preset's selection roots over every ignored file (see module doc). */
  match(globs: readonly string[]): IgnoredMatch[] {
    const key = JSON.stringify(globs)
    if (this.lastMatch?.key === key) return this.lastMatch.items
    let items: IgnoredMatch[]
    if (globs.length === 0) {
      items = this.children('').map(({ path, isDirectory, fileCount }) => ({
        path,
        isDirectory,
        fileCount
      }))
    } else {
      const basename: RegExp[] = []
      const topDirs = new Set<string>()
      for (const glob of globs) {
        const slash = glob.indexOf('/')
        if (slash === -1) basename.push(globToRegex(glob))
        else topDirs.add(glob.slice(0, slash))
      }
      items = []
      for (let i = 0; i < this.paths.length; ) {
        const p = this.paths[i]
        const slash = p.indexOf('/')
        if (slash !== -1 && topDirs.has(p.slice(0, slash))) {
          // A selected top-level directory: one root for its whole range.
          const top = p.slice(0, slash)
          const end = this.rangeEnd(`${top}/`, i)
          items.push({ path: top, isDirectory: true, fileCount: end - i })
          i = end
          continue
        }
        const name = p.slice(p.lastIndexOf('/') + 1)
        if (basename.some((re) => re.test(name)))
          items.push({ path: p, isDirectory: false, fileCount: 1 })
        i++
      }
    }
    this.lastMatch = { key, items }
    return items
  }

  /** One page of {@link match}. */
  matchPage(globs: readonly string[], cursor: string | null): Page<IgnoredMatch> {
    return pageOf(this.match(globs), cursor)
  }
}

/**
 * The index of an older computer's whole tree (`getIgnoredFileTree`): the hub
 * answers the lazy ops from it when the computer does not (no `boundedReads`).
 */
export function ignoredIndexFromTree(tree: readonly IgnoredFileNode[]): IgnoredIndex {
  const paths: string[] = []
  const rootSizes = new Map<string, number>()
  const walk = (node: IgnoredFileNode, depth: number): void => {
    if (node.isDirectory || node.children.length > 0) {
      for (const child of node.children) walk(child, depth + 1)
      return
    }
    paths.push(node.path)
    if (depth === 0 && node.size > 0) rootSizes.set(node.path, node.size)
  }
  for (const node of tree) walk(node, 0)
  return IgnoredIndex.build(paths, rootSizes)
}
