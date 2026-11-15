import { useEffect, useMemo, useState } from 'react'
import { type FileDiff, parseUnifiedDiff } from '@slayzone/diff-view'
import { utf8ByteLength } from '@slayzone/platform/bounded-reads'
import { readRestOfText } from './diff-text-loader'
import { useTRPCClient } from './trpc'

interface StashText {
  key: string
  text: string
  /** The next page (null = all loaded). */
  cursor: string | null
  totalBytes: number
  /** The first page is on its way. */
  loading: boolean
  restLoading: boolean
  failed: boolean
}

const NO_FILES: FileDiff[] = []

/**
 * Stash `index`'s patch, bounded (FU1 S5): its first page (`worktrees.readGitText`),
 * and on request every remaining page. An older computer answers the whole patch
 * as one page — the same path. `index` null = nothing selected, nothing read.
 */
export function usePagedStashDiff(
  repoPath: string | null,
  index: number | null
): {
  files: FileDiff[]
  loading: boolean
  rest: { remainingBytes: number; loading: boolean; failed: boolean } | null
  loadRest: () => Promise<void>
} {
  const client = useTRPCClient()
  const [state, setState] = useState<StashText | null>(null)
  const key = repoPath && index !== null ? JSON.stringify([repoPath, index]) : null

  useEffect(() => {
    if (!key || !repoPath || index === null) return
    let live = true
    setState({
      key,
      text: '',
      cursor: null,
      totalBytes: 0,
      loading: true,
      restLoading: false,
      failed: false
    })
    client.worktrees.readGitText
      .query({ repoPath, kind: 'stashDiff', index, cursor: null })
      .then((page) => {
        if (live)
          setState({
            key,
            text: page.text,
            cursor: page.cursor,
            totalBytes: page.totalBytes,
            loading: false,
            restLoading: false,
            failed: false
          })
      })
      .catch(() => {
        if (live)
          setState({
            key,
            text: '',
            cursor: null,
            totalBytes: 0,
            loading: false,
            restLoading: false,
            failed: true
          })
      })
    return () => {
      live = false
    }
  }, [key, repoPath, index, client])

  const current = state !== null && state.key === key ? state : null
  const text = current?.text ?? ''
  const files = useMemo(() => (text ? parseUnifiedDiff(text) : NO_FILES), [text])

  const loadRest = (): Promise<void> => {
    const start = current
    if (!start?.cursor || !repoPath || index === null || start.restLoading) return Promise.resolve()
    const startCursor = start.cursor
    setState((s) => (s?.key === start.key ? { ...s, restLoading: true, failed: false } : s))
    return readRestOfText(
      (cursor) =>
        client.worktrees.readGitText.query({ repoPath, kind: 'stashDiff', index, cursor }),
      { text: start.text, cursor: startCursor }
    )
      .then((all) => {
        setState((s) =>
          s?.key === start.key ? { ...s, text: all, cursor: null, restLoading: false } : s
        )
      })
      .catch(() => {
        setState((s) => (s?.key === start.key ? { ...s, restLoading: false, failed: true } : s))
      })
  }

  return {
    files: key ? files : NO_FILES,
    loading: !!key && (current?.loading ?? true),
    rest:
      current?.cursor != null
        ? {
            remainingBytes: current.totalBytes - utf8ByteLength(current.text),
            loading: current.restLoading,
            failed: current.failed
          }
        : null,
    loadRest
  }
}
