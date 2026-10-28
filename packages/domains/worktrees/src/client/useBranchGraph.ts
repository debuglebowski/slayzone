import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from './trpc'
import { toast, useDepsChanged, useStablePoll } from '@slayzone/ui'
import type { CommitGraphConfig, ResolvedGraph } from '../shared/types'
import { DEFAULT_CONFIG, FETCH_LIMIT } from './branches-tab.constants'
import { useGitPathChanges } from './git-diff-store'
import type { CommitGraphPersistence, BranchGraphState } from './branches-tab.types'

export function useBranchGraph(
  projectPath: string | null,
  visible: boolean,
  defaultBaseBranch?: string,
  /** Per-instance config persistence (task column or project settings key). */
  persistence?: CommitGraphPersistence
): BranchGraphState {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { mutateAsync: fetchRemote } = useMutation(trpc.worktrees.fetch.mutationOptions())
  const [dagGraph, setDagGraph] = useState<ResolvedGraph | null>(null)
  const [filter, setFilter] = useState('')
  // The path whose read has landed (graph or failure) since it last became the shown
  // path; null until then. `loading` derives from it, so loading holds from the first
  // render, and only a read for the shown path can end the spinner.
  const [loadedPath, setLoadedPath] = useState<string | null>(null)
  // A new project path loads from scratch: spinner until its first read lands. Reset
  // while rendering, on a path change only — the poll re-runs at once on a tab re-show
  // (<Activity>), and the graph on screen stays while it does.
  if (useDepsChanged([projectPath])) setLoadedPath(null)
  const loading = projectPath === null || loadedPath !== projectPath
  const [fetching, setFetching] = useState(false)

  const [currentBranch, setCurrentBranch] = useState<string>('')
  const [config, setConfig] = useState<CommitGraphConfig>(DEFAULT_CONFIG)

  // `persistence` is memoized by callers (stable per task/project), so it is
  // safe to use directly as an effect/callback dependency.

  // Load per-instance config (if saved), otherwise global defaults
  useEffect(() => {
    const load = async () => {
      const instance = persistence ? await persistence.load() : null
      if (instance) {
        setConfig({ ...DEFAULT_CONFIG, ...instance, baseBranch: '' })
        return
      }
      const globalJson = await queryClient.fetchQuery(
        trpc.settings.get.queryOptions({ key: 'commit_graph_config' })
      )
      if (globalJson) {
        setConfig({ ...DEFAULT_CONFIG, ...JSON.parse(globalJson), baseBranch: '' })
      } else {
        setConfig(DEFAULT_CONFIG)
      }
    }
    load()
  }, [persistence, queryClient, trpc])

  // Save full config to this instance
  const updateConfig = useCallback(
    (updater: React.SetStateAction<CommitGraphConfig>) => {
      setConfig((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater
        if (persistence) {
          const { baseBranch: _, ...persisted } = next
          persistence.save(persisted)
        }
        return next
      })
    },
    [persistence]
  )

  // Reset to global defaults (clear per-instance config)
  const resetConfig = useCallback(async () => {
    if (persistence) {
      await persistence.clear()
    }
    const globalJson = await queryClient.fetchQuery(
      trpc.settings.get.queryOptions({ key: 'commit_graph_config' })
    )
    if (globalJson) {
      setConfig({ ...DEFAULT_CONFIG, ...JSON.parse(globalJson), baseBranch: '' })
    } else {
      setConfig(DEFAULT_CONFIG)
    }
  }, [persistence, queryClient, trpc])

  const effectiveBaseBranch = useMemo(
    () => config.baseBranch || defaultBaseBranch || currentBranch || 'main',
    [config.baseBranch, defaultBaseBranch, currentBranch]
  )

  const lastHashRef = useRef<string>('')
  // The path on screen. A layout effect, so it is set inside the commit: a read that
  // settles right after the commit already sees it (a passive effect can run a task
  // later). A read that started for another path drops its result.
  const shownPathRef = useRef(projectPath)
  useLayoutEffect(() => {
    shownPathRef.current = projectPath
  }, [projectPath])

  const fetchData = useCallback(async () => {
    if (!projectPath) return null
    // The project changed while this read ran: it changes nothing — its graph must not
    // land under the new path, nor its outcome end the new path's spinner.
    const superseded = () => shownPathRef.current !== projectPath
    const markLoaded = () => {
      if (loadedPath !== projectPath) setLoadedPath(projectPath)
    }
    try {
      // staleTime:0 — a poll / git change must read git, not a cached answer.
      const branch = await queryClient.fetchQuery(
        trpc.worktrees.getCurrentBranch.queryOptions({ path: projectPath }, { staleTime: 0 })
      )
      const baseBranch = config.baseBranch || defaultBaseBranch || branch || 'main'

      const branchSet = new Set<string>([baseBranch])

      if (config.showBranches) {
        const result = await queryClient.fetchQuery(
          trpc.worktrees.resolveChildBranches.queryOptions(
            { path: projectPath, baseBranch },
            { staleTime: 0 }
          )
        )
        for (const child of result.children) branchSet.add(child)
        for (const merged of result.merged) branchSet.add(merged)
      }

      const graph = await queryClient.fetchQuery(
        trpc.worktrees.getResolvedCommitDag.queryOptions(
          {
            path: projectPath,
            limit: FETCH_LIMIT,
            branches: [...branchSet],
            baseBranch
          },
          { staleTime: 0 }
        )
      )
      if (superseded()) return null
      // Hash excludes `relativeDate` — that string updates over time
      // ("3 minutes ago") even when the commit hash is unchanged, which would
      // defeat the dedup. Stale display dates are acceptable; they refresh on
      // any real change (new commit / ref move).
      const stableCommits = graph.commits.map(({ relativeDate: _r, ...rest }) => rest)
      const hash = JSON.stringify({
        branch,
        baseBranch: graph.baseBranch,
        branches: graph.branches,
        commits: stableCommits
      })
      if (hash !== lastHashRef.current) {
        lastHashRef.current = hash
        if (branch) setCurrentBranch(branch)
        setDagGraph(graph)
      }
      markLoaded()
      return hash
    } catch {
      if (superseded()) return null
      markLoaded()
      return null
    }
  }, [projectPath, loadedPath, config, defaultBaseBranch, queryClient, trpc])

  // Restarted per path: a new path is read at once (not on the old path's backed-off
  // timer, nor after its read still in flight), and polls from the base delay.
  const poll = useStablePoll(fetchData, {
    enabled: visible && !!projectPath,
    baseDelayMs: 10_000,
    restartKey: projectPath
  })
  // A commit / branch move (fs watcher) re-reads now; the poll is only the safety net.
  // Ref moves only — a file edit doesn't change the graph.
  useGitPathChanges(projectPath, visible, poll.refetch, { refsOnly: true })

  const handleFetch = useCallback(async () => {
    if (!projectPath) return
    setFetching(true)
    try {
      await fetchRemote({ path: projectPath })
      await fetchData()
      toast('Fetched from remote')
    } catch {
      toast('Fetch failed')
    } finally {
      setFetching(false)
    }
    // refresh is wrapped above
  }, [projectPath, fetchData, fetchRemote])

  const refresh = useCallback(async (): Promise<void> => {
    await fetchData()
  }, [fetchData])

  return {
    dagGraph,
    loading,
    filter,
    setFilter,
    config,
    setConfig: updateConfig,
    resetConfig,
    effectiveBaseBranch,
    fetching,
    handleFetch,
    refresh
  }
}
