import React, {
  Suspense,
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useTransition
} from 'react'
import { initShortcuts } from './shortcut-init'
import { AlertTriangle, BookOpen } from 'lucide-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  useTRPC,
  useTRPCClient,
  useSubscription,
  useFederationOrNull,
  getClientForHub,
  getHubIdForProject,
  useHubOwnershipStore
} from '@slayzone/transport/client'
import type { Task } from '@slayzone/task/shared'
import type { Project, ColumnConfig } from '@slayzone/projects/shared'
import {
  getDefaultStatus,
  getStatusByCategory,
  isCompletedStatus,
  resolveRepoPath
} from '@slayzone/projects/shared'
// Domains
import {
  useTasksData,
  useUndoableTaskActions,
  useCloseTaskTab,
  useReopenClosedTab,
  useCompleteAndCloseTask,
  useFilterState,
  useFilterStore,
  applyFilters,
  getViewConfig,
  useSnoozeWakeUp,
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
import { usePtyStatus } from '@slayzone/terminal/client'
// Shared
import { Tooltip, TooltipTrigger, TooltipContent, toast } from '@slayzone/ui'
import {
  SidebarProvider,
  cn,
  useUndo,
  useShortcutDisplay,
  useStableCallback,
  KeyRecorder
} from '@slayzone/ui'
import { AppSidebar } from '@slayzone/sidebar'
import { useChangelogAutoOpen, useOnboardingChecklist } from '@slayzone/onboarding'
import { useStaleSkillCount } from '@slayzone/ai-config/client/hooks'
import {
  useGlobalAgentPanelState,
  type FloatingStateKind,
  useIdleTasks,
  useActiveSessionTaskIds,
  useAgentStatusState
} from '@slayzone/agent-panels'
import { UsagePopover } from '@/components/usage/UsagePopover'
import { BoostPill } from '@/components/usage/BoostPill'
import { useUsage } from '@/components/usage/useUsage'
import { isConvexConfigured, useLeaderboardAuth } from '@/lib/convexAuth'
import { recordDiagnosticsTimeline } from '@/lib/diagnosticsClient'
import { FeedbackDialog } from '@slayzone/feedback/client'
import { WorkspaceDirPicker } from '@slayzone/file-editor/client/WorkspaceDirPicker'
// Extracted hooks (self-contained, clean interfaces)
import { useHomePanel } from '@slayzone/home/client'
import { useTabLifecycle } from '@/hooks/useTabLifecycle'
import { useTabColors } from '@/hooks/useTabColors'
import { useVisibleTabs } from '@/hooks/useVisibleTabs'
// Extracted shell: lazy components, types/constants, hooks, panels (see ./app-shell)
import {
  TabPanes,
  AppTabBar,
  ActiveTabSync,
  LeaderboardPage,
  UsageAnalyticsPage,
  ContextManagerPage,
  useLazyMounted,
  AppHeaderActions,
  CompactFooter,
  SidebarTaskContextMenu,
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

// Expose the stores for e2e tests. Same escape hatch the fork's HomeView uses:
// these keys are test-only, so they get an index-signature view of `window`
// rather than polluting the app's real Window type.
const testWindow = window as unknown as Record<string, unknown>
testWindow.__slayzone_tabStore ??= useTabStore
testWindow.__slayzone_dialogStore ??= useDialogStore
testWindow.__slayzone_filterStore ??= useFilterStore

/**
 * Idle-prefetch heavy chunks the user will likely hit soon. `import()` is cached,
 * so real usage then lands on a warm chunk.
 */
function prefetchLikelyChunks(): void {
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
}

function App(): React.JSX.Element {
  performance.mark('sz:app:render')
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const shouldMount = useLazyMounted()
  // Core data from domain hook
  const {
    tasks,
    projects,
    projectGroups,
    tags,
    taskTags,
    blockedTaskIds,
    hubIdByProject,
    hubIdByTask,
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
    setProjectStarred,
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
  // Deliberately no `activeTabIndex` here: a tab switch must not re-render App. What
  // depends on the active tab subscribes itself — AppTabBar, TabPanes, ActiveTabSync,
  // the search dialog — and handlers read it from the store when they fire.
  const activeView = useTabStore((s) => s.activeView)
  const sidebarAutoHide = useTabStore((s) => s.sidebarAutoHide)
  const sidebarView = useTabStore((s) => s.sidebarView)
  const selectedProjectId = useTabStore((s) => s.selectedProjectId)
  const setActiveTabIndex = useTabStore((s) => s.setActiveTabIndex)
  const setSelectedProjectId = useTabStore((s) => s.setSelectedProjectId)
  const rawOpenTask = useTabStore((s) => s.openTask)
  const openTaskInBackground = useTabStore((s) => s.openTaskInBackground)
  const reorderTabs = useTabStore((s) => s.reorderTabs)
  const [, startTransition] = useTransition()

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
  const restartForUpdate = useMutation(trpc.app.meta.restartForUpdate.mutationOptions())

  // Warm keystroke-triggered lazy chunks (Cmd+K palette) on idle → no blank gap on first open.
  useIdlePreload()

  // Home panel state (extracted — owns its own state fully)
  const homePanel = useHomePanel(selectedProjectId, panelSizes, homePanelConfig, orderedHomeIds)

  // Multi-hub federation: which hub owns the selected project (selection itself
  // stays a bare id). `local`-fallback when single-hub / not yet resolved.
  const fed = useFederationOrNull()
  const defaultHubId = fed?.defaultHubId ?? 'local'
  const selectedProjectHubId = useMemo(
    () => hubIdByProject.get(selectedProjectId) ?? defaultHubId,
    [hubIdByProject, selectedProjectId, defaultHubId]
  )
  // Path existence and repo detection used to be gated to the local hub, because
  // they ran against whichever hub the client was talking to and so said nothing
  // true about a project whose files live elsewhere. They now route to the computer
  // that owns the workspace, so the gate is gone — the answer is correct for
  // every hub. `selectedProjectHubId` remains for routing the queries themselves.

  // Multi-repo detection for home tab
  const homeSelectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId),
    [projects, selectedProjectId]
  )
  // Same data source as task git panel — flat list of project-root + child repos + recursive submodules.
  const { repos: homeViewableRepos } = useProjectRepos(
    homeSelectedProject?.path ?? null,
    null,
    homeSelectedProject?.id
  )
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
  const homeSelectedProjectId = homeSelectedProject?.id
  const handleHomeRepoChange = useCallback(
    (repoName: string) => {
      if (!homeSelectedProjectId) return
      trpcClient.projects.update
        .mutate({ id: homeSelectedProjectId, selectedRepo: repoName })
        .then((updated) => {
          updateProject(updated)
        })
    },
    [homeSelectedProjectId, updateProject, trpcClient]
  )

  // Project path validation (extracted — validates on select + window focus)
  const {
    projectPathMissing,
    validateProjectPath,
    handleFixProjectPath,
    fixPickerOpen,
    setFixPickerOpen,
    applyFixedPath
  } = useProjectPathGuard(selectedProjectId, projects, updateProject)

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
    useExplodeMode(openTaskIds)

  // Tab lifecycle (extracted — manages sync, cleanup, cache eviction; page views: ActiveTabSync)
  useTabLifecycle({
    tasks,
    projects,
    tabs,
    setTerminalFocusRequests,
    hubIdByProject,
    hubIdByTask
  })

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
    void trpcClient.app.shell.openExternal.mutate({ url: COMMUNITY_DISCORD_URL })
  }, [trpcClient])
  const handleChecklistFollowOnX = useCallback((): void => {
    void trpcClient.app.shell.openExternal.mutate({ url: COMMUNITY_X_URL })
  }, [trpcClient])

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
  // never blocks user input.
  useEffect(() => {
    const idle = (cb: () => void): number => {
      const ric = (
        window as unknown as {
          requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
        }
      ).requestIdleCallback
      return ric ? ric(cb, { timeout: 3000 }) : (setTimeout(cb, 1500) as unknown as number)
    }
    const handle = idle(prefetchLikelyChunks)
    return () => {
      const cic = (window as unknown as { cancelIdleCallback?: (h: number) => void })
        .cancelIdleCallback
      if (cic) cic(handle)
      else clearTimeout(handle)
    }
  }, [])

  useEffect(() => {
    Promise.all([
      trpcClient.settings.get.query({ key: 'onboarding_completed' }),
      trpcClient.settings.get.query({ key: 'tutorial_prompted' })
    ]).then(([onboarded, prompted]) => {
      if (onboarded === 'true' && !prompted) {
        void trpcClient.settings.set.mutate({ key: 'tutorial_prompted', value: 'true' })
        toast('Want a quick tour?', {
          duration: 8000,
          action: { label: 'Take the tour', onClick: startTour }
        })
      }
    })
  }, [startTour, trpcClient])

  useEffect(() => {
    if (onboardingOpen) {
      setShouldMountOnboarding(true)
      return
    }

    let cancelled = false

    trpcClient.settings.get.query({ key: 'onboarding_completed' }).then((value) => {
      if (!cancelled && value !== 'true') {
        setShouldMountOnboarding(true)
      }
    })

    return () => {
      cancelled = true
    }
  }, [onboardingOpen, trpcClient])

  // Usage, agent panel & agent-status panel state
  const { data: usageData, refresh: refreshUsage } = useUsage()
  const [globalAgentPanelState, setGlobalAgentPanelState] = useGlobalAgentPanelState()
  const [agentStatusState, setAgentStatusState] = useAgentStatusState()
  const [isSidePanelResizing, setIsSidePanelResizing] = useState(false)
  // Mount the global agent panel on first open, then keep it mounted.
  const [globalAgentPanelMounted, setGlobalAgentPanelMounted] = useState(false)
  if (globalAgentPanelState.isOpen && !globalAgentPanelMounted) setGlobalAgentPanelMounted(true)
  const agentMode = globalAgentPanelState.mode ?? 'claude-code'
  useEffect(() => {
    if (globalAgentPanelState.mode) return
    trpcClient.settings.get.query({ key: 'default_terminal_mode' }).then((m) => {
      if (m) setGlobalAgentPanelState({ mode: m })
    })
  }, [globalAgentPanelState.mode, setGlobalAgentPanelState, trpcClient])
  const columnsByProjectId = useMemo(() => {
    const map = new Map<string, ColumnConfig[] | null>()
    for (const p of projects) map.set(p.id, p.columns_config)
    return map
  }, [projects])
  const { idleTasks: rawIdleTasks } = useIdleTasks(tasks, null, columnsByProjectId)
  const shutdownAgentForTask = useCallback(
    async (taskId: string) => {
      const [ptys, chats] = await Promise.all([
        trpcClient.pty.list.query(),
        trpcClient.pty.chatList.query()
      ])
      const ptyKills = ptys
        .filter((p) => p.taskId === taskId)
        .map((p) => trpcClient.pty.kill.mutate({ sessionId: p.sessionId }))
      const chatKills = chats
        .filter((c) => c.taskId === taskId)
        .map((c) => {
          const idx = c.sessionId.indexOf(':')
          const tabId = idx >= 0 ? c.sessionId.slice(idx + 1) : c.sessionId
          return trpcClient.chat.kill.mutate({ tabId })
        })
      await Promise.all([...ptyKills, ...chatKills])
    },
    [trpcClient]
  )
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
  // Stable: it (and openTask below) reach every open task tab, and the task list it
  // reads changes constantly — a `tasks` dep would re-render all of them each time.
  const guardTaskOpen = useStableCallback(
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
    }
  )

  const openTask = useCallback(
    (taskId: string, projectOverride?: Project) => {
      guardTaskOpen(taskId, (id) => startTransition(() => rawOpenTask(id)), projectOverride)
    },
    [guardTaskOpen, rawOpenTask, startTransition]
  )

  // Tab management (declared early so IPC-listener refs below can close over closeTab).
  // Closing a temporary task's tab deletes the task on its owning hub.
  const { closeTab, closeTabByTaskId } = useCloseTaskTab(rawDeleteTask)
  // ⌘⇧T — restores a temporary task its close deleted before reopening the tab.
  const reopenClosedTab = useReopenClosedTab(updateTask)
  const completeAndCloseTask = useCompleteAndCloseTask(
    { tasks, projects, updateTask, closeTabByTaskId, openTask },
    { push: pushUndo, undo }
  )

  const goBack = useCallback((): void => {
    const { activeTabIndex: idx } = useTabStore.getState()
    if (idx > 0) closeTab(idx)
  }, [closeTab])

  // Convex/GitHub auth state, injected into the (now packaged) LeaderboardPage.
  const leaderboardAuth = useLeaderboardAuth()

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
  const { visibleTabs, toFullIndex, toVisibleIndex } = useVisibleTabs(tabs, tasksMap)
  const visibleTaskCount = useMemo(
    () => visibleTabs.filter((t) => t.type === 'task').length,
    [visibleTabs]
  )

  // Read settings on mount and whenever settings change
  useEffect(() => {
    trpcClient.settings.get
      .query({ key: 'project_color_tints_enabled' })
      .then((v) => setColorTintsEnabled(v !== '0'))
    trpcClient.settings.get
      .query({ key: 'show_context_manager' })
      .then((v) => setShowContextManager(v !== '0'))
    trpcClient.app.meta.isTestsPanelEnabled.query().then(setTestsPanelEnabled)
  }, [settingsRevision, trpcClient])

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
    await trpcClient.tags.setForTask.mutate({ taskId, tagIds })
    setTaskTags((prev) => {
      const next = new Map(prev)
      next.set(taskId, tagIds)
      return next
    })
  }

  // Global keyboard shortcuts (extracted — react-hotkeys + home-tab keydown listener)
  useAppShortcuts({
    projects,
    homePanel,
    selectedProjectId,
    visibleTabs,
    toFullIndex,
    toVisibleIndex,
    tabCycleOrder,
    setActiveTabIndex,
    setSelectedProjectId,
    reopenClosedTab,
    openTask,
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
    if (agentSessionId) await trpcClient.pty.kill.mutate({ sessionId: agentSessionId })
    setGlobalAgentPanelState({ sessionIndex: (globalAgentPanelState.sessionIndex ?? 0) + 1 })
  }, [agentSessionId, globalAgentPanelState.sessionIndex, setGlobalAgentPanelState, trpcClient])

  const handleAgentModeChange = useCallback(
    async (nextMode: string) => {
      if (nextMode === agentMode) return
      if (agentSessionId) await trpcClient.pty.kill.mutate({ sessionId: agentSessionId })
      setGlobalAgentPanelState({
        mode: nextMode,
        sessionIndex: (globalAgentPanelState.sessionIndex ?? 0) + 1
      })
    },
    [
      agentMode,
      agentSessionId,
      globalAgentPanelState.sessionIndex,
      setGlobalAgentPanelState,
      trpcClient
    ]
  )

  // Floating agent panel: push context to main-process state machine.
  // All detach/reattach decisions happen in main; renderer just keeps ctx in sync.
  useEffect(() => {
    void trpcClient.app.floatingAgent.setSessionId.mutate({ sessionId: agentSessionId })
  }, [agentSessionId, trpcClient])
  useEffect(() => {
    void trpcClient.app.floatingAgent.setPanelOpen.mutate({ isOpen: globalAgentPanelState.isOpen })
  }, [globalAgentPanelState.isOpen, trpcClient])
  useEffect(() => {
    void trpcClient.app.floatingAgent.setEnabled.mutate({
      enabled: globalAgentPanelState.floatingEnabled
    })
  }, [globalAgentPanelState.floatingEnabled, trpcClient])

  // Floating-global-agent-panel state for menu label + sidebar visibility.
  // Initial via getState query; live updates via the onState subscription (both
  // typed FloatingAgentState now — no client-side cast).
  // kind is narrowed from the typed payload's `string` to the panel's domain
  // union at this boundary (the meaningful values the UI branches on).
  const [floatingGlobalAgentPanelState, setFloatingGlobalAgentPanelState] = useState<{
    kind: FloatingStateKind
    mode: 'auto' | 'manual' | null
  }>({ kind: 'attached', mode: null })
  const floatingStateQuery = useQuery(trpc.app.floatingAgent.getState.queryOptions())
  useEffect(() => {
    if (floatingStateQuery.data) {
      setFloatingGlobalAgentPanelState({
        kind: floatingStateQuery.data.kind as FloatingStateKind,
        mode: floatingStateQuery.data.mode
      })
    }
  }, [floatingStateQuery.data])
  useSubscription(
    trpc.app.floatingAgent.onState.subscriptionOptions(undefined, {
      onData: (s) =>
        setFloatingGlobalAgentPanelState({ kind: s.kind as FloatingStateKind, mode: s.mode })
    })
  )

  // Embedded @slayzone/hub exhausted its restart backoff (slice 7).
  // Persistent toast (no auto-dismiss) — calm copy, since while the sidecar is
  // dark the app keeps running on the in-process server unaffected.
  useSubscription(
    trpc.notify.onEmbeddedServerFailed.subscriptionOptions(undefined, {
      onData: ({ attempts, message }) =>
        toast.error('Background server failed', {
          id: 'embedded-server-failed',
          duration: Infinity,
          description: `Gave up after ${attempts} restart attempts: ${message}. See Settings → Diagnostics for the server log.`
        })
    })
  )
  // Hide sidebar panel when manually detached (auto mode keeps panel visible to avoid layout flash).
  const hideSidebarPanel =
    floatingGlobalAgentPanelState.kind === 'detached' &&
    floatingGlobalAgentPanelState.mode === 'manual'

  // Main↔renderer IPC subscriptions (extracted — close/open/toggle/settings + browser view wiring)
  useAppIpcListeners({
    closeTab,
    guardTaskOpen,
    openTaskInBackground,
    openTask,
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
    const { tabs: currentTabs, activeTabIndex } = useTabStore.getState()
    const activeTab = currentTabs[activeTabIndex]
    if (activeTab?.type !== 'task') return
    await completeAndCloseTask(activeTab.taskId)
    useDialogStore.getState().closeCompleteTaskDialog()
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
      const createStart = performance.now()
      // The project can belong to any hub (the rail is a cross-hub union), and a
      // task INSERT is FK-bound to it — so create on the hub that owns it, then
      // record the new id's hub before openTask scopes its tab.
      const projectHubId = getHubIdForProject(projectId)
      const task = await getClientForHub(projectHubId, trpcClient).task.create.mutate({
        projectId,
        title: `Terminal ${next}`,
        status,
        isTemporary: true,
        // Opened right below — lets the hub hand it the project's warm agent.
        openAfterCreate: true
      })
      if (projectHubId) useHubOwnershipStore.getState().noteTaskHub(task.id, projectHubId)
      recordDiagnosticsTimeline('temp_task_created', {
        taskId: task.id,
        taskCreateMs: Math.round(performance.now() - createStart)
      })
      track('temporary_task_created')
      setTasks((prev) => [task, ...prev])
      setTerminalFocusRequests((prev) => ({ ...prev, [task.id]: (prev[task.id] ?? 0) + 1 }))
      const lookup = useTabStore.getState()._taskLookup
      useTabStore.setState({ _taskLookup: { ...lookup, tasks: [task, ...lookup.tasks] } })
      openTask(task.id, project)
    },
    [selectedProjectId, projects, tasks, setTasks, openTask, durationLocked, trpcClient]
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

  useSubscription(
    trpc.menu.onNewTemporaryTask.subscriptionOptions(undefined, {
      onData: () => {
        handleCreateScratchTerminal()
      }
    })
  )

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
      const converted = await trpcClient.task.update.mutate({
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
    [updateTask, trpcClient]
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

  // Test seam: the bulk context-menu actions (undoable wrappers, as the menu calls
  // them) + undo, so a multi-hub spec can drive a cross-hub selection directly.
  useEffect(() => {
    const w = window as { __slayzone_bulkTaskActionsForTest?: unknown }
    w.__slayzone_bulkTaskActionsForTest = {
      update: bulkContextMenuUpdate,
      archive: archiveTasks,
      delete: bulkDelete,
      undo
    }
    return () => {
      delete w.__slayzone_bulkTaskActionsForTest
    }
  }, [bulkContextMenuUpdate, archiveTasks, bulkDelete, undo])

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
        const updated = await trpcClient.projects.update.mutate({
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
  const handleSidebarSelectProject = (projectId: string, opts?: { home?: boolean }): void => {
    track('project_switched')
    useTabStore.getState().selectProject(projectId, opts)
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

  const renderHome = (isViewActive: boolean, isHomeTabActive: boolean): React.JSX.Element => (
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
      isHomeTabActive={isHomeTabActive}
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
  )

  const headerHidden = sidebarView === 'tree'
  // Tree view: align with the top icon row.
  // Projects rail: align horizontally with project cards + vertically with the
  //   TabBar (default x=10 sits near the rail's icon center at ~36px).
  useEffect(() => {
    const pos = sidebarView === 'tree' ? { x: 22, y: 20 } : { x: 9, y: 15 }
    void trpcClient.app.window.setTrafficLightPosition.mutate({ pos })
  }, [sidebarView, trpcClient])
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
            onSetWindowButtonVisibility={(v) =>
              void trpcClient.app.window.setWindowButtonVisibility.mutate({ visible: v })
            }
            convexConfigured={isConvexConfigured}
            feedbackSlot={<FeedbackDialog />}
            keyRecorder={KeyRecorder}
            sessionTaskIds={activeAgentTaskIds}
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
            onSetProjectStarred={setProjectStarred}
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
                      onRestart: () => restartForUpdate.mutate()
                    }
                  : null
            }
            taskContextMenuRender={(task, child) => (
              <SidebarTaskContextMenu
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
              >
                {child}
              </SidebarTaskContextMenu>
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
                  <AppTabBar
                    hideTabs={explodeMode}
                    tabs={visibleTabs}
                    toVisibleIndex={toVisibleIndex}
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
                      const t = await trpcClient.task.update.mutate({ id: taskId, title })
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
                      <TabPanes
                        tabs={tabs}
                        activeView={activeView}
                        explodeMode={explodeMode}
                        focusedExplodeTaskId={focusedExplodeTaskId}
                        toVisibleIndex={toVisibleIndex}
                        hubIdByTask={hubIdByTask}
                        defaultHubId={defaultHubId}
                        selectedProjectHubId={selectedProjectHubId}
                        tasksMap={tasksMap}
                        projectsMap={projectsMap}
                        zenMode={zenMode}
                        settingsRevision={settingsRevision}
                        terminalFocusRequests={terminalFocusRequests}
                        isSidePanelResizing={isSidePanelResizing}
                        renderHome={renderHome}
                        onBack={goBack}
                        onTaskUpdated={updateTask}
                        onArchiveTask={archiveTask}
                        onDeleteTask={deleteTask}
                        onNavigateToTask={openTask}
                        onConvertTask={handleConvertTask}
                        onCloseTab={closeTabByTaskId}
                        onTerminalFocusRequestHandled={handleTerminalFocusRequestHandled}
                      />
                      {activeView === 'leaderboard' && (
                        <div className="absolute inset-0 z-20">
                          <Suspense fallback={null}>
                            <LeaderboardPage auth={leaderboardAuth} />
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
                      globalAgentPanelMounted={globalAgentPanelMounted}
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

          <ActiveTabSync
            tabs={tabs}
            tasksMap={tasksMap}
            selectedProjectId={selectedProjectId}
            activeView={activeView}
            projects={projects}
            taskCount={tasks.length}
            displayTaskCount={displayTasks.length}
            projectPathMissing={projectPathMissing}
          />
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
            openTask={openTask}
            setSelectedProjectId={setSelectedProjectId}
            setActiveTabIndex={setActiveTabIndex}
            handleCreateScratchTerminal={handleCreateScratchTerminal}
            reopenClosedTab={reopenClosedTab}
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
          {/* Re-point a project whose directory has moved. Rendered here rather
              than inside the guard hook (a hook cannot render), and browsing the
              COMPUTER that owns the project — the native dialog it replaces browsed
              this desktop, so on a remote computer it returned a path that did not
              exist there. */}
          <WorkspaceDirPicker
            open={fixPickerOpen}
            onOpenChange={setFixPickerOpen}
            onSelect={(path) => void applyFixedPath(path)}
            target={{ projectId: selectedProjectId }}
            title="Select project directory"
            defaultPath={projects.find((p) => p.id === selectedProjectId)?.path ?? null}
          />
        </div>
      </SidebarProvider>
    </AppearanceProvider>
  )
}

export default App
