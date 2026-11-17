/**
 * Open ignored-file indexes ({@link IgnoredIndex}), each under a random id — the
 * state behind `openIgnoredTree` / `listIgnoredTree` / `matchIgnoredTree`.
 *
 * `open` scans the repo ONCE (`git ls-files --others --ignored --exclude-standard`,
 * streamed entry by entry) and answers the root's first page; the dialog then asks
 * for any directory's pages by id. An index is bound to the repo that opened it,
 * kept while used (idle expiry) and LRU-capped; an unknown, foreign or expired id
 * fails with {@link IGNORED_TREE_EXPIRED} in the message (it crosses the computer
 * link and tRPC as text), and the dialog reopens.
 *
 * One store per process: the computer's (`git-ops` table, scanning with
 * `ignored-scan.ts`), and the hub's for an older computer's whole tree
 * (`ignored-tree-routing.ts`). Spawns nothing itself: hub-bundled code imports it.
 *
 * @module worktrees/server/ignored-trees
 */
import { randomBytes } from 'node:crypto'
import type { Page } from '@slayzone/platform/bounded-reads'
import { IGNORED_TREE_EXPIRED, isIgnoredTreeExpired } from '../shared/ignored-tree'
import type { IgnoredEntry, IgnoredMatch, IgnoredTreeOpen } from '../shared/types'
import type { IgnoredIndex } from './ignored-index'

export { IGNORED_TREE_EXPIRED, isIgnoredTreeExpired }

interface Held {
  repoPath: string
  index: IgnoredIndex
  usedAt: number
}

export interface IgnoredTreeStoreOptions {
  now?: () => number
  /** Dropped when unused this long (default 10 min). */
  idleMs?: number
  /** Most indexes held; the least recently used goes first (default 4). */
  max?: number
  /** Prefix of ids this store makes (the hub's own: `hub:`). */
  idPrefix?: string
}

export class IgnoredTreeStore {
  private readonly held = new Map<string, Held>()
  private readonly now: () => number
  private readonly idleMs: number
  private readonly max: number
  private readonly idPrefix: string
  /** Drops idle indexes while any is held (unref'd: never keeps the process alive). */
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: IgnoredTreeStoreOptions = {}) {
    this.now = opts.now ?? Date.now
    this.idleMs = opts.idleMs ?? 10 * 60_000
    this.max = opts.max ?? 4
    this.idPrefix = opts.idPrefix ?? ''
  }

  /** Indexes held. */
  get size(): number {
    return this.held.size
  }

  private arm(): void {
    if (this.timer || this.held.size === 0) return
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

  private sweep(): void {
    const cutoff = this.now() - this.idleMs
    for (const [id, h] of this.held) if (h.usedAt < cutoff) this.held.delete(id)
  }

  /** Hold `index` (scanned from `repoPath`) under a new id; answers the open reply. */
  adopt(repoPath: string, index: IgnoredIndex): IgnoredTreeOpen {
    this.sweep()
    const treeId = this.idPrefix + randomBytes(16).toString('hex')
    this.held.set(treeId, { repoPath, index, usedAt: this.now() })
    while (this.held.size > this.max) {
      let oldest: string | null = null
      let at = Number.POSITIVE_INFINITY
      for (const [id, h] of this.held)
        if (h.usedAt < at) {
          at = h.usedAt
          oldest = id
        }
      if (oldest === null) break
      this.held.delete(oldest)
    }
    this.arm()
    return { treeId, totalFiles: index.totalFiles, root: index.page('', null) }
  }

  /** Build `repoPath`'s index with `scan` and hold it. */
  async open(
    repoPath: string,
    scan: (repoPath: string) => Promise<IgnoredIndex>
  ): Promise<IgnoredTreeOpen> {
    return this.adopt(repoPath, await scan(repoPath))
  }

  private get(repoPath: string, treeId: string): IgnoredIndex {
    this.sweep()
    const h = this.held.get(treeId)
    if (!h || h.repoPath !== repoPath)
      throw new Error(`${IGNORED_TREE_EXPIRED}: the ignored-file listing expired; reopen it`)
    // Strictly newer than every earlier use, so LRU order holds within one clock tick.
    let at = this.now()
    for (const other of this.held.values())
      if (other !== h && other.usedAt >= at) at = other.usedAt + 1
    h.usedAt = at
    return h.index
  }

  list(q: {
    repoPath: string
    treeId: string
    dir: string
    cursor: string | null
  }): Page<IgnoredEntry> {
    return this.get(q.repoPath, q.treeId).page(q.dir, q.cursor)
  }

  match(q: {
    repoPath: string
    treeId: string
    globs: string[]
    cursor: string | null
  }): Page<IgnoredMatch> {
    return this.get(q.repoPath, q.treeId).matchPage(q.globs, q.cursor)
  }
}

/** This process's open indexes (the computer's, through the git-ops table). */
export const ignoredTrees = new IgnoredTreeStore()
