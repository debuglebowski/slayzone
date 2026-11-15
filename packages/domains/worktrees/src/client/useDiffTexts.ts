import { useEffect, useState, useSyncExternalStore } from 'react'
import type { GitDiffSnapshot } from '../shared/types'
import { type DiffText, DiffTextLoader, type DiffTextSource } from './diff-text-loader'
import { useTRPCClient } from './trpc'

const NONE: ReadonlyMap<string, DiffText> = new Map()
const unsubscribeNone = (): void => {
  /* nothing subscribed */
}
const subscribeNone = (): (() => void) => unsubscribeNone
const noTexts = (): ReadonlyMap<string, DiffText> => NONE

interface DiffTextParams {
  contextLines: string
  ignoreWhitespace: boolean
  fromSha: string | undefined
  toSha: string | undefined
}

/**
 * The per-file patches of `snapshot` that are not in its own patch text — the
 * files a paged snapshot deferred and the untracked files' preview — loaded by a
 * {@link DiffTextLoader}: one per (checkout, diff options), through the panel's
 * scoped vanilla client (pages are held by the loader, never cached twice).
 */
export function useDiffTexts(
  targetPath: string | null,
  params: DiffTextParams,
  snapshot: GitDiffSnapshot | null
): { loader: DiffTextLoader | null; texts: ReadonlyMap<string, DiffText> } {
  const client = useTRPCClient()
  const [held, setHeld] = useState<{
    key: string
    loader: DiffTextLoader | null
  } | null>(null)
  const key = JSON.stringify([
    targetPath,
    params.contextLines,
    params.ignoreWhitespace,
    params.fromSha ?? null,
    params.toSha ?? null
  ])
  if (held === null || held.key !== key) {
    let loader: DiffTextLoader | null = null
    if (targetPath) {
      const repoPath = targetPath
      const opts = { contextLines: params.contextLines, ignoreWhitespace: params.ignoreWhitespace }
      const range =
        params.fromSha && params.toSha ? { fromSha: params.fromSha, toSha: params.toSha } : {}
      const source: DiffTextSource = {
        filesPage: (kind, filePaths, fromPaths) =>
          client.worktrees.getFileDiffsPage.query({
            repoPath,
            kind,
            filePaths,
            ...(fromPaths ? { fromPaths } : {}),
            opts,
            ...(kind === 'range' ? range : {})
          }),
        untrackedPage: (filePaths) =>
          client.worktrees.getUntrackedFileDiffs.query({ repoPath, filePaths, paged: true }),
        text: (src, cursor) =>
          client.worktrees.readGitText.query({ repoPath, ...src, cursor } as Parameters<
            typeof client.worktrees.readGitText.query
          >[0])
      }
      loader = new DiffTextLoader(source, { opts, ...range })
    }
    setHeld({ key, loader })
  }
  const loader = held?.loader ?? null

  useEffect(() => {
    if (!loader) return
    return () => loader.dispose()
  }, [loader])

  useEffect(() => {
    if (loader && snapshot) loader.sync(snapshot)
  }, [loader, snapshot])

  const texts = useSyncExternalStore(
    loader?.subscribe ?? subscribeNone,
    loader?.getSnapshot ?? noTexts
  )
  return { loader, texts }
}
