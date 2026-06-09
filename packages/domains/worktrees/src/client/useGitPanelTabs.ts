import { type ForwardedRef, useCallback, useEffect, useImperativeHandle, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task/shared'
import {
  isGitTabEnabled,
  normalizeGitTabOrder,
  normalizeGitTabVisibility,
  type GitTabId
} from '@slayzone/task/shared'
import type { UnifiedGitPanelHandle } from './UnifiedGitPanel.types'

export function useGitPanelTabs(
  ref: ForwardedRef<UnifiedGitPanelHandle>,
  {
    task,
    defaultTab,
    onTabChange,
    projectPath
  }: {
    task?: Task | null
    defaultTab: GitTabId
    onTabChange?: (tab: GitTabId) => void
    projectPath: string | null
  }
) {
  const trpc = useTRPC()
  const [activeTab, setActiveTabRaw] = useState<GitTabId>(defaultTab)
  const setActiveTab = useCallback(
    (tab: GitTabId) => {
      setActiveTabRaw(tab)
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
  const tabVisibilityQuery = useQuery(
    trpc.settings.get.queryOptions({ key: 'git_tab_visibility' })
  )
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

  // Single predicate used by both render + auto-switch fallback.
  // Conflicts tab bypasses the user toggle — always shown when merge/rebase conflicts are live.
  const isTabVisible = useCallback(
    (id: GitTabId): boolean => {
      if (id === 'conflicts') return hasConflicts
      if (!isGitTabEnabled(tabVisibility, id)) return false
      if (id === 'worktrees') return showWorktrees
      if (id === 'pr') return hasGithubRemote && (!task || !!task.pr_url)
      return true
    },
    [hasConflicts, tabVisibility, showWorktrees, hasGithubRemote, task]
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

  // Auto-switch to conflicts tab when conflicts detected
  useEffect(() => {
    if (hasConflicts) setActiveTab('conflicts')
  }, [hasConflicts])

  // Auto-switch to changes tab when uncommitted
  useEffect(() => {
    if (isUncommitted) setActiveTab('changes')
  }, [isUncommitted])

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
    showWorktrees
  }
}
