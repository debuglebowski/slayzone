import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import { type FileDiff, parseUnifiedDiff } from '@slayzone/diff-view'
import { utf8ByteLength } from '@slayzone/platform/bounded-reads'
import type { GitTextPage } from '../shared/git-text'
import { readRestOfText } from './diff-text-loader'
import { createLoaderLifetime } from './loader-lifetime'
import { useTRPCClient } from './trpc'

interface StashText {
  text: string
  cursor: string | null
  totalBytes: number
  loading: boolean
  restLoading: boolean
  failed: boolean
}
const EMPTY: StashText = {
  text: '',
  cursor: null,
  totalBytes: 0,
  loading: false,
  restLoading: false,
  failed: false
}
const NO_FILES: FileDiff[] = []
const NO_VIEW = { loader: null, value: EMPTY }
const noSnapshot = () => NO_VIEW
const subscribeNone = () => () => undefined

/** Instance identity is the request/selection/client/lifecycle generation; state identity is its entry. */
class StashDiffLoader {
  private state: StashText = { ...EMPTY, loading: true }
  private disposed = false
  private readonly listeners = new Set<() => void>()
  constructor(
    private readonly source: {
      entryId: string | undefined
      read: (cursor: string | null) => Promise<GitTextPage>
    }
  ) {}
  readonly getSnapshot = () => this.state
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private current(entry: StashText) {
    return !this.disposed && this.state === entry
  }
  private publish(next: StashText) {
    this.state = next
    for (const listener of this.listeners) listener()
  }
  dispose() {
    this.disposed = true
    this.listeners.clear()
    this.state = EMPTY
  }
  async start() {
    const entry = this.state
    try {
      const page = await this.source.read(null)
      if (!this.current(entry)) return
      this.publish({
        text: page.text,
        cursor: page.cursor,
        totalBytes: page.totalBytes,
        loading: false,
        restLoading: false,
        failed: false
      })
    } catch {
      if (this.current(entry)) this.publish({ ...EMPTY, failed: true })
    }
  }
  async loadRest(): Promise<void> {
    const start = this.state
    if (!this.current(start) || !start.cursor || start.restLoading) return
    const entry = { ...start, restLoading: true, failed: false }
    this.publish(entry)
    const current = () => this.current(entry)
    try {
      const all = await readRestOfText(
        async (cursor) => {
          if (!current()) throw new DOMException('Stash read superseded', 'AbortError')
          try {
            const page = await this.source.read(cursor)
            if (!current()) throw new DOMException('Stash read superseded', 'AbortError')
            return page
          } catch (error) {
            // A stale expiry must not trigger readRestOfText's restart on the old client.
            if (!current()) throw new DOMException('Stash read superseded', 'AbortError')
            throw error
          }
        },
        { text: start.text, cursor: start.cursor }
      )
      if (current()) this.publish({ ...entry, text: all, cursor: null, restLoading: false })
    } catch {
      if (current()) this.publish({ ...start, restLoading: false, failed: true })
    }
  }
}

/** Bounded stash patch, bound to its selected SHA as well as index, scoped client and Activity. */
export function usePagedStashDiff(
  repoPath: string | null,
  index: number | null,
  entryId?: string
): {
  files: FileDiff[]
  loading: boolean
  rest: { remainingBytes: number; loading: boolean; failed: boolean } | null
  loadRest: () => Promise<void>
} {
  const client = useTRPCClient()
  const lifetime = useMemo(() => {
    if (!repoPath || index === null) return null
    // entryId changes invalidate index reuse even when a refreshed stash list keeps index 0.
    return createLoaderLifetime(
      EMPTY,
      (signal) =>
        new StashDiffLoader({
          entryId,
          read: (cursor) =>
            client.worktrees.readGitText.query(
              { repoPath, kind: 'stashDiff', index, cursor },
              { signal }
            )
        }),
      (loader) => {
        void loader.start()
      }
    )
  }, [client, repoPath, index, entryId])
  useLayoutEffect(() => {
    lifetime?.activate()
    return () => lifetime?.deactivate()
  }, [lifetime])
  const view = useSyncExternalStore(
    lifetime?.subscribe ?? subscribeNone,
    lifetime?.getSnapshot ?? noSnapshot
  )
  const { text, cursor, totalBytes, restLoading, failed } = view.value
  const files = useMemo(() => (text ? parseUnifiedDiff(text) : NO_FILES), [text])
  return {
    files,
    loading: lifetime !== null && (view.loader === null || view.value.loading),
    rest:
      cursor === null
        ? null
        : { remainingBytes: totalBytes - utf8ByteLength(text), loading: restLoading, failed },
    loadRest: () => view.loader?.loadRest() ?? Promise.resolve()
  }
}
