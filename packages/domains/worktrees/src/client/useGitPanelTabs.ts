import {
  type ForwardedRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { useDepsChanged } from '@slayzone/ui'
import type { Task } from '@slayzone/task/shared'
import {
  isGitTabEnabled,
  normalizeGitTabOrder,
  normalizeGitTabVisibility,
  type GitTabId
} from '@slayzone/task/shared'
import type { UnifiedGitPanelHandle } from './UnifiedGitPanel.types'
import { useBranchPr } from './useBranchPr'

export function useGitPanelTabs(
  ref: ForwardedRef<UnifiedGitPanelHandle>,
  {
    task,
    defaultTab,
    onTabChange,
    projectPath,
    visible
  }: {
    task?: Task | null
    defaultTab: GitTabId
    onTabChange?: (tab: GitTabId) => void
    projectPath: string | null
    visible: boolean
  }
) {
  const trpc = useTRPC()
  const [activeTab, setActiveTabRaw] = useState<GitTabId>(defaultTab)
  // The tab the parent last heard of through onTabChange — at first the one it gave
  // us. Written only by the handler below and the merge-switch effect.
  const notifiedTabRef = useRef(defaultTab)
  const setActiveTab = useCallback(
    (tab: GitTabId) => {
      setActiveTabRaw(tab)
      notifiedTabRef.current = tab
      onTabChange?.(tab)
    },
    [onTabChange]
  )

  useImperativeHandle(
    ref,
    () => ({
      switchToTab: setActiveTab,
      getActiveTab: () => activeTab
    }),
    [activeTab, setActiveTab]
  )
  const hasConflicts =
    !!task && (task.merge_state === 'conflicts' || task.merge_state === 'rebase-conflicts')
  const isUncommitted = !!task && task.merge_state === 'uncommitted'
  const isRebase = !!task && task.merge_state === 'rebase-conflicts'

  const showWorktrees = !task

  // Settings: tab order + visibility. Re-fetched on the `sz:settings-changed`
  // window event (legacy broadcast still in use elsewhere).
  const tabOrderQuery = useQuery(trpc.settings.get.queryOptions({ key: 'git_tab_order' }))
  const tabVisibilityQuery = useQuery(trpc.settings.get.queryOptions({ key: 'git_tab_visibility' }))
  const tabOrder = normalizeGitTabOrder(tabOrderQuery.data ?? null)
  const tabVisibility = normalizeGitTabVisibility(tabVisibilityQuery.data ?? null)

  // GitHub remote presence — drives whether the PR tab is shown.
  const hasGithubRemoteQuery = useQuery(
    trpc.worktrees.hasGithubRemote.queryOptions(
      { repoPath: projectPath ?? '' },
      { enabled: !!projectPath }
    )
  )
  const hasGithubRemote = projectPath ? (hasGithubRemoteQuery.data ?? false) : false
  // A task's PR = its manual link, else the one gh resolves for its branch.
  const { pr: branchPr } = useBranchPr({ task, projectPath, enabled: visible && hasGithubRemote })
  const taskPrNumber = task?.pr_url
    ? (task.pr_url.match(/\/pull\/(\d+)/)?.[1] ?? null)
    : branchPr
      ? String(branchPr.number)
      : null

  // Single predicate used by both render + auto-switch fallback.
  // Conflicts tab bypasses the user toggle — always shown when merge/rebase conflicts are live.
  const isTabVisible = useCallback(
    (id: GitTabId): boolean => {
      if (id === 'conflicts') return hasConflicts
      if (!isGitTabEnabled(tabVisibility, id)) return false
      if (id === 'worktrees') return showWorktrees
      if (id === 'pr') return hasGithubRemote && (!task || !!task.pr_url || !!branchPr)
      return true
    },
    [hasConflicts, tabVisibility, showWorktrees, hasGithubRemote, task, branchPr]
  )

  // Re-fetch tab settings when the legacy `sz:settings-changed` broadcast fires.
  const refetchTabOrder = tabOrderQuery.refetch
  const refetchTabVisibility = tabVisibilityQuery.refetch
  useEffect(() => {
    const handler = (): void => {
      void refetchTabOrder()
      void refetchTabVisibility()
    }
    window.addEventListener('sz:settings-changed', handler)
    return () => {
      window.removeEventListener('sz:settings-changed', handler)
    }
  }, [refetchTabOrder, refetchTabVisibility])

  // A merge state that starts, or is on at mount, switches to its tab: Conflicts for
  // merge/rebase conflicts, Changes for an uncommitted merge. Once per start, while
  // rendering: the user may leave the tab while the state lasts, and re-showing the
  // task tab (<Activity> re-runs effects, not this) does not switch back.
  const mergeTab: GitTabId | null = hasConflicts ? 'conflicts' : isUncommitted ? 'changes' : null
  const mergeStateChanged = useDepsChanged([hasConflicts, isUncommitted], true)
  if (mergeStateChanged && mergeTab !== null && activeTab !== mergeTab) setActiveTabRaw(mergeTab)

  // Tell the parent (which saves it) about that switch, once: a re-run of this effect
  // (a re-show, a new onTabChange) finds nothing it has not already heard.
  useEffect(() => {
    if (notifiedTabRef.current === activeTab) return
    notifiedTabRef.current = activeTab
    onTabChange?.(activeTab)
  }, [activeTab, onTabChange])

  // Reset active tab if it becomes hidden (runtime gate, user toggle, or stale 'branches').
  useEffect(() => {
    if ((activeTab as string) === 'branches' || !isTabVisible(activeTab)) {
      const fallback = tabOrder.find(isTabVisible) ?? 'general'
      setActiveTab(fallback)
    }
  }, [activeTab, isTabVisible, tabOrder])

  return {
    activeTab,
    setActiveTab,
    isTabVisible,
    tabOrder,
    hasConflicts,
    isRebase,
    hasGithubRemote,
    showWorktrees,
    taskPrNumber
  }
}
