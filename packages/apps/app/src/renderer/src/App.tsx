import React, {
  Suspense,
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useDeferredValue,
  useTransition
} from 'react'
import { initShortcuts } from './shortcut-init'
import { AlertTriangle, BookOpen } from 'lucide-react'
import type { Task } from '@slayzone/task/shared'
import type { Project, ColumnConfig } from '@slayzone/projects/shared'
import {
  getDefaultStatus,
  getDoneStatus,
  getStatusByCategory,
  isCompletedStatus,
  resolveRepoPath
} from '@slayzone/projects/shared'
// Domains
import {
  useTasksData,
  useUndoableTaskActions,
  useFilterState,
  useFilterStore,
  applyFilters,
  getViewConfig,
  useSnoozeWakeUp,
  TaskContextMenu,
  BulkTaskContextMenu
} from '@slayzone/tasks/hooks'
import { useGlobalPanelSizes } from '@slayzone/task/client/usePanelSizes'
import { usePanelConfig } from '@slayzone/task/client/usePanelConfig'
import { useProjectRepos } from '@slayzone/worktrees/hooks'
import type { ProjectCreationContext } from '@slayzone/projects'
import {
  isRateLimited,
  recordTaskOpen,
  isProjectLocked,
  PROJECT_LOCKED_TOAST
} from '@slayzone/projects'
import { useTabStore, useDialogStore, AppearanceProvider } from '@slayzone/settings'
import { track } from '@slayzone/telemetry/client'
import { usePtyStatus, useTerminalStateStore } from '@slayzone/terminal/client'
// Shared
import { Tooltip, TooltipTrigger, TooltipContent, toast } from '@slayzone/ui'
import { SidebarProvider, cn, useUndo, useShortcutDisplay } from '@slayzone/ui'
import { AppSidebar } from '@/components/sidebar/AppSidebar'
import { useChangelogAutoOpen } from '@/components/changelog/useChangelogAutoOpen'
import { useStaleSkillCount } from '@slayzone/ai-config/client'
import { TabBar } from '@/components/tabs/TabBar'
import { useGlobalAgentPanelState } from '@/components/global-agent-panel'
import {
  useIdleTasks,
  useActiveSessionTaskIds,
  useAgentStatusState
} from '@/components/agent-status'
import { UsagePopover } from '@/components/usage/UsagePopover'
import { BoostPill } from '@/components/usage/BoostPill'
import { useUsage } from '@/components/usage/useUsage'
import { useOnboardingChecklist } from '@/hooks/useOnboardingChecklist'
import { TaskShell } from '@slayzone/task/client/TaskShell'
// Extracted hooks (self-contained, clean interfaces)
import { useHomePanel } from '@/hooks/useHomePanel'
import { useTabLifecycle } from '@/hooks/useTabLifecycle'
import { useTabColors } from '@/hooks/useTabColors'
import { useVisibleTabs } from '@/hooks/useVisibleTabs'
import { useDiagnosticsSync } from '@/hooks/useDiagnosticsSync'
// Extracted shell: lazy components, types/constants, hooks, panels (see ./app-shell)
import {
  TaskDetailDataLoader,
  LeaderboardPage,
  UsageAnalyticsPage,
  ContextManagerPage,
  useLazyMounted,
  AppHeaderActions,
  CompactFooter,
  HomeDetail,
  AppSidePanels,
  AppDialogs,
  useExplodeMode,
  useProjectPathGuard,
  useAppUpdates,
  useAuthFailureBanner,
  useAppShortcuts,
  useAppIpcListeners,
  useIdlePreload,
  COMMUNITY_DISCORD_URL,
  COMMUNITY_X_URL
} from './app-shell'
import type {
  ProjectSettingsTab,
  ProjectIntegrationOnboardingProvider,
  ContextManagerSection
} from './app-shell'

