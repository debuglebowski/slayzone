import { type ForwardedRef, useCallback, useEffect, useImperativeHandle, useState } from 'react'
import type { Task } from '@slayzone/task/shared'
import {
  DEFAULT_GIT_TAB_ORDER,
  isGitTabEnabled,
  normalizeGitTabOrder,
  normalizeGitTabVisibility,
  type GitTabId,
  type GitTabVisibility
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
  const [hasGithubRemote, setHasGithubRemote] = useState(false)
  const [tabOrder, setTabOrder] = useState<GitTabId[]>(() => [...DEFAULT_GIT_TAB_ORDER])
  const [tabVisibility, setTabVisibility] = useState<GitTabVisibility>({})

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

  useEffect(() => {
    let cancelled = false
    const load = () => {
      Promise.all([
        window.api.settings.get('git_tab_order'),
        window.api.settings.get('git_tab_visibility')
      ]).then(([order, vis]) => {
        if (cancelled) return
        setTabOrder(normalizeGitTabOrder(order))
        setTabVisibility(normalizeGitTabVisibility(vis))
      })
    }
    load()
    const handler = () => load()
    window.addEventListener('sz:settings-changed', handler)
    return () => {
      cancelled = true
      window.removeEventListener('sz:settings-changed', handler)
    }
  }, [])

  // Check if repo has a GitHub remote
  useEffect(() => {
    if (!projectPath) {
      setHasGithubRemote(false)
      return
    }
    window.api.git
      .hasGithubRemote(projectPath)
      .then(setHasGithubRemote)
      .catch(() => setHasGithubRemote(false))
  }, [projectPath])

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
