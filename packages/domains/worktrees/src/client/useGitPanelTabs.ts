import {
  type ForwardedRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from './trpc'
import { useDepsChanged } from '@slayzone/ui'
import type { Task } from '@slayzone/task-contracts'
import {
  isGitTabEnabled,
  normalizeGitTabOrder,
  normalizeGitTabVisibility,
  type GitTabId
} from '@slayzone/task-contracts'
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
  // The tab chosen (a click, switchToTab, a merge starting) and saved through
  // onTabChange. It can be hidden right now: the panel then shows `activeTab` below.
  const [selectedTab, setSelectedTab] = useState<GitTabId>(defaultTab)

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

  // Single predicate used by the tab bar and the fallback below.
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
  if (mergeStateChanged && mergeTab !== null && selectedTab !== mergeTab) setSelectedTab(mergeTab)

  // Tell the parent (which saves it) each change of the selection once, after it
  // commits, whatever made it: a click, switchToTab or the merge switch above. The ref
  // holds the tab the parent last heard of (at first the one it gave us), so a click
  // on the selected tab or a re-run of this effect (a re-show under <Activity>, a new
  // onTabChange) reports nothing. The fallback below is never selected, never saved.
  const notifiedTabRef = useRef(defaultTab)
  useEffect(() => {
    if (notifiedTabRef.current === selectedTab) return
    notifiedTabRef.current = selectedTab
    onTabChange?.(selectedTab)
  }, [selectedTab, onTabChange])

  // The tab on screen: the selected one while the tab bar shows it, else the first tab
  // the bar shows. Display only, never selected or saved: a selection hidden for a
  // while (the PR tab until the GitHub remote or the branch's PR loads, a tab disabled
  // in settings, Conflicts after the merge) is shown again once its tab is; a retired
  // id (a saved 'branches') is not in the order, so it never is.
  const activeTab: GitTabId =
    tabOrder.includes(selectedTab) && isTabVisible(selectedTab)
      ? selectedTab
      : (tabOrder.find(isTabVisible) ?? 'general')

  useImperativeHandle(
    ref,
    () => ({
      switchToTab: setSelectedTab,
      getActiveTab: () => activeTab
    }),
    [activeTab]
  )

  return {
    activeTab,
    setActiveTab: setSelectedTab,
    isTabVisible,
    tabOrder,
    hasConflicts,
    isRebase,
    hasGithubRemote,
    showWorktrees,
    taskPrNumber
  }
}
