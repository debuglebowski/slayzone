/**
 * The copy dialog's lazy ignored-file tree, client side: one open index (on the
 * computer, or the hub for an older computer) whose directories load page by page
 * as the user expands them. Framework-free, observed through
 * `subscribe`/`getSnapshot` (`useSyncExternalStore`).
 *
 * An index can expire on its host (idle, evicted, host restarted): any read that
 * fails with IGNORED_TREE_EXPIRED reopens it once — the loaded directories reset to
 * the new root — and retries.
 *
 * @module worktrees/client/ignored-tree-loader
 */
import { collectPages, type Page } from '@slayzone/platform/bounded-reads'
import { isIgnoredTreeExpired } from '../shared/ignored-tree'
import type { IgnoredEntry, IgnoredMatch, IgnoredTreeOpen } from '../shared/types'

/** The three routed ops (`worktrees.openIgnoredTree` / `listIgnoredTree` / `matchIgnoredTree`). */
export interface IgnoredTreeSource {
  open(): Promise<IgnoredTreeOpen>
  list(treeId: string, dir: string, cursor: string | null): Promise<Page<IgnoredEntry>>
  match(treeId: string, globs: string[], cursor: string | null): Promise<Page<IgnoredMatch>>
}

/** One directory as loaded so far. */
export interface IgnoredDir {
  items: IgnoredEntry[]
  /** More children to load (null = complete). */
  nextCursor: string | null
  loading: boolean
  failed: boolean
}

export interface IgnoredTreeSnapshot {
  status: 'loading' | 'ready' | 'error'
  totalFiles: number
  /** Loaded directories by path ('' = the repo). */
  dirs: ReadonlyMap<string, IgnoredDir>
}

const LOADING: IgnoredTreeSnapshot = { status: 'loading', totalFiles: 0, dirs: new Map() }

export class IgnoredTreeLoader {
  private treeId: string | null = null
  private snap: IgnoredTreeSnapshot = LOADING
  private readonly listeners = new Set<() => void>()
  private readonly inflight = new Map<string, Promise<void>>()
  /** Directories whose first page arrived (a placeholder state alone cannot tell). */
  private readonly loaded = new Set<string>()
  private opening: Promise<void> | null = null
  private disposed = false

  constructor(private readonly source: IgnoredTreeSource) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): IgnoredTreeSnapshot => this.snap

  private publish(next: IgnoredTreeSnapshot): void {
    if (this.disposed) return
    this.snap = next
    for (const listener of this.listeners) listener()
  }

  private setDir(dir: string, value: IgnoredDir): void {
    const dirs = new Map(this.snap.dirs)
    dirs.set(dir, value)
    this.publish({ ...this.snap, dirs })
  }

  /** Open the index (or reopen it, resetting every loaded directory). */
  private reopen(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (!this.opening) {
      this.opening = this.source
        .open()
        .then(
          (opened) => {
            if (this.disposed) return
            this.treeId = opened.treeId
            this.inflight.clear()
            this.loaded.clear()
            this.loaded.add('')
            this.publish({
              status: 'ready',
              totalFiles: opened.totalFiles,
              dirs: new Map([
                [
                  '',
                  {
                    items: opened.root.items,
                    nextCursor: opened.root.nextCursor,
                    loading: false,
                    failed: false
                  }
                ]
              ])
            })
          },
          () => {
            this.treeId = null
            this.publish({ status: 'error', totalFiles: 0, dirs: new Map() })
          }
        )
        .finally(() => {
          this.opening = null
        })
    }
    return this.opening
  }

  /** Open the index. Resolves once it answered (or failed: status 'error'). */
  start(): Promise<void> {
    return this.reopen()
  }

  /** Stop publishing (the dialog closed); late answers are dropped. */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.treeId = null
    this.snap = LOADING
    this.inflight.clear()
    this.loaded.clear()
  }

  /** `read` against the current index; an expired one is reopened once and retried. */
  private assertActive(): void {
    if (this.disposed) throw new DOMException('Ignored-tree read superseded', 'AbortError')
  }

  private async withTree<T>(read: (treeId: string) => Promise<T>): Promise<T> {
    this.assertActive()
    if (!this.treeId) await this.reopen()
    this.assertActive()
    const first = this.treeId
    if (!first) throw new Error('ignored-file listing unavailable')
    try {
      const value = await read(first)
      this.assertActive()
      return value
    } catch (err) {
      this.assertActive()
      if (!isIgnoredTreeExpired(err)) throw err
      if (this.treeId === first) await this.reopen()
      this.assertActive()
      if (!this.treeId) throw err
      const value = await read(this.treeId)
      this.assertActive()
      return value
    }
  }

  /** `dir`'s children loaded so far. */
  childrenOf(dir: string): IgnoredEntry[] {
    return this.snap.dirs.get(dir)?.items ?? []
  }

  /** Whether every child of `dir` is loaded. */
  isComplete(dir: string): boolean {
    const d = this.snap.dirs.get(dir)
    return !!d && !d.loading && !d.failed && d.nextCursor === null && this.loaded.has(dir)
  }

  /** Load `dir`'s next page (its first when none is loaded). One request per directory at a time. */
  loadMore(dir: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const running = this.inflight.get(dir)
    if (running) return running
    const run = this.withTree(async (treeId) => {
      const before = this.snap.dirs.get(dir)
      const cursor = before && this.loaded.has(dir) ? before.nextCursor : null
      if (before && this.loaded.has(dir) && cursor === null) return
      this.setDir(dir, {
        items: before?.items ?? [],
        nextCursor: before?.nextCursor ?? null,
        loading: true,
        failed: false
      })
      const page = await this.source.list(treeId, dir, cursor)
      if (this.disposed || this.treeId !== treeId) return
      const now = this.snap.dirs.get(dir)
      this.loaded.add(dir)
      this.setDir(dir, {
        items: cursor === null ? page.items : [...(now?.items ?? []), ...page.items],
        nextCursor: page.nextCursor,
        loading: false,
        failed: false
      })
    })
      .catch(() => {
        const now = this.snap.dirs.get(dir)
        this.setDir(dir, {
          items: now?.items ?? [],
          nextCursor: now?.nextCursor ?? null,
          loading: false,
          failed: true
        })
      })
      .finally(() => {
        if (this.inflight.get(dir) === run) this.inflight.delete(dir)
      })
    this.inflight.set(dir, run)
    return run
  }

  /** Load every child of `dir`; resolves with them (rejects if a page fails). */
  async loadAll(dir: string): Promise<IgnoredEntry[]> {
    for (let guard = 0; !this.isComplete(dir); guard++) {
      await this.loadMore(dir)
      const d = this.snap.dirs.get(dir)
      if (this.disposed || !d || d.failed || guard > 100_000)
        throw new Error('could not load the ignored files of this folder')
    }
    return this.childrenOf(dir)
  }

  /** A preset's selection roots, every page. */
  match(globs: string[]): Promise<IgnoredMatch[]> {
    return this.withTree((treeId) =>
      collectPages(async (cursor) => {
        this.assertActive()
        const page = await this.source.match(treeId, globs, cursor)
        this.assertActive()
        return page
      })
    )
  }
}