function App(): React.JSX.Element {
  performance.mark('sz:app:render')
  const shouldMount = useLazyMounted()
  // Core data from domain hook
  const {
    tasks,
    projects,
    projectGroups,
    tags,
    taskTags,
    blockedTaskIds,
    setTasks,
    setProjects,
    setTags,
    setTaskTags,
    updateTask,
    moveTask,
    bulkMove,
    reorderTasks,
    reparentTask,
    bulkReparent,
    archiveTask: rawArchiveTask,
    archiveTasks: rawArchiveTasks,
    deleteTask: rawDeleteTask,
    bulkDelete: rawBulkDelete,
    contextMenuUpdate: rawContextMenuUpdate,
    bulkContextMenuUpdate: rawBulkContextMenuUpdate,
    setTaskPinned,
    setTasksPinned,
    setTaskCollapsed,
    reorderPinnedTasks,
    clearBlockers,
    updateProject,
    reorderProjects,
    deleteProject,
    createProjectGroup,
    createFolderWithProjects,
    renameProjectGroup,
    deleteProjectGroup,
    setGroupCollapsed,
    reorderTopLevel,
    moveProjectToGroup,
    reorderProjectsInGroup
  } = useTasksData()

  // Snooze wake-up timer — clears snooze + notifies when expiry passes
  useSnoozeWakeUp(tasks)

  // Undo/redo stack
  const { push: pushUndo, undo, redo } = useUndo()
  const {
    contextMenuUpdate,
    archiveTask,
    archiveTasks,
    deleteTask,
    bulkContextMenuUpdate,
    bulkDelete
  } = useUndoableTaskActions(
    {
      tasks,
      updateTask,
      setTasks,
      archiveTask: rawArchiveTask,
      archiveTasks: rawArchiveTasks,
      deleteTask: rawDeleteTask,
      bulkDelete: rawBulkDelete,
      contextMenuUpdate: rawContextMenuUpdate,
      bulkContextMenuUpdate: rawBulkContextMenuUpdate
    },
    { push: pushUndo, undo }
  )

  // View state (tabs + selected project, persisted via zustand)
  const tabs = useTabStore((s) => s.tabs)
  const closedTabs = useTabStore((s) => s.closedTabs)
  const activeTabIndex = useTabStore((s) => s.activeTabIndex)
  const deferredActiveTabIndex = useDeferredValue(activeTabIndex)
  const activeView = useTabStore((s) => s.activeView)
  const sidebarAutoHide = useTabStore((s) => s.sidebarAutoHide)
  const sidebarView = useTabStore((s) => s.sidebarView)
  const selectedProjectId = useTabStore((s) => s.selectedProjectId)
  const {
    setActiveTabIndex,
    setSelectedProjectId,
    openTask: rawOpenTask,
    openTaskInBackground,
    reorderTabs,
    reopenClosedTab
  } = useTabStore.getState()
  const [, startTransition] = useTransition()

  // Expose tab store for e2e tests
  if (!(window as any).__slayzone_tabStore) (window as any).__slayzone_tabStore = useTabStore
  if (!(window as any).__slayzone_dialogStore)
    (window as any).__slayzone_dialogStore = useDialogStore
  if (!(window as any).__slayzone_filterStore)
    (window as any).__slayzone_filterStore = useFilterStore

  // Filter state (persisted per project)
  const [filter, setFilter] = useFilterState(selectedProjectId)

  // Dialog state (from zustand store — see useDialogStore)
  const createTaskOpen = useDialogStore((s) => s.createTaskOpen)
  const createTaskDraft = useDialogStore((s) => s.createTaskDraft)
  const editingTask = useDialogStore((s) => s.editingTask)
  const deletingTask = useDialogStore((s) => s.deletingTask)
  const createProjectOpen = useDialogStore((s) => s.createProjectOpen)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [projectSettingsInitialTab, setProjectSettingsInitialTab] =
    useState<ProjectSettingsTab>('general')
  const [testGroupBy, setTestGroupBy] = useState<'none' | 'path' | 'label'>('none')
  const [projectSettingsOnboardingProvider, setProjectSettingsOnboardingProvider] =
    useState<ProjectIntegrationOnboardingProvider | null>(null)
  const deletingProject = useDialogStore((s) => s.deletingProject)
  const groupSettingsTarget = useDialogStore((s) => s.groupSettingsTarget)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const [colorTintsEnabled, setColorTintsEnabled] = useState(true)
  const [showContextManager, setShowContextManager] = useState(true)
  const [testsPanelEnabled, setTestsPanelEnabled] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<string>('appearance')
  const [settingsInitialAiConfigSection, setSettingsInitialAiConfigSection] =
    useState<ContextManagerSection | null>(null)
  const onboardingOpen = useDialogStore((s) => s.onboardingOpen)
  const [shouldMountOnboarding, setShouldMountOnboarding] = useState(onboardingOpen)
  const changelogOpen = useDialogStore((s) => s.changelogOpen)
  const [autoChangelogOpen, lastSeenVersion, dismissAutoChangelog] = useChangelogAutoOpen()
  const searchOpen = useDialogStore((s) => s.searchOpen)
  const completeTaskDialogOpen = useDialogStore((s) => s.completeTaskDialogOpen)
  const [terminalFocusRequests, setTerminalFocusRequests] = useState<Record<string, number>>({})
  const [zenMode, setZenMode] = useState(false)
  const [panelSizes, updatePanelSizes, resetPanelSize] = useGlobalPanelSizes()
  const {
    config: homePanelConfig,
    isBuiltinEnabled: isHomePanelEnabled,
    getOrderedHomeIds
  } = usePanelConfig()
  const orderedHomeIds = useMemo(() => getOrderedHomeIds(), [getOrderedHomeIds])
  const { updateVersion, updateDownloadPercent, updateToastDismissed, setUpdateToastDismissed } =
    useAppUpdates()

  // Warm keystroke-triggered lazy chunks (Cmd+K palette) on idle → no blank gap on first open.
  useIdlePreload()

  // Home panel state (extracted — owns its own state fully)
  const homePanel = useHomePanel(selectedProjectId, panelSizes, homePanelConfig, orderedHomeIds)

  // Multi-repo detection for home tab
  const homeSelectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId),
    [projects, selectedProjectId]
  )
  // Same data source as task git panel — flat list of project-root + child repos + recursive submodules.
  const { repos: homeViewableRepos } = useProjectRepos(homeSelectedProject?.path ?? null, null)
  const homeDetectedRepos = useMemo(
    () => homeViewableRepos.map((r) => ({ name: r.name, path: r.path, kind: r.kind })),
    [homeViewableRepos]
  )
  const homeResolvedRepo = useMemo(
    () =>
      resolveRepoPath(
        homeSelectedProject?.path ?? null,
        homeDetectedRepos,
        homeSelectedProject?.selected_repo ?? null
      ),
    [homeSelectedProject?.path, homeDetectedRepos, homeSelectedProject?.selected_repo]
  )
  const handleHomeRepoChange = useCallback(
    (repoName: string) => {
      if (!homeSelectedProject) return
      window.api.db
        .updateProject({ id: homeSelectedProject.id, selectedRepo: repoName })
        .then((updated) => {
          updateProject(updated)
        })
    },
    [homeSelectedProject?.id, updateProject]
  )

  // Project path validation (extracted — validates on select + window focus)
  const { projectPathMissing, validateProjectPath, handleFixProjectPath } = useProjectPathGuard(
    selectedProjectId,
    projects,
    updateProject
  )

  // Project rename state
  const [projectNameValue, setProjectNameValue] = useState('')
  const projectNameInputRef = useRef<HTMLTextAreaElement>(null)

  const openTaskIds = useMemo(
    () =>
      tabs
        .filter((t): t is { type: 'task'; taskId: string; title: string } => t.type === 'task')
        .map((t) => t.taskId),
    [tabs]
  )
  const activeAgentTaskIds = useActiveSessionTaskIds()

  // Explode mode (multi-task grid) — owns toggle, focused cell, grid ref + width
  const { explodeMode, setExplodeMode, focusedExplodeTaskId, explodeGridRef, explodeGridWidth } =
    useExplodeMode(openTaskIds, tabs, activeTabIndex)

  // Tab lifecycle (extracted — manages sync, cleanup, cache eviction, page tracking)
  useTabLifecycle({ tasks, projects, tabs, activeTabIndex, setTerminalFocusRequests })

  // Tab colors (extracted — pure derivation)
  const { taskProjectColors, taskWorktreeColors, tabCycleOrder } = useTabColors(
    tabs,
    tasks,
    projects,
    colorTintsEnabled
  )

  // Per-tab task progress + completion state (mirrors Map-prop pattern above)
  const { taskProgress, doneTaskIds, attentionTaskIds } = useMemo(() => {
    const progress = new Map<string, number>()
    const done = new Set<string>()
    const attention = new Set<string>()
    const columnsByProject = new Map(projects.map((p) => [p.id, p.columns_config]))
    for (const task of tasks) {
      if (typeof task.progress === 'number' && task.progress > 0)
        progress.set(task.id, task.progress)
      if (isCompletedStatus(task.status, columnsByProject.get(task.project_id))) done.add(task.id)
      if (task.needs_attention) attention.add(task.id)
    }
    return { taskProgress: progress, doneTaskIds: done, attentionTaskIds: attention }
  }, [tasks, projects])

  // Onboarding
  const showAnimatedTour = useDialogStore((s) => s.showAnimatedTour)
  const handleChecklistCheckLeaderboard = useCallback((): void => {
    useTabStore.getState().setActiveView('leaderboard')
  }, [])
  const handleChecklistJoinCommunity = useCallback((): void => {
    void window.api.shell.openExternal(COMMUNITY_DISCORD_URL)
  }, [])
  const handleChecklistFollowOnX = useCallback((): void => {
    void window.api.shell.openExternal(COMMUNITY_X_URL)
  }, [])

  const hasCreatedTask = useMemo(() => tasks.some((task) => !task.is_temporary), [tasks])
  const {
    checklist: onboardingChecklist,
    startTour,
    markSetupGuideCompleted
  } = useOnboardingChecklist({
    projectCount: projects.length,
    hasCreatedTask,
    onCheckLeaderboard: handleChecklistCheckLeaderboard,
    onJoinCommunity: handleChecklistJoinCommunity,
    onFollowOnX: handleChecklistFollowOnX
  })

  useEffect(() => {
    performance.mark('sz:app:mounted')
  }, [])
  useEffect(() => {
    return initShortcuts()
  }, [])

  // Idle-prefetch heavy chunks user will likely hit soon. Runs after first
  // paint settles. requestIdleCallback yields to main-thread work so this
  // never blocks user input. import() is cached → real usage hits warm chunk.
  useEffect(() => {
    const idle = (cb: () => void): number => {
      const ric = (
        window as unknown as {
          requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
        }
      ).requestIdleCallback
      return ric ? ric(cb, { timeout: 3000 }) : (setTimeout(cb, 1500) as unknown as number)
    }
    const handle = idle(() => {
      // Task-detail page chunk — shared by every task tab, lazy (see TaskDetailDataLoader
      // import above). The very first task open cold-downloads it; warming here makes even
      // the first open instant. This is the dominant first-task-open latency.
      void import('@slayzone/task/client/TaskDetailDataLoader')
      // xterm chunk (~440KB) — first terminal panel mount lands warm.
      void import('@slayzone/terminal/client/Terminal')
      // material-file-icons (~500KB) — first FileIcon render lands warm.
      void import('@slayzone/icons').then((m) => m.loadFileIcons())
      // Optional task panels — each its own lazy chunk (see TaskDetailPage lazy imports).
      // Specifiers must match those lazy imports exactly so Vite dedupes to the same chunk.
      // Warm so revealing a panel the first time lands without a skeleton flash.
      void import('@slayzone/task-browser')
      void import('@slayzone/file-editor/client')
      void import('@slayzone/worktrees')
      void import('@slayzone/task-artifacts/client')
    })
    return () => {
      const cic = (window as unknown as { cancelIdleCallback?: (h: number) => void })
        .cancelIdleCallback
      if (cic) cic(handle)
      else clearTimeout(handle)
    }
  }, [])

  useEffect(() => {
    Promise.all([
      window.api.settings.get('onboarding_completed'),
      window.api.settings.get('tutorial_prompted')
    ]).then(([onboarded, prompted]) => {
      if (onboarded === 'true' && !prompted) {
        void window.api.settings.set('tutorial_prompted', 'true')
        toast('Want a quick tour?', {
          duration: 8000,
          action: { label: 'Take the tour', onClick: startTour }
        })
      }
    })
  }, [startTour])

  useEffect(() => {
    if (onboardingOpen) {
      setShouldMountOnboarding(true)
      return
    }

    let cancelled = false

    window.api.settings.get('onboarding_completed').then((value) => {
      if (!cancelled && value !== 'true') {
        setShouldMountOnboarding(true)
      }
    })

    return () => {
      cancelled = true
    }
  }, [onboardingOpen])

  // Usage, agent panel & agent-status panel state
  const { data: usageData, refresh: refreshUsage } = useUsage()
  const [globalAgentPanelState, setGlobalAgentPanelState] = useGlobalAgentPanelState()
  const [agentStatusState, setAgentStatusState] = useAgentStatusState()
  const [isSidePanelResizing, setIsSidePanelResizing] = useState(false)
  const globalAgentPanelMountedRef = useRef(false)
  if (globalAgentPanelState.isOpen) globalAgentPanelMountedRef.current = true
  const agentMode = globalAgentPanelState.mode ?? 'claude-code'
  useEffect(() => {
    if (globalAgentPanelState.mode) return
    window.api.settings.get('default_terminal_mode').then((m) => {
      if (m) setGlobalAgentPanelState({ mode: m })
    })
  }, [globalAgentPanelState.mode, setGlobalAgentPanelState])
  const columnsByProjectId = useMemo(() => {
    const map = new Map<string, ColumnConfig[] | null>()
    for (const p of projects) map.set(p.id, p.columns_config)
    return map
  }, [projects])
  const { idleTasks: rawIdleTasks } = useIdleTasks(tasks, null, columnsByProjectId)
  const shutdownAgentForTask = useCallback(async (taskId: string) => {
    const [ptys, chats] = await Promise.all([window.api.pty.list(), window.api.chat.list()])
    const ptyKills = ptys
      .filter((p) => p.taskId === taskId)
      .map((p) => window.api.pty.kill(p.sessionId))
    const chatKills = chats
      .filter((c) => c.taskId === taskId)
      .map((c) => {
        const idx = c.sessionId.indexOf(':')
        const tabId = idx >= 0 ? c.sessionId.slice(idx + 1) : c.sessionId
        return window.api.chat.kill(tabId)
      })
    await Promise.all([...ptyKills, ...chatKills])
  }, [])
  const [dismissedIdle, setDismissedIdle] = useState<Map<string, number>>(new Map())
  const handleDismissIdle = useCallback((sessionId: string) => {
    setDismissedIdle((prev) => {
      const next = new Map(prev)
      next.set(sessionId, Date.now())
      return next
    })
  }, [])
  const allIdleTasks = useMemo(
    () =>
      rawIdleTasks.filter((t) => {
        const at = dismissedIdle.get(t.sessionId)
        return at === undefined || t.lastOutputTime > at
      }),
    [rawIdleTasks, dismissedIdle]
  )
  const idleTasks = useMemo(
    () =>
      agentStatusState.filterCurrentProject
        ? allIdleTasks.filter((t) => t.task.project_id === selectedProjectId)
        : allIdleTasks,
    [allIdleTasks, agentStatusState.filterCurrentProject, selectedProjectId]
  )
  const idleByProject = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of allIdleTasks) m.set(t.task.project_id, (m.get(t.task.project_id) ?? 0) + 1)
    return m
  }, [allIdleTasks])

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  )

  // Project lock guard — single chokepoint for task-open paths. Resolves the task's
  // project from `tasks` state, or accepts a `projectOverride` for freshly-created
  // tasks not yet in state (closure lag from setTasks).
  const durationLocked = isProjectLocked(selectedProject)
  const guardTaskOpen = useCallback(
    (taskId: string, fn: (id: string) => void, projectOverride?: Project) => {
      const existing = useTabStore
        .getState()
        .tabs.some((t) => t.type === 'task' && t.taskId === taskId)
      if (existing) {
        fn(taskId)
        return
      }
      const taskProject =
        projectOverride ??
        (() => {
          const task = tasks.find((t) => t.id === taskId)
          return task ? projects.find((p) => p.id === task.project_id) : undefined
        })()
      if (taskProject && isProjectLocked(taskProject)) {
        toast(PROJECT_LOCKED_TOAST)
        return
      }
      if (taskProject && isRateLimited(taskProject)) {
        toast('Task limit reached — try again later')
        return
      }
      if (taskProject) recordTaskOpen(taskProject.id)
      fn(taskId)
    },
    [tasks, projects]
  )

  const openTask = useCallback(
    (taskId: string, projectOverride?: Project) => {
      guardTaskOpen(taskId, (id) => startTransition(() => rawOpenTask(id)), projectOverride)
    },
    [guardTaskOpen, rawOpenTask, startTransition]
  )

  const openTaskRef = useRef(openTask)
  openTaskRef.current = openTask

  // Tab management (declared early so IPC-listener refs below can close over closeTab)
  const closeTab = useCallback(
    (index: number): void => {
      const store = useTabStore.getState()
      const tab = store.tabs[index]
      if (tab?.type === 'task') {
        const task = store._taskLookup.tasks.find((t) => t.id === tab.taskId)
        if (task?.is_temporary) {
          window.api.pty.kill(`${tab.taskId}:${tab.taskId}`)
          window.api.db.deleteTask(tab.taskId)
          setTasks((prev) => prev.filter((t) => t.id !== tab.taskId))
        }
      }
      store.closeTab(index)
    },
    [setTasks]
  )

  const closeTabByTaskId = useCallback(
    (taskId: string): void => {
      const index = useTabStore
        .getState()
        .tabs.findIndex((t) => t.type === 'task' && t.taskId === taskId)
      if (index >= 0) closeTab(index)
    },
    [closeTab]
  )

  const goBack = useCallback((): void => {
    const { activeTabIndex: idx } = useTabStore.getState()
    if (idx > 0) closeTab(idx)
  }, [closeTab])

  // Stale-skill dot on Context Manager tab
  const { count: staleSkillCount, refresh: refreshStaleSkillCount } = useStaleSkillCount(
    selectedProjectId,
    selectedProject?.path ?? null
  )
  const prevContextViewRef = useRef(activeView === 'context')
  useEffect(() => {
    const wasContext = prevContextViewRef.current
    const isContext = activeView === 'context'
    // Refresh when leaving context manager view (Sync All may have run)
    if (wasContext && !isContext) refreshStaleSkillCount()
    prevContextViewRef.current = isContext
  }, [activeView, refreshStaleSkillCount])

  useEffect(() => {
    if (projects.length === 0) return
    if (!selectedProjectId || !projects.some((p) => p.id === selectedProjectId))
      setSelectedProjectId(projects[0].id)
  }, [projects, selectedProjectId, setSelectedProjectId])

  // Task lookup map (used for tab props and active-tab project switching)
  const tasksMap = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])

  // Visible tabs (project-scoped filtering — purely visual, full tabs stay mounted)
  const { visibleTabs, visibleActiveIndex, toFullIndex, toVisibleIndex } = useVisibleTabs(
    tabs,
    tasksMap
  )
  const visibleTaskCount = useMemo(
    () => visibleTabs.filter((t) => t.type === 'task').length,
    [visibleTabs]
  )

  // Auto-switch project when activating a task tab
  const activeTab = tabs[activeTabIndex]
  const activeTaskProjectId =
    activeTab?.type === 'task' ? tasksMap.get(activeTab.taskId)?.project_id : undefined

  // Broadcast primary's active task ID so secondary windows in "Follow current tab" mode swap
  useEffect(() => {
    const id = activeTab?.type === 'task' ? activeTab.taskId : null
    void window.api.taskWindow.setPrimaryActive(id)
  }, [activeTab])

  // Mark a task "read" (clear needs_attention) when the user *navigates into* it —
  // i.e. it becomes the active tab. Deliberately NOT cleared while the task merely
  // stays active: that is what lets "Mark as unread" stick even though the task is
  // on screen. Two refs handle the timing:
  //  - activatedTaskRef: id of the current activation. A change => a fresh open.
  //  - readConsumedRef: the id we've already issued the read-clear for this
  //    activation. Ensures a late tasksMap update (task data arriving after the tab
  //    switch) still clears exactly once, and a tasksMap update caused by a later
  //    "Mark as unread" does NOT re-clear it.
  const activatedTaskRef = useRef<string | null>(null)
  const readConsumedRef = useRef<string | null>(null)
  useEffect(() => {
    const activeTaskId = activeTab?.type === 'task' ? activeTab.taskId : null
    if (!activeTaskId) {
      activatedTaskRef.current = null
      return
    }
    // Fresh activation: reset the once-per-activation read guard.
    if (activeTaskId !== activatedTaskRef.current) {
      activatedTaskRef.current = activeTaskId
      readConsumedRef.current = null
    }
    if (readConsumedRef.current === activeTaskId) return
    const task = tasksMap.get(activeTaskId)
    if (!task) return // data not loaded yet — wait for the next tasksMap update
    readConsumedRef.current = activeTaskId
    if (task.needs_attention) {
      void window.api.db.updateTask({ id: activeTaskId, needsAttention: false }).catch(() => {})
    }
  }, [activeTab, tasksMap])
  useEffect(() => {
    if (activeTaskProjectId && activeTaskProjectId !== selectedProjectId)
      setSelectedProjectId(activeTaskProjectId)
  }, [activeTaskProjectId, selectedProjectId, setSelectedProjectId])

  // Read settings on mount and whenever settings change
  useEffect(() => {
    window.api.settings
      .get('project_color_tints_enabled')
      .then((v) => setColorTintsEnabled(v !== '0'))
    window.api.settings.get('show_context_manager').then((v) => setShowContextManager(v !== '0'))
    window.api.app.isTestsPanelEnabled().then(setTestsPanelEnabled)
  }, [settingsRevision])

  // Close context manager when hidden
  useEffect(() => {
    if (!showContextManager && useTabStore.getState().activeView === 'context')
      useTabStore.getState().setActiveView('tabs')
  }, [showContextManager])

  useEffect(() => {
    if (selectedProjectId) {
      const project = projects.find((p) => p.id === selectedProjectId)
      if (project) setProjectNameValue(project.name)
    }
  }, [selectedProjectId, projects])

  // Computed values
  const projectTasks = selectedProjectId
    ? tasks.filter((t) => t.project_id === selectedProjectId)
    : []
  const projectTags = selectedProjectId
    ? tags.filter((t) => t.project_id === selectedProjectId)
    : tags
  const displayTasks = applyFilters(projectTasks, filter, taskTags, selectedProject?.columns_config)
  const projectsMap = new Map(projects.map((p) => [p.id, p]))
  const createTaskDialogDraft = useMemo(
    () => ({ projectId: selectedProjectId || projects[0]?.id, ...createTaskDraft }),
    [selectedProjectId, projects, createTaskDraft]
  )

  const handleTaskTagsChange = async (taskId: string, tagIds: string[]) => {
    await window.api.taskTags.setTagsForTask(taskId, tagIds)
    setTaskTags((prev) => {
      const next = new Map(prev)
      next.set(taskId, tagIds)
      return next
    })
  }

  // Diagnostics (extracted — fire-and-forget side effects)
  useDiagnosticsSync({
    tabs,
    activeTabIndex,
    activeView,
    selectedProjectId,
    projects,
    tasks,
    displayTaskCount: displayTasks.length,
    projectPathMissing
  })

  // Global keyboard shortcuts (extracted — react-hotkeys + home-tab keydown listener)
  useAppShortcuts({
    projects,
    homePanel,
    selectedProjectId,
    tabs,
    activeTabIndex,
    visibleTabs,
    toFullIndex,
    toVisibleIndex,
    tabCycleOrder,
    setActiveTabIndex,
    setSelectedProjectId,
    reopenClosedTab,
    openTaskRef,
    undo,
    redo,
    zenMode,
    setZenMode,
    explodeMode,
    setExplodeMode,
    openTaskIds,
    globalAgentPanelState,
    setGlobalAgentPanelState,
    agentStatusState,
    setAgentStatusState,
    isHomePanelEnabled,
    testsPanelEnabled
  })

  // Shortcut display strings (reactive to user customization)
  const projectScopedTabs = useTabStore((s) => s.projectScopedTabs)
  const explodeModeShortcut = useShortcutDisplay('explode-mode')
  const zenModeShortcut = useShortcutDisplay('zen-mode')
  const projectTabsShortcut = useShortcutDisplay('toggle-project-tabs')
  const newTempTaskShortcut = useShortcutDisplay('new-temp-task')
  const panelGitShortcut = useShortcutDisplay('panel-git')
  const panelEditorShortcut = useShortcutDisplay('panel-editor')
  const panelProcessesShortcut = useShortcutDisplay('panel-processes')
  const panelTestsShortcut = useShortcutDisplay('panel-tests')
  const panelAutomationsShortcut = useShortcutDisplay('panel-automations')
  const globalAgentPanelShortcut = useShortcutDisplay('global-agent-panel')
  const agentStatusPanelShortcut = useShortcutDisplay('agent-status-panel')
  const agentSessionId = selectedProjectId
    ? `__global-agent-panel:${selectedProjectId}:${globalAgentPanelState.sessionIndex}`
    : null

  const handleAgentNewSession = useCallback(async () => {
    if (agentSessionId) await window.api.pty.kill(agentSessionId)
    setGlobalAgentPanelState({ sessionIndex: (globalAgentPanelState.sessionIndex ?? 0) + 1 })
  }, [agentSessionId, globalAgentPanelState.sessionIndex, setGlobalAgentPanelState])

  const handleAgentModeChange = useCallback(
    async (nextMode: string) => {
      if (nextMode === agentMode) return
      if (agentSessionId) await window.api.pty.kill(agentSessionId)
      setGlobalAgentPanelState({
        mode: nextMode,
        sessionIndex: (globalAgentPanelState.sessionIndex ?? 0) + 1
      })
    },
    [agentMode, agentSessionId, globalAgentPanelState.sessionIndex, setGlobalAgentPanelState]
  )

  // Floating agent panel: push context to main-process state machine.
  // All detach/reattach decisions happen in main; renderer just keeps ctx in sync.
  useEffect(() => {
    window.api.floatingGlobalAgentPanel.setSessionId(agentSessionId)
  }, [agentSessionId])
  useEffect(() => {
    window.api.floatingGlobalAgentPanel.setPanelOpen(globalAgentPanelState.isOpen)
  }, [globalAgentPanelState.isOpen])
  useEffect(() => {
    window.api.floatingGlobalAgentPanel.setEnabled(globalAgentPanelState.floatingEnabled)
  }, [globalAgentPanelState.floatingEnabled])

  // Subscribe to floating-global-agent-panel state for menu label + sidebar visibility.
  const [floatingGlobalAgentPanelState, setFloatingGlobalAgentPanelState] = useState<{
    kind: 'attached' | 'detached' | 'disabled'
    mode: 'auto' | 'manual' | null
  }>({ kind: 'attached', mode: null })
  useEffect(() => {
    window.api.floatingGlobalAgentPanel.getState().then((s) => {
      setFloatingGlobalAgentPanelState({
        kind: s.kind as 'attached' | 'detached' | 'disabled',
        mode: s.mode
      })
    })
    return window.api.floatingGlobalAgentPanel.onState((s) => {
      setFloatingGlobalAgentPanelState({
        kind: s.kind as 'attached' | 'detached' | 'disabled',
        mode: s.mode
      })
    })
  }, [])
  // Hide sidebar panel when manually detached (auto mode keeps panel visible to avoid layout flash).
  const hideSidebarPanel =
    floatingGlobalAgentPanelState.kind === 'detached' &&
    floatingGlobalAgentPanelState.mode === 'manual'

  // Main↔renderer IPC subscriptions (extracted — close/open/toggle/settings + browser view wiring)
  useAppIpcListeners({
    tabs,
    activeTabIndex,
    closeTab,
    guardTaskOpen,
    openTaskInBackground,
    openTaskRef,
    setActiveTabIndex,
    selectedProjectId,
    globalAgentPanelState,
    setGlobalAgentPanelState,
    agentStatusState,
    setAgentStatusState,
    setSettingsInitialTab,
    setSettingsInitialAiConfigSection,
    setSettingsOpen,
    projects,
    setProjectSettingsInitialTab,
    setProjectSettingsOnboardingProvider,
    setEditingProject,
    tasksMap
  })

  const handleCompleteTaskConfirm = async (): Promise<void> => {
    const activeTab = tabs[activeTabIndex]
    if (activeTab.type !== 'task') return
    const task = tasksMap.get(activeTab.taskId)
    if (!task) return
    const project = projectsMap.get(task.project_id)
    const doneStatus = getDoneStatus(project?.columns_config)
    const prevStatus = task.status
    await window.api.db.updateTask({ id: activeTab.taskId, status: doneStatus })
    updateTask({ ...task, status: doneStatus })
    closeTab(activeTabIndex)
    useDialogStore.getState().closeCompleteTaskDialog()
    if (prevStatus !== doneStatus) {
      pushUndo({
        label: `Completed "${task.title}"`,
        undo: async () => {
          await window.api.db.updateTask({ id: task.id, status: prevStatus })
          setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: prevStatus } : t)))
        },
        redo: async () => {
          await window.api.db.updateTask({ id: task.id, status: doneStatus })
          setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: doneStatus } : t)))
        }
      })
      toast(`Completed "${task.title}"`, { action: { label: 'Undo', onClick: () => void undo() } })
    }
  }

  // Scratch terminal
  const handleCreateScratchTerminal = useCallback(
    async (projectIdArg?: string): Promise<void> => {
      const projectId = projectIdArg ?? selectedProjectId
      if (!projectId) return
      if (durationLocked) {
        toast(PROJECT_LOCKED_TOAST)
        return
      }
      const project = projects.find((p) => p.id === projectId)
      const existing = tasks
        .filter((t) => t.project_id === projectId)
        .map((t) => t.title.match(/^Terminal (\d+)$/))
        .filter(Boolean)
        .map((m) => parseInt(m![1], 10))
      const next = existing.length > 0 ? Math.max(...existing) + 1 : 1
      const status = getDefaultStatus(project?.columns_config)
      const task = await window.api.db.createTask({
        projectId,
        title: `Terminal ${next}`,
        status,
        isTemporary: true
      })
      track('temporary_task_created')
      setTasks((prev) => [task, ...prev])
      setTerminalFocusRequests((prev) => ({ ...prev, [task.id]: (prev[task.id] ?? 0) + 1 }))
      const lookup = useTabStore.getState()._taskLookup
      useTabStore.setState({ _taskLookup: { ...lookup, tasks: [task, ...lookup.tasks] } })
      openTask(task.id, project)
    },
    [selectedProjectId, projects, tasks, setTasks, openTask, durationLocked]
  )

  // Expose a programmatic task-opener so domain UI (e.g. Manager sidebar) can open a task as a tab.
  useEffect(() => {
    ;(window as { __slayzone_openTask?: (taskId: string) => void }).__slayzone_openTask = (
      taskId: string
    ) => openTask(taskId)
    return () => {
      delete (window as { __slayzone_openTask?: (taskId: string) => void }).__slayzone_openTask
    }
  }, [openTask])

  useEffect(() => {
    return window.api.app.onNewTemporaryTask(() => {
      handleCreateScratchTerminal()
    })
  }, [handleCreateScratchTerminal])

  // Task handlers
  const handleTaskCreated = (task: Task): void => {
    setTasks((prev) => [task, ...prev])
    useDialogStore.getState().closeCreateTask()
  }

  const handleTaskCreatedAndOpen = (task: Task): void => {
    setTasks((prev) => [task, ...prev])
    useDialogStore.getState().closeCreateTask()
    setTerminalFocusRequests((prev) => ({ ...prev, [task.id]: (prev[task.id] ?? 0) + 1 }))
    const lookup = useTabStore.getState()._taskLookup
    useTabStore.setState({ _taskLookup: { ...lookup, tasks: [task, ...lookup.tasks] } })
    // Pass project override — guardTaskOpen can't resolve from stale `tasks` closure.
    openTask(
      task.id,
      projects.find((p) => p.id === task.project_id)
    )
  }

  const handleTerminalFocusRequestHandled = useCallback(
    (taskId: string, requestId: number): void => {
      setTerminalFocusRequests((prev) => {
        if ((prev[taskId] ?? 0) !== requestId) return prev
        const next = { ...prev }
        delete next[taskId]
        return next
      })
    },
    []
  )

  const handleTaskUpdated = (task: Task): void => {
    updateTask(task)
    useDialogStore.getState().closeEditTask()
  }

  const handleConvertTask = useCallback(
    async (task: Task): Promise<Task> => {
      const project = useTabStore
        .getState()
        ._taskLookup.projects.find((item) => item.id === task.project_id)
      const converted = await window.api.db.updateTask({
        id: task.id,
        title: 'Untitled task',
        status:
          getStatusByCategory('started', project?.columns_config) ??
          getDefaultStatus(project?.columns_config),
        isTemporary: false
      })
      updateTask(converted)
      return converted
    },
    [updateTask]
  )

  const handleTaskDeleted = (): void => {
    if (deletingTask) {
      deleteTask(deletingTask.id)
      useDialogStore.getState().closeDeleteTask()
    }
  }
  const handleTaskClick = (task: Task): void => {
    openTask(task.id)
  }
  const handleTaskMove = (taskId: string, newColumnId: string, targetIndex: number): void => {
    moveTask(taskId, newColumnId, targetIndex, getViewConfig(filter).groupBy)
  }
  const handleTaskBulkMove = (
    taskIds: string[],
    newColumnId: string,
    targetIndex: number
  ): void => {
    bulkMove(taskIds, newColumnId, targetIndex, getViewConfig(filter).groupBy)
  }
  const handleSidebarTaskMove = (
    taskId: string,
    newColumnId: string,
    targetIndex: number,
    groupBy: 'none' | 'status' | 'priority'
  ): void => {
    moveTask(taskId, newColumnId, targetIndex, groupBy)
  }

  useEffect(() => {
    ;(
      window as {
        __slayzone_moveTaskForTest?: (
          taskId: string,
          newColumnId: string,
          targetIndex: number
        ) => void
      }
    ).__slayzone_moveTaskForTest = handleTaskMove
    return () => {
      delete (
        window as {
          __slayzone_moveTaskForTest?: (
            taskId: string,
            newColumnId: string,
            targetIndex: number
          ) => void
        }
      ).__slayzone_moveTaskForTest
    }
  }, [handleTaskMove])

  // Project handlers
  const openProjectSettings = useCallback(
    (
      project: Project,
      options?: {
        initialTab?: ProjectSettingsTab
        integrationOnboardingProvider?: ProjectIntegrationOnboardingProvider | null
      }
    ): void => {
      setProjectSettingsInitialTab(options?.initialTab ?? 'general')
      setProjectSettingsOnboardingProvider(options?.integrationOnboardingProvider ?? null)
      setEditingProject(project)
    },
    []
  )

  const closeProjectSettings = useCallback((): void => {
    setEditingProject(null)
    setProjectSettingsInitialTab('general')
    setProjectSettingsOnboardingProvider(null)
  }, [])

  const { visibleAuthFailures, reconnectAuthFailure, dismissAuthFailures } = useAuthFailureBanner(
    editingProject,
    selectedProjectId,
    projects,
    openProjectSettings
  )

  const handleProjectCreated = (project: Project, context: ProjectCreationContext): void => {
    setProjects((prev) => [...prev, project])
    setSelectedProjectId(project.id)
    useDialogStore.getState().closeCreateProject()
    if (context.startMode === 'github' || context.startMode === 'linear')
      openProjectSettings(project, {
        initialTab: 'integrations',
        integrationOnboardingProvider: context.startMode
      })
  }

  const handleProjectUpdated = (project: Project): void => {
    updateProject(project)
    closeProjectSettings()
    validateProjectPath(project)
  }
  const handleProjectChanged = (project: Project): void => {
    updateProject(project)
    setEditingProject(project)
    validateProjectPath(project)
  }

  const handleProjectNameSave = async (): Promise<void> => {
    if (!selectedProjectId) return
    const trimmed = projectNameValue.trim()
    if (!trimmed) {
      const p = projects.find((p) => p.id === selectedProjectId)
      if (p) setProjectNameValue(p.name)
      return
    }
    const project = projects.find((p) => p.id === selectedProjectId)
    if (project && trimmed !== project.name) {
      try {
        const updated = await window.api.db.updateProject({
          id: selectedProjectId,
          name: trimmed,
          color: project.color
        })
        updateProject(updated)
      } catch {
        if (project) setProjectNameValue(project.name)
      }
    }
  }

  const handleProjectNameKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleProjectNameSave()
      projectNameInputRef.current?.blur()
    } else if (e.key === 'Escape') {
      const p = projects.find((p) => p.id === selectedProjectId)
      if (p) setProjectNameValue(p.name)
      projectNameInputRef.current?.blur()
    }
  }


  const handleProjectDeleted = (): void => {
    if (deletingProject) {
      if (editingProject?.id === deletingProject.id) closeProjectSettings()
      deleteProject(deletingProject.id, selectedProjectId, setSelectedProjectId)
      useDialogStore.getState().closeDeleteProject()
    }
  }
  const handleSidebarSelectProject = (projectId: string): void => {
    track('project_switched')
    useTabStore.getState().selectProject(projectId)
  }
  const handleOpenSettings = (): void => {
    setSettingsInitialTab('appearance')
    setSettingsInitialAiConfigSection(null)
    setSettingsOpen(true)
  }

  // Custom event listeners for settings
  useEffect(() => {
    const handleGlobal = (e: Event) => {
      const tab = (e as CustomEvent<string>).detail || 'appearance'
      setSettingsInitialTab(tab)
      setSettingsInitialAiConfigSection(null)
      setSettingsOpen(true)
    }
    const handleProject = (e: Event) => {
      const { projectId, tab } = (e as CustomEvent<{ projectId: string; tab?: string }>).detail
      const project = projects.find((p) => p.id === projectId)
      if (project)
        openProjectSettings(project, { initialTab: (tab ?? 'general') as ProjectSettingsTab })
    }
    window.addEventListener('open-settings', handleGlobal)
    window.addEventListener('open-project-settings', handleProject)
    return () => {
      window.removeEventListener('open-settings', handleGlobal)
      window.removeEventListener('open-project-settings', handleProject)
    }
  }, [projects, openProjectSettings])

  const headerHidden = sidebarView === 'tree'
  // Tree view: align with the top icon row.
  // Projects rail: align horizontally with project cards + vertically with the
  //   TabBar (default x=10 sits near the rail's icon center at ~36px).
  useEffect(() => {
    const pos = sidebarView === 'tree' ? { x: 22, y: 20 } : { x: 9, y: 15 }
    window.api.window.setTrafficLightPosition(pos)
  }, [sidebarView])
  const activePtyCount = usePtyStatus().size
  const tabBarRightContent = (
    <div className="flex items-center gap-1">
      <BoostPill />
      <div className="w-4" />
      <UsagePopover data={usageData} onRefresh={refreshUsage} />
      <div className="w-4" />
      <AppHeaderActions
        compact
        projectScopedTabs={projectScopedTabs}
        projectTabsShortcut={projectTabsShortcut}
        zenMode={zenMode}
        setZenMode={setZenMode}
        zenModeShortcut={zenModeShortcut}
        explodeMode={explodeMode}
        setExplodeMode={setExplodeMode}
        explodeModeShortcut={explodeModeShortcut}
        openTaskIds={openTaskIds}
        selectedProjectId={selectedProjectId}
        durationLocked={durationLocked}
        handleCreateScratchTerminal={handleCreateScratchTerminal}
        newTempTaskShortcut={newTempTaskShortcut}
        agentStatusState={agentStatusState}
        setAgentStatusState={setAgentStatusState}
        attentionTaskIds={attentionTaskIds}
        agentStatusPanelShortcut={agentStatusPanelShortcut}
        globalAgentPanelState={globalAgentPanelState}
        setGlobalAgentPanelState={setGlobalAgentPanelState}
        globalAgentPanelShortcut={globalAgentPanelShortcut}
        updateVersion={updateVersion}
        updateDownloadPercent={updateDownloadPercent}
      />
    </div>
  )
  const compactFooterContent = (
    <CompactFooter
      usageData={usageData}
      refreshUsage={refreshUsage}
      handleOpenSettings={handleOpenSettings}
      explodeMode={explodeMode}
      setExplodeMode={setExplodeMode}
      openTaskIds={openTaskIds}
      activePtyCount={activePtyCount}
      globalAgentPanelState={globalAgentPanelState}
      setGlobalAgentPanelState={setGlobalAgentPanelState}
      selectedProjectId={selectedProjectId}
      agentStatusState={agentStatusState}
      setAgentStatusState={setAgentStatusState}
      idleTasks={idleTasks}
      sidebarView={sidebarView}
      sidebarAutoHide={sidebarAutoHide}
      updateVersion={updateVersion}
    />
  )

  return (
    <AppearanceProvider settingsRevision={settingsRevision}>
      <SidebarProvider defaultOpen={true}>
        <div id="app-shell" className="h-full w-full flex">
          <AppSidebar
            projects={projects}
            projectGroups={projectGroups}
            tasks={tasks}
            selectedProjectId={selectedProjectId}
            onSelectProject={handleSidebarSelectProject}
            onProjectSettings={(project) => openProjectSettings(project)}
            onSettings={handleOpenSettings}
            onLeaderboard={() => {
              useTabStore.getState().setActiveView('leaderboard')
            }}
            onUsageAnalytics={() => {
              useTabStore.getState().setActiveView('usage-analytics')
            }}
            onTaskClick={openTask}
            onCloseTab={closeTabByTaskId}
            onOpenTaskInBackground={(id) => useTabStore.getState().openTaskInBackground(id)}
            onCreateTemporaryTask={(projectId) => {
              void handleCreateScratchTerminal(projectId)
            }}
            zenMode={zenMode}
            onboardingChecklist={onboardingChecklist}
            idleByProject={idleByProject}
            onReorderProjects={reorderProjects}
            onCreateProjectGroup={createProjectGroup}
            onCreateFolderWithProjects={createFolderWithProjects}
            onRenameProjectGroup={renameProjectGroup}
            onDeleteProjectGroup={deleteProjectGroup}
            onSetGroupCollapsed={setGroupCollapsed}
            onReorderTopLevel={reorderTopLevel}
            onMoveProjectToGroup={moveProjectToGroup}
            onReorderProjectsInGroup={reorderProjectsInGroup}
            onTaskReorder={reorderTasks}
            onTaskMove={handleSidebarTaskMove}
            onTaskReparent={reparentTask}
            onTaskBulkReparent={bulkReparent}
            onTaskFieldUpdate={(taskId, updates) => {
              void rawContextMenuUpdate(taskId, updates)
            }}
            onTaskBulkFieldUpdate={(taskIds, updates) => {
              void rawBulkContextMenuUpdate(taskIds, updates)
            }}
            onSetTasksPinned={setTasksPinned}
            onSetCollapsed={setTaskCollapsed}
            onPinnedReorder={reorderPinnedTasks}
            taskProgress={taskProgress}
            doneTaskIds={doneTaskIds}
            columnsByProjectId={columnsByProjectId}
            compactFooter={headerHidden ? compactFooterContent : undefined}
            updateState={
              updateDownloadPercent != null
                ? { phase: 'downloading', percent: updateDownloadPercent, version: updateVersion }
                : updateVersion
                  ? {
                      phase: 'ready',
                      version: updateVersion,
                      onRestart: () => window.api.app.restartForUpdate()
                    }
                  : null
            }
            taskContextMenuRender={(task, child) => (
              <TaskContextMenu
                task={task}
                projects={projects}
                columns={columnsByProjectId.get(task.project_id) ?? null}
                tags={tags.filter((t) => t.project_id === task.project_id)}
                taskTagIds={taskTags.get(task.id) ?? []}
                isBlocked={blockedTaskIds.has(task.id)}
                onUpdateTask={contextMenuUpdate}
                onArchiveTask={archiveTask}
                onDeleteTask={deleteTask}
                onTaskTagsChange={handleTaskTagsChange}
                onTagCreated={(tag) => setTags((prev) => [...prev, tag])}
                onShutdownAgent={
                  activeAgentTaskIds.has(task.id) ? () => shutdownAgentForTask(task.id) : undefined
                }
                isPinned={!!task.pinned}
                onTogglePin={() => setTaskPinned(task.id, !task.pinned)}
                canMarkUnread={
                  useTerminalStateStore.getState().byId[`${task.id}:${task.id}`] === 'idle' &&
                  !task.needs_attention
                }
              >
                {child}
              </TaskContextMenu>
            )}
            taskBulkContextMenuRender={(taskIds, child) => {
              const idSet = new Set(taskIds)
              const selectedTasks = tasks.filter((t) => idSet.has(t.id))
              const firstProjectId = selectedTasks[0]?.project_id
              const allSameProject =
                !!firstProjectId && selectedTasks.every((t) => t.project_id === firstProjectId)
              return (
                <BulkTaskContextMenu
                  taskIds={taskIds}
                  tasks={selectedTasks}
                  projects={projects}
                  columns={allSameProject ? (columnsByProjectId.get(firstProjectId) ?? null) : null}
                  tags={allSameProject ? tags.filter((t) => t.project_id === firstProjectId) : []}
                  taskTagsMap={taskTags}
                  onBulkUpdate={bulkContextMenuUpdate}
                  onBulkArchive={archiveTasks}
                  onBulkDelete={bulkDelete}
                  onTaskTagsChange={handleTaskTagsChange}
                >
                  {child}
                </BulkTaskContextMenu>
              )
            }}
          />

          <div
            id="right-column"
            className={`relative flex-1 flex min-w-0 bg-sidebar pb-2 pr-2 ${headerHidden ? 'pt-2' : ''} ${zenMode || sidebarAutoHide ? 'pl-2' : ''}`}
          >
            {headerHidden && (
              <div aria-hidden className="absolute inset-x-0 top-0 h-2 window-drag-region" />
            )}
            <div id="right-main" className="flex-1 flex flex-col min-w-0 min-h-0">
              {!headerHidden && (
                <div className={zenMode || sidebarAutoHide ? 'pl-16' : ''}>
                  <TabBar
                    hideTabs={explodeMode}
                    tabs={visibleTabs}
                    activeIndex={visibleActiveIndex}
                    activeView={activeView}
                    projectColors={taskProjectColors}
                    worktreeColors={taskWorktreeColors}
                    taskProgress={taskProgress}
                    doneTaskIds={doneTaskIds}
                    attentionTaskIds={attentionTaskIds}
                    onTabClick={(i) => setActiveTabIndex(toFullIndex(i))}
                    onTabClose={(i) => closeTab(toFullIndex(i))}
                    onTabReorder={(from, to) => reorderTabs(toFullIndex(from), toFullIndex(to))}
                    onTabRename={async (taskId, title) => {
                      const t = await window.api.db.updateTask({ id: taskId, title })
                      updateTask(t)
                    }}
                    leftContent={
                      showContextManager || explodeMode ? (
                        <>
                          {showContextManager && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div
                                  className={cn(
                                    'relative ml-1 flex items-center gap-1.5 h-7 px-3 rounded-md cursor-pointer transition-colors select-none flex-shrink-0',
                                    'hover:bg-accent/80 dark:hover:bg-accent/50',
                                    'border',
                                    activeView === 'context'
                                      ? 'bg-tab-active border-border'
                                      : 'border-transparent text-muted-foreground dark:text-muted-foreground'
                                  )}
                                  onClick={() =>
                                    useTabStore
                                      .getState()
                                      .setActiveView(activeView === 'context' ? 'tabs' : 'context')
                                  }
                                >
                                  <BookOpen className="size-3.5" />
                                  {staleSkillCount > 0 && (
                                    <span
                                      aria-label={`${staleSkillCount} stale skill${staleSkillCount === 1 ? '' : 's'}`}
                                      data-testid="context-manager-stale-dot"
                                      className="absolute top-1 right-1 w-2 h-2 rounded-full bg-amber-500"
                                    />
                                  )}
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" className="text-xs">
                                {staleSkillCount > 0
                                  ? `Context Manager (${staleSkillCount} stale)`
                                  : 'Context Manager'}
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {explodeMode && (
                            <div className="ml-2 text-sm text-muted-foreground select-none flex-shrink-0">
                              {visibleTaskCount} {visibleTaskCount === 1 ? 'task' : 'tasks'}
                            </div>
                          )}
                        </>
                      ) : undefined
                    }
                    rightContent={tabBarRightContent}
                  />
                </div>
              )}

              <div id="content-wrapper" className="flex-1 min-h-0 flex">
                <div
                  id="main-area"
                  // No padding in normal mode: each content region owns its own 16px
                  // frame (TaskDetailPage's header/#task-panels, #home-detail below), so
                  // the focused-panel glow renders INSIDE its scroll box instead of being
                  // cropped here. Explode keeps p-4 (its minis frame themselves).
                  className={cn(
                    'flex-1 min-w-0 min-h-0 rounded-lg bg-surface-0 flex flex-col overflow-hidden gap-2',
                    explodeMode ? 'p-4' : ''
                  )}
                >
                  {visibleAuthFailures.length > 0 ? (
                    <div
                      data-testid="integrations-auth-failure-banner"
                      // Owns its 16px frame in normal mode (mirrors #main-area's
                      // `explodeMode ? 'p-4' : ''`); explode already pads via p-4.
                      className={cn(
                        'flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive',
                        !explodeMode && 'mx-4 mt-4'
                      )}
                    >
                      <AlertTriangle className="size-3.5 shrink-0" />
                      <button
                        type="button"
                        onClick={reconnectAuthFailure}
                        className="flex-1 text-left hover:underline"
                        title={visibleAuthFailures
                          .map((f) => `${f.connection.provider}: ${f.connection.auth_error ?? ''}`)
                          .join('\n')}
                      >
                        {visibleAuthFailures.length === 1
                          ? `${visibleAuthFailures[0].connection.provider.charAt(0).toUpperCase() + visibleAuthFailures[0].connection.provider.slice(1)} authentication expired — click to reconnect`
                          : `${visibleAuthFailures.length} integrations need re-authentication — click to reconnect`}
                      </button>
                      <button
                        type="button"
                        onClick={dismissAuthFailures}
                        className="text-destructive/70 hover:text-destructive"
                        aria-label="Dismiss"
                      >
                        ×
                      </button>
                    </div>
                  ) : null}
                  <div className="flex-1 min-h-0 flex overflow-hidden">
                  <div
                    ref={explodeGridRef}
                    className={cn(
                      'flex-1 min-w-0 min-h-0 rounded-lg overflow-hidden relative',
                      explodeMode ? 'grid gap-1 p-1' : ''
                    )}
                    style={{
                      ...(explodeMode
                        ? (() => {
                            const MIN_CELL_W = 480
                            const widthCols =
                              explodeGridWidth > 0
                                ? Math.max(1, Math.floor(explodeGridWidth / MIN_CELL_W))
                                : Math.ceil(Math.sqrt(visibleTaskCount))
                            const cols = Math.max(1, Math.min(widthCols, visibleTaskCount))
                            const rows = Math.ceil(visibleTaskCount / cols)
                            return {
                              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                              gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`
                            }
                          })()
                        : undefined)
                    }}
                  >
                    {tabs.map((tab, i) => {
                      const isVisible = toVisibleIndex(i) >= 0
                      if (explodeMode && (tab.type !== 'task' || !isVisible)) return null
                      // Inactive tabs hide via `invisible` (visibility:hidden). CSS does not
                      // interpolate `visibility`, so a descendant carrying a `transition` (e.g.
                      // Button's `transition-all`) stays fully painted for the whole transition
                      // duration before snapping off — that was the "Turn into task" button
                      // lingering on tab switch. Hidden tabs are inert, so we also kill their
                      // descendant transitions (`[&_*]:transition-none!` below) → the hide is
                      // instant for every element, not just ones without a transition.
                      const isViewActive = activeView === 'tabs' && i === deferredActiveTabIndex
                      const isExplodeFocused =
                        explodeMode && tab.type === 'task' && focusedExplodeTaskId === tab.taskId
                      return (
                        <div
                          key={tab.type === 'home' ? 'home' : tab.taskId}
                          data-explode-task-id={
                            explodeMode && tab.type === 'task' ? tab.taskId : undefined
                          }
                          className={
                            explodeMode
                              ? cn(
                                  'rounded overflow-hidden border min-h-0 relative',
                                  isExplodeFocused
                                    ? 'border-primary/60 ring-2 ring-primary/40'
                                    : 'border-border'
                                )
                              : `absolute inset-0 ${!isViewActive ? 'invisible [&_*]:transition-none!' : 'z-10'}`
                          }
                          inert={!explodeMode && !isViewActive ? true : undefined}
                        >
                          {tab.type === 'home' ? (
                            <HomeDetail
                              durationLocked={durationLocked}
                              selectedProject={selectedProject}
                              selectedProjectId={selectedProjectId}
                              projects={projects}
                              updateProject={updateProject}
                              updateTask={updateTask}
                              projectNameInputRef={projectNameInputRef}
                              projectNameValue={projectNameValue}
                              setProjectNameValue={setProjectNameValue}
                              handleProjectNameSave={handleProjectNameSave}
                              handleProjectNameKeyDown={handleProjectNameKeyDown}
                              projectPathMissing={projectPathMissing}
                              handleFixProjectPath={handleFixProjectPath}
                              filter={filter}
                              setFilter={setFilter}
                              projectTags={projectTags}
                              homePanel={homePanel}
                              homePanelConfig={homePanelConfig}
                              isHomePanelEnabled={isHomePanelEnabled}
                              panelSizes={panelSizes}
                              updatePanelSizes={updatePanelSizes}
                              resetPanelSize={resetPanelSize}
                              testsPanelEnabled={testsPanelEnabled}
                              testGroupBy={testGroupBy}
                              homeResolvedRepo={homeResolvedRepo}
                              homeDetectedRepos={homeDetectedRepos}
                              homeSelectedProject={homeSelectedProject}
                              handleHomeRepoChange={handleHomeRepoChange}
                              isViewActive={isViewActive}
                              isHomeTabActive={tabs[activeTabIndex]?.type === 'home'}
                              tasks={tasks}
                              displayTasks={displayTasks}
                              taskTags={taskTags}
                              blockedTaskIds={blockedTaskIds}
                              handleTaskMove={handleTaskMove}
                              handleTaskBulkMove={handleTaskBulkMove}
                              reorderTasks={reorderTasks}
                              handleTaskClick={handleTaskClick}
                              handleTaskTagsChange={handleTaskTagsChange}
                              contextMenuUpdate={contextMenuUpdate}
                              bulkContextMenuUpdate={bulkContextMenuUpdate}
                              clearBlockers={clearBlockers}
                              archiveTask={archiveTask}
                              deleteTask={deleteTask}
                              bulkDelete={bulkDelete}
                              archiveTasks={archiveTasks}
                              activeAgentTaskIds={activeAgentTaskIds}
                              shutdownAgentForTask={shutdownAgentForTask}
                              globalAgentPanelState={globalAgentPanelState}
                              agentStatusState={agentStatusState}
                              openProjectSettings={openProjectSettings}
                              panelGitShortcut={panelGitShortcut}
                              panelEditorShortcut={panelEditorShortcut}
                              panelProcessesShortcut={panelProcessesShortcut}
                              panelTestsShortcut={panelTestsShortcut}
                              panelAutomationsShortcut={panelAutomationsShortcut}
                            />
                          ) : (
                            <Suspense fallback={<TaskShell />}>
                              <div className={explodeMode ? 'absolute inset-0' : 'h-full'}>
                                <TaskDetailDataLoader
                                  taskId={tab.taskId}
                                  task={tasksMap.get(tab.taskId) ?? null}
                                  project={
                                    projectsMap.get(tasksMap.get(tab.taskId)?.project_id ?? '') ??
                                    null
                                  }
                                  isActive={explodeMode || isViewActive}
                                  hasShortcutFocus={
                                    explodeMode ? focusedExplodeTaskId === tab.taskId : isViewActive
                                  }
                                  compact={explodeMode}
                                  zenMode={zenMode}
                                  onBack={goBack}
                                  onTaskUpdated={updateTask}
                                  onArchiveTask={archiveTask}
                                  onDeleteTask={deleteTask}
                                  onNavigateToTask={openTask}
                                  onConvertTask={handleConvertTask}
                                  onCloseTab={closeTabByTaskId}
                                  settingsRevision={settingsRevision}
                                  terminalFocusRequestId={terminalFocusRequests[tab.taskId] ?? 0}
                                  onTerminalFocusRequestHandled={handleTerminalFocusRequestHandled}
                                  isSidePanelResizing={isSidePanelResizing}
                                />
                              </div>
                            </Suspense>
                          )}
                        </div>
                      )
                    })}
                    {activeView === 'leaderboard' && (
                      <div className="absolute inset-0 z-20">
                        <Suspense fallback={null}>
                          <LeaderboardPage />
                        </Suspense>
                      </div>
                    )}
                    {activeView === 'usage-analytics' && (
                      <div className="absolute inset-0 z-20">
                        <Suspense fallback={null}>
                          <UsageAnalyticsPage onTaskClick={openTask} />
                        </Suspense>
                      </div>
                    )}
                    {activeView === 'context' && (
                      <div className="absolute inset-0 z-20">
                        <Suspense fallback={null}>
                          <ContextManagerPage
                            selectedProjectId={selectedProjectId}
                            projectPath={projects.find((p) => p.id === selectedProjectId)?.path}
                            projectName={projects.find((p) => p.id === selectedProjectId)?.name}
                            onBack={() => useTabStore.getState().setActiveView('tabs')}
                          />
                        </Suspense>
                      </div>
                    )}
                  </div>

                  <AppSidePanels
                    agentSessionId={agentSessionId}
                    globalAgentPanelMounted={globalAgentPanelMountedRef.current}
                    hideSidebarPanel={hideSidebarPanel}
                    globalAgentPanelState={globalAgentPanelState}
                    setGlobalAgentPanelState={setGlobalAgentPanelState}
                    isSidePanelResizing={isSidePanelResizing}
                    setIsSidePanelResizing={setIsSidePanelResizing}
                    projects={projects}
                    selectedProjectId={selectedProjectId}
                    agentMode={agentMode}
                    handleAgentNewSession={handleAgentNewSession}
                    handleAgentModeChange={handleAgentModeChange}
                    floatingState={floatingGlobalAgentPanelState.kind}
                    agentStatusState={agentStatusState}
                    setAgentStatusState={setAgentStatusState}
                    idleTasks={idleTasks}
                    openTask={openTask}
                    handleDismissIdle={handleDismissIdle}
                    columnsByProjectId={columnsByProjectId}
                  />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <AppDialogs
            shouldMount={shouldMount}
            createTaskOpen={createTaskOpen}
            handleTaskCreated={handleTaskCreated}
            handleTaskCreatedAndOpen={handleTaskCreatedAndOpen}
            createTaskDialogDraft={createTaskDialogDraft}
            projectTags={projectTags}
            setTags={setTags}
            editingTask={editingTask}
            handleTaskUpdated={handleTaskUpdated}
            deletingTask={deletingTask}
            handleTaskDeleted={handleTaskDeleted}
            createProjectOpen={createProjectOpen}
            handleProjectCreated={handleProjectCreated}
            editingProject={editingProject}
            closeProjectSettings={closeProjectSettings}
            projectSettingsInitialTab={projectSettingsInitialTab}
            testGroupBy={testGroupBy}
            setTestGroupBy={setTestGroupBy}
            projectSettingsOnboardingProvider={projectSettingsOnboardingProvider}
            setProjectSettingsOnboardingProvider={setProjectSettingsOnboardingProvider}
            handleProjectUpdated={handleProjectUpdated}
            handleProjectChanged={handleProjectChanged}
            deletingProject={deletingProject}
            handleProjectDeleted={handleProjectDeleted}
            groupSettingsTarget={groupSettingsTarget}
            renameProjectGroup={renameProjectGroup}
            deleteProjectGroup={deleteProjectGroup}
            settingsOpen={settingsOpen}
            setSettingsOpen={setSettingsOpen}
            setSettingsRevision={setSettingsRevision}
            settingsInitialTab={settingsInitialTab}
            setSettingsInitialTab={setSettingsInitialTab}
            settingsInitialAiConfigSection={settingsInitialAiConfigSection}
            setSettingsInitialAiConfigSection={setSettingsInitialAiConfigSection}
            searchOpen={searchOpen}
            tasks={tasks}
            projects={projects}
            closedTabs={closedTabs}
            openTaskTabs={tabs.filter(
              (t): t is Extract<typeof t, { type: 'task' }> => t.type === 'task'
            )}
            activeTaskId={(() => {
              const t = tabs[activeTabIndex]
              return t && t.type === 'task' ? t.taskId : null
            })()}
            openTask={openTask}
            setSelectedProjectId={setSelectedProjectId}
            setActiveTabIndex={setActiveTabIndex}
            handleCreateScratchTerminal={handleCreateScratchTerminal}
            selectedProjectId={selectedProjectId}
            globalAgentPanelState={globalAgentPanelState}
            setGlobalAgentPanelState={setGlobalAgentPanelState}
            handleOpenSettings={handleOpenSettings}
            shouldMountOnboarding={shouldMountOnboarding}
            onboardingOpen={onboardingOpen}
            markSetupGuideCompleted={markSetupGuideCompleted}
            startTour={startTour}
            showAnimatedTour={showAnimatedTour}
            changelogOpen={changelogOpen}
            autoChangelogOpen={autoChangelogOpen}
            dismissAutoChangelog={dismissAutoChangelog}
            lastSeenVersion={lastSeenVersion}
            completeTaskDialogOpen={completeTaskDialogOpen}
            handleCompleteTaskConfirm={handleCompleteTaskConfirm}
            updateToastDismissed={updateToastDismissed}
            updateVersion={updateVersion}
            setUpdateToastDismissed={setUpdateToastDismissed}
          />
        </div>
      </SidebarProvider>
    </AppearanceProvider>
  )
}

export default App
