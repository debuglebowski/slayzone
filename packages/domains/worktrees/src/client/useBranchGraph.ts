import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { toast, useStablePoll } from '@slayzone/ui'
import type { CommitGraphConfig, ResolvedGraph } from '../shared/types'
import { DEFAULT_CONFIG, FETCH_LIMIT } from './branches-tab.constants'
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
  const fetchMutation = useMutation(trpc.worktrees.fetch.mutationOptions())
  const [dagGraph, setDagGraph] = useState<ResolvedGraph | null>(null)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(false)
  const initialLoad = useRef(false)

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

  const fetchData = useCallback(async () => {
    if (!projectPath) return null
    try {
      const branch = await queryClient.fetchQuery(
        trpc.worktrees.getCurrentBranch.queryOptions({ path: projectPath })
      )
      const baseBranch = config.baseBranch || defaultBaseBranch || branch || 'main'

      const branchSet = new Set<string>([baseBranch])

      if (config.showBranches) {
        const result = await queryClient.fetchQuery(
          trpc.worktrees.resolveChildBranches.queryOptions({ path: projectPath, baseBranch })
        )
        for (const child of result.children) branchSet.add(child)
        for (const merged of result.merged) branchSet.add(merged)
      }

      const graph = await queryClient.fetchQuery(
        trpc.worktrees.getResolvedCommitDag.queryOptions({
          path: projectPath,
          limit: FETCH_LIMIT,
          branches: [...branchSet],
          baseBranch
        })
      )
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
      if (!initialLoad.current) {
        setLoading(false)
        initialLoad.current = true
      }
      return hash
    } catch {
      if (!initialLoad.current) {
        setLoading(false)
        initialLoad.current = true
      }
      return null
    }
  }, [projectPath, config, defaultBaseBranch, queryClient, trpc])

  useEffect(() => {
    initialLoad.current = false
    setLoading(true)
  }, [projectPath])

  useStablePoll(fetchData, { enabled: visible && !!projectPath, baseDelayMs: 10_000 })

  const handleFetch = useCallback(async () => {
    if (!projectPath) return
    setFetching(true)
    try {
      await fetchMutation.mutateAsync({ path: projectPath })
      await fetchData()
      toast('Fetched from remote')
    } catch {
      toast('Fetch failed')
    } finally {
      setFetching(false)
    }
    // refresh is wrapped above
  }, [projectPath, fetchData])

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
