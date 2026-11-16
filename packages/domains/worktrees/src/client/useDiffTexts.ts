import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { GitDiffSnapshot } from '../shared/types'
import { type DiffText, DiffTextLoader, type DiffTextSource } from './diff-text-loader'
import { createLoaderLifetime } from './loader-lifetime'
import { useTRPCClient } from './trpc'

const NONE: ReadonlyMap<string, DiffText> = new Map()
const EMPTY = { loader: null, value: NONE }
const noTexts = () => EMPTY
const subscribeNone = () => () => undefined

interface DiffTextParams {
  contextLines: string
  ignoreWhitespace: boolean
  fromSha: string | undefined
  toSha: string | undefined
}

/** Scoped per-file patches; Activity reconnect acquires a new cancellable loader generation. */
export function useDiffTexts(
  targetPath: string | null,
  params: DiffTextParams,
  snapshot: GitDiffSnapshot | null
): { loader: DiffTextLoader | null; texts: ReadonlyMap<string, DiffText> } {
  const client = useTRPCClient()
  const { contextLines, ignoreWhitespace, fromSha, toSha } = params
  const lifetime = useMemo(() => {
    if (!targetPath) return null
    const repoPath = targetPath,
      opts = { contextLines, ignoreWhitespace }
    const range = fromSha && toSha ? { fromSha, toSha } : {}
    return createLoaderLifetime(NONE, (signal) => {
      const source: DiffTextSource = {
        filesPage: (kind, filePaths, fromPaths) =>
          client.worktrees.getFileDiffsPage.query(
            {
              repoPath,
              kind,
              filePaths,
              ...(fromPaths ? { fromPaths } : {}),
              opts,
              ...(kind === 'range' ? range : {})
            },
            { signal }
          ),
        untrackedPage: (filePaths) =>
          client.worktrees.getUntrackedFileDiffs.query(
            { repoPath, filePaths, paged: true },
            { signal }
          ),
        text: (src, cursor) =>
          client.worktrees.readGitText.query(
            { repoPath, ...src, cursor } as Parameters<
              typeof client.worktrees.readGitText.query
            >[0],
            { signal }
          )
      }
      return new DiffTextLoader(source, { opts, ...range })
    })
  }, [client, targetPath, contextLines, ignoreWhitespace, fromSha, toSha])
  useLayoutEffect(() => {
    lifetime?.activate()
    return () => lifetime?.deactivate()
  }, [lifetime])
  const view = useSyncExternalStore(
    lifetime?.subscribe ?? subscribeNone,
    lifetime?.getSnapshot ?? noTexts
  )
  const loader = view.loader
  useEffect(() => {
    // An Activity replay may reconnect this effect with its old render's loader.
    if (loader && snapshot && lifetime?.getSnapshot().loader === loader) loader.sync(snapshot)
  }, [lifetime, loader, snapshot])
  return { loader, texts: view.value }
}
