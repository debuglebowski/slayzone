import React, { Suspense, lazy, useState, useEffect, useRef, useMemo, useCallback, useTransition } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { AlertTriangle, LayoutGrid, TerminalSquare, GitBranch, FileCode, Cpu, Kanban, FlaskConical } from 'lucide-react'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import { getDefaultStatus, getDoneStatus } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
// Domains
import {
  KanbanBoard,
  KanbanListView,
  FilterBar,
  useTasksData,
  useUndoableTaskActions,
  useFilterState,
  applyFilters,
  getViewConfig,
  type Column
} from '@slayzone/tasks'
import { CreateTaskDialog, EditTaskDialog, DeleteTaskDialog, ProcessesPanel, ResizeHandle, usePanelSizes, usePanelConfig } from '@slayzone/task'
import { UnifiedGitPanel, type UnifiedGitPanelHandle, type GitTabId } from '@slayzone/worktrees'
import type { FileEditorViewHandle } from '@slayzone/file-editor/client'
import { QuickOpenDialog } from '@slayzone/file-editor/client/QuickOpenDialog'
import {
  CreateProjectDialog,
  ProjectSettingsDialog,
  DeleteProjectDialog,
  type ProjectCreationContext,
  type ProjectStartMode
} from '@slayzone/projects'
import { useTabStore, AppearanceProvider, type Tab } from '@slayzone/settings'
import { OnboardingDialog } from '@slayzone/onboarding'
import { TestPanel } from '@slayzone/test-panel'
import { track, trackShortcut } from '@slayzone/telemetry/client'
import { usePty } from '@slayzone/terminal/client'
import type { TerminalState } from '@slayzone/terminal/shared'
// Shared
import { SearchDialog } from '@/components/dialogs/SearchDialog'
import {
  Button,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Toaster,
  toast,
  UpdateToast
} from '@slayzone/ui'
import { SidebarProvider, cn, PanelToggle, projectColorBg, useUndo } from '@slayzone/ui'
import { AppSidebar } from '@/components/sidebar/AppSidebar'
import { ChangelogDialog } from '@/components/changelog/ChangelogDialog'
import { useChangelogAutoOpen } from '@/components/changelog/useChangelogAutoOpen'
import { TabBar } from '@/components/tabs/TabBar'
import { LeaderboardPage } from '@/components/leaderboard/LeaderboardPage'
import { UsageAnalyticsPage } from '@slayzone/usage-analytics/client'
import { recordDiagnosticsTimeline, updateDiagnosticsContext } from '@/lib/diagnosticsClient'
import {
  DesktopNotificationToggle,
  NotificationButton,
  NotificationSidePanel,
  useAttentionTasks,
  useNotificationState
} from '@/components/notifications'
import { UsagePopover } from '@/components/usage/UsagePopover'
import { useUsage } from '@/components/usage/useUsage'
import { useOnboardingChecklist } from '@/hooks/useOnboardingChecklist'
import { useHomePanelState } from '@/hooks/useHomePanelVisibility'
import { TaskShell } from '@slayzone/task/client/TaskShell'
import { taskDetailCache } from '@slayzone/task/client/taskDetailCache'

// Lazy-loaded: heavy components not needed for first paint (sub-path exports to avoid barrel pull-in)
const TaskDetailDataLoader = lazy(() => import('@slayzone/task/client/TaskDetailDataLoader').then(m => ({ default: m.TaskDetailDataLoader })))
const FileEditorView = lazy(() => import('@slayzone/file-editor/client/FileEditorView').then(m => ({ default: m.FileEditorView })))
const UserSettingsDialog = lazy(() => import('@slayzone/settings/client/UserSettingsDialog').then(m => ({ default: m.UserSettingsDialog })))
const TutorialAnimationModal = lazy(() => import('@/components/tutorial/TutorialAnimationModal').then(m => ({ default: m.TutorialAnimationModal })))

type HomePanel = 'kanban' | 'git' | 'editor' | 'processes' | 'tests'
type ProjectSettingsTab = 'general' | 'environment' | 'columns' | 'integrations' | 'ai-config' | 'tests'
type ProjectIntegrationOnboardingProvider = Exclude<ProjectStartMode, 'scratch'>
type GlobalAiConfigSection = 'providers' | 'instructions' | 'skill' | 'mcp' | 'files'
const HOME_PANEL_ORDER: HomePanel[] = ['kanban', 'git', 'editor', 'processes', 'tests']
const HOME_PANEL_SIZE_KEY: Record<HomePanel, string> = { kanban: 'kanban', git: 'diff', editor: 'editor', processes: 'processes', tests: 'tests' }
const HANDLE_WIDTH = 16
const COMMUNITY_DISCORD_URL = 'https://discord.gg/g7xPHXaU98'
const COMMUNITY_X_URL = 'https://x.com/debuglebowski'

function App(): React.JSX.Element {
  // Core data from domain hook
  const {
    tasks,
    projects,
    tags,
    taskTags,
    blockedTaskIds,
    setTasks,
    setProjects,
    setTags,
    updateTask,
    moveTask,
    reorderTasks,
    archiveTask: rawArchiveTask,
    archiveTasks: rawArchiveTasks,
    deleteTask: rawDeleteTask,
    contextMenuUpdate: rawContextMenuUpdate,
    updateProject,
    deleteProject
  } = useTasksData()

  // Undo/redo stack for destructive operations
  const { push: pushUndo, undo, redo } = useUndo()
  const {
    contextMenuUpdate,
    archiveTask,
    archiveTasks,
    deleteTask
  } = useUndoableTaskActions(
    { tasks, updateTask, setTasks, archiveTask: rawArchiveTask, archiveTasks: rawArchiveTasks, deleteTask: rawDeleteTask, contextMenuUpdate: rawContextMenuUpdate },
    { push: pushUndo, undo }
  )

  // View state (tabs + selected project, persisted via zustand)
  const tabs = useTabStore((s) => s.tabs)
  const activeTabIndex = useTabStore((s) => s.activeTabIndex)
  const selectedProjectId = useTabStore((s) => s.selectedProjectId)
  const { setActiveTabIndex, setSelectedProjectId, openTask: rawOpenTask, openTaskInBackground, reorderTabs, reopenClosedTab } = useTabStore.getState()
  // Wrap openTask in startTransition so React keeps showing the old tab
  // while the new TaskDetailDataLoader suspends (fetches data).
  const [, startTransition] = useTransition()
  const openTask = useCallback((taskId: string) => {
    startTransition(() => rawOpenTask(taskId))
  }, [rawOpenTask, startTransition])

  // Expose tab store for e2e tests (same pattern as __slayzone_refreshData)
  if (!(window as any).__slayzone_tabStore) (window as any).__slayzone_tabStore = useTabStore

  // Filter state (persisted per project)
  const [filter, setFilter] = useFilterState(selectedProjectId)
  // Dialog state
  const [createOpen, setCreateOpen] = useState(false)
  const [createTaskDefaults, setCreateTaskDefaults] = useState<{
    status?: Task['status']
    priority?: number
    dueDate?: string | null
  }>({})
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [deletingTask, setDeletingTask] = useState<Task | null>(null)
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [projectSettingsInitialTab, setProjectSettingsInitialTab] = useState<ProjectSettingsTab>('general')
  const [testGroupBy, setTestGroupBy] = useState<'none' | 'path' | 'label'>('none')
  const [projectSettingsOnboardingProvider, setProjectSettingsOnboardingProvider] =
    useState<ProjectIntegrationOnboardingProvider | null>(null)
  const [deletingProject, setDeletingProject] = useState<Project | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const [colorTintsEnabled, setColorTintsEnabled] = useState(true)
  const [testsPanelEnabled, setTestsPanelEnabled] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<string>('general')
  const [settingsInitialAiConfigSection, setSettingsInitialAiConfigSection] = useState<GlobalAiConfigSection | null>(null)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [autoChangelogOpen, dismissAutoChangelog] = useChangelogAutoOpen()
  const [searchOpen, setSearchOpen] = useState(false)
  const [completeTaskDialogOpen, setCompleteTaskDialogOpen] = useState(false)
  const [terminalFocusRequests, setTerminalFocusRequests] = useState<Record<string, number>>({})
  const [zenMode, setZenMode] = useState(false)
  const [explodeMode, setExplodeMode] = useState(false)
  const [panelSizes, updatePanelSizes, resetPanelSize] = usePanelSizes()
  const { isBuiltinEnabled: isHomePanelEnabled } = usePanelConfig()
  const [homePanelState, setHomePanelState] = useHomePanelState(selectedProjectId)
  const homePanelVisibility = homePanelState.visibility
  const setHomePanelVisibility = useCallback((updater: (prev: Record<HomePanel, boolean>) => Record<HomePanel, boolean>) => {
    let prev: Record<HomePanel, boolean> | undefined
    let next: Record<HomePanel, boolean> | undefined
    setHomePanelState(s => {
      prev = s.visibility
      next = updater(s.visibility)
      return { ...s, visibility: next }
    })
    for (const key of Object.keys(next!) as HomePanel[]) {
      if (next![key] !== prev![key]) track('panel_toggled', { panel: key, active: next![key], context: 'home' })
    }
  }, [setHomePanelState])
  const homeGitDefaultTab = homePanelState.gitTab as GitTabId
  const setHomeGitDefaultTab = useCallback((tab: GitTabId) => {
    setHomePanelState(s => ({ ...s, gitTab: tab }))
  }, [setHomePanelState])
  const homeGitPanelRef = useRef<UnifiedGitPanelHandle>(null)
  const homeEditorRef = useRef<FileEditorViewHandle>(null)
  const pendingHomeEditorFileRef = useRef<string | null>(null)
  const pendingHomeSearchToggleRef = useRef(false)
  const homeEditorRefCallback = useCallback((handle: FileEditorViewHandle | null) => {
    homeEditorRef.current = handle
    if (handle && pendingHomeEditorFileRef.current) {
      handle.openFile(pendingHomeEditorFileRef.current)
      pendingHomeEditorFileRef.current = null
    }
    if (handle && pendingHomeSearchToggleRef.current) {
      handle.toggleSearch()
      pendingHomeSearchToggleRef.current = false
    }
  }, [])
  const [homeQuickOpenVisible, setHomeQuickOpenVisible] = useState(false)
  const [homeContainerWidth, setHomeContainerWidth] = useState(0)
  const homeRoRef = useRef<ResizeObserver | null>(null)
  const homeContainerRef = useCallback((el: HTMLDivElement | null) => {
    homeRoRef.current?.disconnect()
    if (el) {
      homeRoRef.current = new ResizeObserver(([entry]) => setHomeContainerWidth(entry.contentRect.width))
      homeRoRef.current.observe(el)
    }
  }, [])

  const homeResolvedWidths = useMemo(() => {
    const visible = HOME_PANEL_ORDER.filter(id => homePanelVisibility[id])
    const handleCount = Math.max(0, visible.length - 1)
    const available = homeContainerWidth - handleCount * HANDLE_WIDTH
    const sizeOf = (id: HomePanel) => panelSizes[HOME_PANEL_SIZE_KEY[id]] ?? 'auto'
    const autoCount = visible.filter(id => sizeOf(id) === 'auto').length
    const fixedSum = visible.filter(id => sizeOf(id) !== 'auto').reduce((s, id) => s + (sizeOf(id) as number), 0)
    const autoWidth = autoCount > 0 ? Math.max(200, (available - fixedSum) / autoCount) : 0
    return Object.fromEntries(visible.map(id => [id, sizeOf(id) === 'auto' ? autoWidth : (sizeOf(id) as number)]))
  }, [homeContainerWidth, homePanelVisibility, panelSizes])
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)

  // Project path validation
  const [projectPathMissing, setProjectPathMissing] = useState(false)
  const validateProjectPath = useCallback(async (project: Project | undefined) => {
    if (!project?.path) {
      setProjectPathMissing(false)
      return
    }
    const fn = window.api.files?.pathExists
    if (typeof fn !== 'function') return
    const exists = await fn(project.path)
    setProjectPathMissing(!exists)
  }, [])

  // Inline project rename state
  const [projectNameValue, setProjectNameValue] = useState('')
  const projectNameInputRef = useRef<HTMLTextAreaElement>(null)

  // Terminal state tracking for tab indicators
  const ptyContext = usePty()
  const [terminalStates, setTerminalStates] = useState<Map<string, TerminalState>>(new Map())

  // Sync task/project data into tab store for worktree grouping + temp task detection
  useEffect(() => {
    useTabStore.setState({ _taskLookup: { tasks, projects } })
  }, [tasks, projects])

  // Evict cache entries when task tabs close (prevent memory leaks).
  const prevTabsRef = useRef(tabs)
  useEffect(() => {
    const prev = prevTabsRef.current
    prevTabsRef.current = tabs
    for (const tab of prev) {
      if (tab.type !== 'task') continue
      if (!tabs.some((t) => t.type === 'task' && t.taskId === tab.taskId)) {
        taskDetailCache.evict('taskDetail', tab.taskId)
      }
    }
  }, [tabs])

  const [showAnimatedTour, setShowAnimatedTour] = useState(false)
  const openTutorialModal = useCallback((): void => {
    setShowAnimatedTour(true)
  }, [])

  const handleChecklistCreateFirstProject = useCallback((): void => {
    setCreateProjectOpen(true)
  }, [])

  const handleChecklistCreateFirstTask = useCallback((): void => {
    if (projects.length === 0) return
    setCreateTaskDefaults({})
    setCreateOpen(true)
  }, [projects.length])

  const handleChecklistCheckLeaderboard = useCallback((): void => {
    const { tabs, setActiveTabIndex } = useTabStore.getState()
    const idx = tabs.findIndex((t) => t.type === 'leaderboard')
    if (idx >= 0) setActiveTabIndex(idx)
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
    onOpenSetupGuide: () => setOnboardingOpen(true),
    onStartTour: openTutorialModal,
    onCreateFirstProject: handleChecklistCreateFirstProject,
    onCreateFirstTask: handleChecklistCreateFirstTask,
    onCheckLeaderboard: handleChecklistCheckLeaderboard,
    onJoinCommunity: handleChecklistJoinCommunity,
    onFollowOnX: handleChecklistFollowOnX
  })

  // Prompt existing users who completed onboarding but never saw the tour toast
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

  // Usage & notification state
  const { data: usageData, refresh: refreshUsage } = useUsage()
  const [notificationState, setNotificationState] = useNotificationState()
  const { attentionTasks: allAttentionTasks, refresh: refreshAttentionTasks } = useAttentionTasks(
    tasks,
    null
  )
  const attentionTasks = useMemo(
    () => notificationState.filterCurrentProject
      ? allAttentionTasks.filter((at) => at.task.project_id === selectedProjectId)
      : allAttentionTasks,
    [allAttentionTasks, notificationState.filterCurrentProject, selectedProjectId]
  )
  const attentionByProject = useMemo(() => {
    const map = new Map<string, number>()
    for (const at of allAttentionTasks) {
      map.set(at.task.project_id, (map.get(at.task.project_id) ?? 0) + 1)
    }
    return map
  }, [allAttentionTasks])

  const previousProjectRef = useRef<string>(selectedProjectId)
  const previousActiveTabRef = useRef<string>('home')
  const previousNotificationLockedRef = useRef(notificationState.isLocked)
  const previousNotificationProjectFilterRef = useRef(notificationState.filterCurrentProject)

  // Get task IDs from open tabs
  const openTaskIds = useMemo(
    () => tabs.filter((t): t is { type: 'task'; taskId: string; title: string } => t.type === 'task').map((t) => t.taskId),
    [tabs]
  )

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  )

  useEffect(() => {
    if (projects.length === 0) return
    if (!selectedProjectId || !projects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(projects[0].id)
    }
  }, [projects, selectedProjectId, setSelectedProjectId])

  // Auto-switch project when activating a task tab
  const activeTab = tabs[activeTabIndex]
  const activeTaskProjectId =
    activeTab?.type === 'task'
      ? tasks.find((t) => t.id === activeTab.taskId)?.project_id
      : undefined
  useEffect(() => {
    if (activeTaskProjectId && activeTaskProjectId !== selectedProjectId) {
      setSelectedProjectId(activeTaskProjectId)
    }
  }, [activeTaskProjectId, selectedProjectId, setSelectedProjectId])

  // Map of taskId → project color for tab tinting
  const taskProjectColors = useMemo(() => {
    const map = new Map<string, string>()
    if (!colorTintsEnabled) return map
    for (const tab of tabs) {
      if (tab.type !== 'task') continue
      const task = tasks.find((t) => t.id === tab.taskId)
      if (!task?.project_id) continue
      const project = projects.find((p) => p.id === task.project_id)
      if (project?.color) map.set(tab.taskId, project.color)
    }
    return map
  }, [tabs, tasks, projects, colorTintsEnabled])

  // Map of taskId → worktree color for grouping indicator
  // Only active when a project has 2+ distinct worktrees among open tabs
  const WORKTREE_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16']
  const taskWorktreeColors = useMemo(() => {
    const map = new Map<string, string>()
    // Group open task tabs by project, using project path as fallback for tasks on main worktree
    const byProject = new Map<string, { taskId: string; effectivePath: string }[]>()
    for (const tab of tabs) {
      if (tab.type !== 'task') continue
      const task = tasks.find((t) => t.id === tab.taskId)
      if (!task?.project_id) continue
      const project = projects.find((p) => p.id === task.project_id)
      const effectivePath = task.worktree_path || project?.path
      if (!effectivePath) continue
      const group = byProject.get(task.project_id) ?? []
      group.push({ taskId: tab.taskId, effectivePath })
      byProject.set(task.project_id, group)
    }
    // Deterministic hash: same path always gets the same color
    const hashStr = (s: string): number => {
      let h = 0
      for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
      return Math.abs(h)
    }
    // For each project with 2+ distinct worktrees, assign colors with collision avoidance
    for (const entries of byProject.values()) {
      const distinctPaths = [...new Set(entries.map((e) => e.effectivePath))]
      if (distinctPaths.length < 2) continue
      const pathToColor = new Map<string, string>()
      const usedIndices = new Set<number>()
      for (const path of distinctPaths) {
        let idx = hashStr(path) % WORKTREE_COLORS.length
        while (usedIndices.has(idx) && usedIndices.size < WORKTREE_COLORS.length) idx = (idx + 1) % WORKTREE_COLORS.length
        usedIndices.add(idx)
        pathToColor.set(path, WORKTREE_COLORS[idx])
      }
      for (const entry of entries) {
        map.set(entry.taskId, pathToColor.get(entry.effectivePath)!)
      }
    }
    return map
  }, [tabs, tasks, projects])

  const tabCycleOrder = useMemo(() => {
    const homeIndex = tabs.findIndex((tab) => tab.type === 'home')
    const taskIndexes = tabs
      .map((tab, index) => (tab.type === 'task' ? index : -1))
      .filter((index) => index >= 0)

    const order: number[] = []
    if (homeIndex >= 0) order.push(homeIndex)
    order.push(...taskIndexes)
    return order
  }, [tabs])

  // Auto-disable explode mode when fewer than 2 task tabs
  useEffect(() => {
    if (openTaskIds.length < 2) setExplodeMode(false)
  }, [openTaskIds.length])

  // Subscribe to terminal state changes for open tabs
  useEffect(() => {
    const unsubscribes: (() => void)[] = []

    for (const taskId of openTaskIds) {
      // Main terminal sessionId format: taskId:taskId (matches useTaskTerminals.getSessionId)
      const mainSessionId = `${taskId}:${taskId}`

      // Initialize with current state
      const currentState = ptyContext.getState(mainSessionId)
      setTerminalStates((prev) => {
        const next = new Map(prev)
        next.set(taskId, currentState)
        return next
      })

      // Subscribe to changes
      const unsub = ptyContext.subscribeState(mainSessionId, (newState) => {
        setTerminalStates((prev) => {
          const next = new Map(prev)
          next.set(taskId, newState)
          return next
        })
      })
      unsubscribes.push(unsub)
    }

    // Cleanup closed tabs from state
    setTerminalStates((prev) => {
      const openSet = new Set(openTaskIds)
      const next = new Map(prev)
      for (const key of next.keys()) {
        if (!openSet.has(key)) next.delete(key)
      }
      return next
    })

    return () => unsubscribes.forEach((fn) => fn())
  }, [openTaskIds, ptyContext])

  // Auto-close temporary task tabs when their main terminal exits.
  useEffect(() => {
    const temporaryTaskTabs = tabs.filter((tab): tab is Extract<typeof tab, { type: 'task' }> =>
      tab.type === 'task' && !!tab.isTemporary
    )
    const unsubscribes = temporaryTaskTabs.map((tab) => {
      const mainSessionId = `${tab.taskId}:${tab.taskId}`
      const subscribedMode = tasks.find((task) => task.id === tab.taskId)?.terminal_mode
      return ptyContext.subscribeExit(mainSessionId, (exitCode) => {
        // Keep failed terminals visible for diagnosis; only auto-close on clean exit.
        if (exitCode !== 0) return
        // If mode changed since this subscription was created, this exit is stale
        // (e.g. user switched providers); don't auto-delete the temporary task.
        // TODO: Replace mode-compare heuristic with explicit PTY exit reasons.
        const latestMode = tasks.find((task) => task.id === tab.taskId)?.terminal_mode
        if (subscribedMode && latestMode && subscribedMode !== latestMode) return
        void window.api.db.deleteTask(tab.taskId).catch(() => {})
        setTasks((prev) => prev.filter((task) => task.id !== tab.taskId))
        useTabStore.getState().closeTabByTaskId(tab.taskId)
      })
    })

    return () => {
      unsubscribes.forEach((unsub) => unsub())
    }
  }, [tabs, tasks, ptyContext, setTasks])

  // Tab management — side-effect wrappers (store handles pure tab state)
  // Read tasks from _taskLookup (synced via useEffect) to keep these stable
  const closeTab = useCallback((index: number): void => {
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
  }, [setTasks])

  const closeTabByTaskId = useCallback((taskId: string): void => {
    const index = useTabStore.getState().tabs.findIndex((t) => t.type === 'task' && t.taskId === taskId)
    if (index >= 0) closeTab(index)
  }, [closeTab])

  const goBack = useCallback((): void => {
    const { activeTabIndex: idx } = useTabStore.getState()
    if (idx > 0) closeTab(idx)
  }, [closeTab])

  const handleTabClick = useCallback((index: number): void => {
    setActiveTabIndex(index)
  }, [setActiveTabIndex])

  // Track page views on tab switch (not on tab content changes)
  const prevTabIndexRef = useRef(-1)
  useEffect(() => {
    if (activeTabIndex === prevTabIndexRef.current) return
    prevTabIndexRef.current = activeTabIndex
    const tab = tabs[activeTabIndex]
    if (!tab) return
    if (tab.type === 'task') {
      track('$pageview', { $current_url: `/task/${tab.taskId}`, page: 'task', task_id: tab.taskId })
    } else {
      track('$pageview', { $current_url: `/${tab.type}`, page: tab.type })
    }
  }, [activeTabIndex, tabs])

  // Track whether task data has loaded at least once.
  // Before first load, tasks=[] is a loading state — don't remove tabs for "missing" tasks.
  const tasksLoadedRef = useRef(false)
  if (tasks.length > 0) tasksLoadedRef.current = true

  // Sync tab titles/status and remove tabs for deleted tasks.
  useEffect(() => {
    if (!tasksLoadedRef.current) return
    const taskIds = new Set(tasks.map((t) => t.id))
    const store = useTabStore.getState()
    const prev = store.tabs
    // Push removed task tabs to closed stack
    const removedTabs = prev.filter((tab): tab is Extract<Tab, { type: 'task' }> => tab.type === 'task' && !taskIds.has(tab.taskId))
    if (removedTabs.length > 0) {
      const newClosed = [...store.closedTabs, ...removedTabs]
      while (newClosed.length > 20) newClosed.shift()
      useTabStore.setState({ closedTabs: newClosed })
    }
    const filtered = prev.filter((tab) => tab.type !== 'task' || taskIds.has(tab.taskId))
    const newActive = filtered.length < prev.length ? Math.min(store.activeTabIndex, filtered.length - 1) : store.activeTabIndex
    const updated = filtered.map((tab) => {
      if (tab.type !== 'task') return tab
      const task = tasks.find((t) => t.id === tab.taskId)
      if (task) {
        const isSubTask = !!task.parent_id
        const isTemporary = !!task.is_temporary
        if (task.title !== tab.title || task.status !== tab.status || isSubTask !== tab.isSubTask || isTemporary !== tab.isTemporary) {
          return { ...tab, title: task.title, status: task.status, isSubTask, isTemporary }
        }
      }
      return tab
    })
    useTabStore.setState({ tabs: updated, activeTabIndex: newActive })
  }, [tasks])

  // Drop stale focus requests for tasks that no longer exist.
  useEffect(() => {
    const taskIds = new Set(tasks.map((t) => t.id))
    setTerminalFocusRequests((prev) => {
      let changed = false
      const next: Record<string, number> = {}
      for (const [id, requestId] of Object.entries(prev)) {
        if (taskIds.has(id)) next[id] = requestId
        else changed = true
      }
      return changed ? next : prev
    })
  }, [tasks])

  // Startup cleanup: delete orphaned temporary tasks (no open tab)
  const didCleanupRef = useRef(false)
  useEffect(() => {
    if (didCleanupRef.current || tasks.length === 0) return
    didCleanupRef.current = true
    const openTabTaskIds = new Set(
      tabs.filter((t): t is Extract<typeof t, { type: 'task' }> => t.type === 'task').map((t) => t.taskId)
    )
    for (const task of tasks) {
      if (task.is_temporary && !openTabTaskIds.has(task.id)) {
        window.api.pty.kill(`${task.id}:${task.id}`)
        window.api.db.deleteTask(task.id)
        setTasks((prev) => prev.filter((t) => t.id !== task.id))
      }
    }
  }, [tasks, tabs, setTasks])

  // Read color tints setting on mount and whenever settings change (same trigger as AppearanceProvider)
  useEffect(() => {
    window.api.settings.get('project_color_tints_enabled').then((v) => setColorTintsEnabled(v !== '0'))
    window.api.app.isTestsPanelEnabled().then(setTestsPanelEnabled)
  }, [settingsRevision])

  // Sync project name value
  useEffect(() => {
    if (selectedProjectId) {
      const project = projects.find((p) => p.id === selectedProjectId)
      if (project) setProjectNameValue(project.name)
    }
  }, [selectedProjectId, projects])

  // Validate selected project's path exists on disk
  useEffect(() => {
    validateProjectPath(projects.find((p) => p.id === selectedProjectId))
  }, [selectedProjectId, projects, validateProjectPath])

  // Re-check project path on window focus
  useEffect(() => {
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project?.path) return
    const handleFocus = (): void => { validateProjectPath(project) }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [selectedProjectId, projects, validateProjectPath])

  // Computed values
  const projectTasks = selectedProjectId
    ? tasks.filter((t) => t.project_id === selectedProjectId)
    : []
  const displayTasks = applyFilters(projectTasks, filter, taskTags, selectedProject?.columns_config)
  const projectsMap = new Map(projects.map((p) => [p.id, p]))

  useEffect(() => {
    const activeTab = tabs[activeTabIndex]
    updateDiagnosticsContext({
      activeTabIndex,
      activeTabType: activeTab?.type ?? 'unknown',
      activeTaskId: activeTab?.type === 'task' ? activeTab.taskId : null,
      openTaskTabs: tabs.filter((t) => t.type === 'task').length,
      selectedProjectId,
      selectedProjectName: projects.find((p) => p.id === selectedProjectId)?.name ?? null,
      taskCount: tasks.length,
      visibleTaskCount: displayTasks.length,
      notificationPanelLocked: notificationState.isLocked,
      notificationFilterCurrentProject: notificationState.filterCurrentProject,
      projectPathMissing
    })
  }, [
    activeTabIndex,
    tabs,
    selectedProjectId,
    projects,
    tasks.length,
    displayTasks.length,
    notificationState.isLocked,
    notificationState.filterCurrentProject,
    projectPathMissing
  ])

  useEffect(() => {
    if (previousProjectRef.current === selectedProjectId) return
    recordDiagnosticsTimeline('project_changed', {
      from: previousProjectRef.current,
      to: selectedProjectId
    })
    previousProjectRef.current = selectedProjectId
  }, [selectedProjectId])

  useEffect(() => {
    const activeTab = tabs[activeTabIndex]
    const nextTabKey =
      activeTab?.type === 'task'
        ? `task:${activeTab.taskId}`
        : activeTab?.type === 'leaderboard'
          ? 'leaderboard'
          : 'home'
    if (previousActiveTabRef.current === nextTabKey) return
    recordDiagnosticsTimeline('tab_changed', {
      from: previousActiveTabRef.current,
      to: nextTabKey,
      activeTabIndex
    })
    previousActiveTabRef.current = nextTabKey
  }, [tabs, activeTabIndex])

  useEffect(() => {
    if (previousNotificationLockedRef.current === notificationState.isLocked) return
    recordDiagnosticsTimeline('notification_lock_changed', {
      from: previousNotificationLockedRef.current,
      to: notificationState.isLocked
    })
    previousNotificationLockedRef.current = notificationState.isLocked
  }, [notificationState.isLocked])

  useEffect(() => {
    if (previousNotificationProjectFilterRef.current === notificationState.filterCurrentProject) return
    recordDiagnosticsTimeline('notification_filter_project_changed', {
      from: previousNotificationProjectFilterRef.current,
      to: notificationState.filterCurrentProject
    })
    previousNotificationProjectFilterRef.current = notificationState.filterCurrentProject
  }, [notificationState.filterCurrentProject])

  // Keyboard shortcuts
  useHotkeys('mod+n', (e) => {
    if (projects.length > 0) {
      e.preventDefault()
      trackShortcut('mod+n')
      setCreateOpen(true)
    }
  }, { enableOnFormTags: true })


  useHotkeys('mod+k', (e) => {
    e.preventDefault()
    trackShortcut('mod+k')
    setSearchOpen(true)
  }, { enableOnFormTags: true })

  // Undo / Redo
  useHotkeys('mod+z', async (e) => {
    const el = e.target as HTMLElement
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
    if (el.closest?.('.cm-editor') || el.closest?.('.xterm')) return
    e.preventDefault()
    const label = await undo()
    if (label) { track('undo_used'); toast(`Undid: ${label}`) }
  }, { enableOnFormTags: true })

  useHotkeys('mod+shift+z', async (e) => {
    const el = e.target as HTMLElement
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
    if (el.closest?.('.cm-editor') || el.closest?.('.xterm')) return
    e.preventDefault()
    const label = await redo()
    if (label) { track('redo_used'); toast(`Redid: ${label}`) }
  }, { enableOnFormTags: true })

  // Stable refs so IPC listeners don't need to re-subscribe on every render
  const closeActiveTaskRef = useRef<() => void>(() => {})
  closeActiveTaskRef.current = () => {
    const activeTab = tabs[activeTabIndex]
    if (activeTab?.type === 'task') closeTab(activeTabIndex)
    else void window.api.window.close()
  }
  const closeCurrentHomeRef = useRef<() => void>(() => {})
  closeCurrentHomeRef.current = () => {
    const activeTab = tabs[activeTabIndex]
    if (activeTab?.type === 'home') void window.api.window.close()
  }

  // Cmd+Shift+W: close active task tab (or window on home tab)
  useEffect(() => {
    return window.api.app.onCloseActiveTask(() => closeActiveTaskRef.current())
  }, [])

  // Cmd+W on home tab: close window (task tab cases handled in TaskDetailPage)
  useEffect(() => {
    return window.api.app.onCloseCurrent(() => closeCurrentHomeRef.current())
  }, [])

  useEffect(() => {
    return window.api.app.onCloseTask((taskId) => {
      useTabStore.getState().closeTabByTaskId(taskId)
    })
  }, [])

  useEffect(() => {
    return window.api.app.onOpenTask((taskId) => {
      useTabStore.getState().openTask(taskId)
    })
  }, [])

  useEffect(() => {
    return window.api.app.onGoHome(() => {
      const homeIndex = useTabStore.getState().tabs.findIndex((tab) => tab.type === 'home')
      if (homeIndex >= 0) setActiveTabIndex(homeIndex)
    })
  }, [])

  useEffect(() => {
    return window.api.app.onOpenSettings(() => {
      setSettingsInitialTab('general')
      setSettingsInitialAiConfigSection(null)
      setSettingsOpen(true)
    })
  }, [])

  useEffect(() => {
    return window.api.app.onOpenProjectSettings(() => {
      if (!selectedProjectId) return
      const project = projects.find((p) => p.id === selectedProjectId)
      if (!project) return
      setProjectSettingsInitialTab('general')
      setProjectSettingsOnboardingProvider(null)
      setEditingProject(project)
    })
  }, [selectedProjectId, projects])

  useEffect(() => {
    return window.api.app.onUpdateStatus((status) => {
      switch (status.type) {
        case 'checking':
          toast.loading('Checking for updates...', { id: 'update-check' })
          break
        case 'downloading':
          toast.loading(`Downloading update... ${status.percent}%`, { id: 'update-check' })
          break
        case 'downloaded':
          toast.dismiss('update-check')
          setUpdateVersion(status.version)
          break
        case 'not-available':
          toast.success('You\'re on the latest version', { id: 'update-check' })
          break
        case 'error':
          toast.dismiss('update-check')
          toast.error(`Update failed: ${status.message}`, { duration: 8000 })
          break
      }
    })
  }, [])

  useHotkeys('mod+1,mod+2,mod+3,mod+4,mod+5,mod+6,mod+7,mod+8,mod+9', (e) => {
    e.preventDefault()
    const num = parseInt(e.key, 10)
    if (num < tabs.length) setActiveTabIndex(num)
  }, { enableOnFormTags: true })

  useHotkeys('mod+shift+1,mod+shift+2,mod+shift+3,mod+shift+4,mod+shift+5,mod+shift+6,mod+shift+7,mod+shift+8,mod+shift+9', (e) => {
    e.preventDefault()
    const num = parseInt(e.code.replace('Digit', ''), 10)
    if (num > 0 && num <= projects.length) {
      setSelectedProjectId(projects[num - 1].id)
      setActiveTabIndex(0)
    }
  }, { enableOnFormTags: true })

  useHotkeys('ctrl+tab', (e) => {
    e.preventDefault()
    if (tabCycleOrder.length === 0) return
    const prev = useTabStore.getState().activeTabIndex
    const pos = tabCycleOrder.indexOf(prev)
    const current = pos >= 0 ? pos : 0
    setActiveTabIndex(tabCycleOrder[(current + 1) % tabCycleOrder.length])
  }, { enableOnFormTags: true })

  useHotkeys('ctrl+shift+tab', (e) => {
    e.preventDefault()
    if (tabCycleOrder.length === 0) return
    const prev = useTabStore.getState().activeTabIndex
    const pos = tabCycleOrder.indexOf(prev)
    const current = pos >= 0 ? pos : 0
    setActiveTabIndex(tabCycleOrder[(current - 1 + tabCycleOrder.length) % tabCycleOrder.length])
  }, { enableOnFormTags: true })

  useHotkeys('mod+shift+t', (e) => {
    e.preventDefault()
    track('tab_reopened')
    reopenClosedTab()
  }, { enableOnFormTags: true })

  useHotkeys('mod+shift+d', (e) => {
    e.preventDefault()
    const activeTab = tabs[activeTabIndex]
    if (activeTab.type === 'task') {
      setCompleteTaskDialogOpen(true)
    }
  }, { enableOnFormTags: true })

  useHotkeys('mod+j', (e) => {
    e.preventDefault()
    track('zen_mode_toggled')
    trackShortcut('mod+j')
    setZenMode(prev => !prev)
  }, { enableOnFormTags: true })

  useHotkeys('mod+shift+e', (e) => {
    e.preventDefault()
    if (openTaskIds.length >= 2) {
      track('explode_mode_toggled')
      trackShortcut('mod+shift+e')
      setExplodeMode(prev => !prev)
    }
  }, { enableOnFormTags: true })

  useHotkeys('escape', () => {
    if (explodeMode) setExplodeMode(false)
    else if (zenMode) setZenMode(false)
  }, { enableOnFormTags: true })

  // Home tab panel shortcuts: G=git, E=editor, O=processes (mirrors task shortcuts)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (tabs[activeTabIndex]?.type !== 'home') return
      if (!selectedProjectId) return
      if (!e.metaKey) return
      if ((e.target as HTMLElement)?.closest?.('.cm-editor')) return
      if (e.shiftKey) {
        if (e.key.toLowerCase() === 'f' && isHomePanelEnabled('editor', 'home')) {
          e.preventDefault()
          if (homeEditorRef.current) {
            if (!homePanelVisibility.editor) setHomePanelVisibility(prev => ({ ...prev, editor: true }))
            homeEditorRef.current.toggleSearch()
          } else {
            pendingHomeSearchToggleRef.current = true
            setHomePanelVisibility(prev => ({ ...prev, editor: true }))
          }
        } else if (e.key.toLowerCase() === 'g' && isHomePanelEnabled('git', 'home')) {
          e.preventDefault()
          if (!homePanelVisibility.git) {
            setHomeGitDefaultTab('changes')
            setHomePanelVisibility(prev => ({ ...prev, git: true }))
          } else if (homeGitPanelRef.current?.getActiveTab() === 'changes') {
            setHomePanelVisibility(prev => ({ ...prev, git: false }))
          } else {
            homeGitPanelRef.current?.switchToTab('changes')
          }
        }
        return
      }
      if (e.key === 'p' && isHomePanelEnabled('editor', 'home')) {
        e.preventDefault()
        setHomeQuickOpenVisible(true)
        return
      }
      if (e.key === 'g' && isHomePanelEnabled('git', 'home')) {
        e.preventDefault()
        if (!homePanelVisibility.git) {
          setHomeGitDefaultTab('general')
          setHomePanelVisibility(prev => ({ ...prev, git: true }))
        } else if (homeGitPanelRef.current?.getActiveTab() === 'general') {
          setHomePanelVisibility(prev => ({ ...prev, git: false }))
        } else {
          homeGitPanelRef.current?.switchToTab('general')
        }
      } else if (e.key === 'e' && isHomePanelEnabled('editor', 'home')) {
        e.preventDefault()
        setHomePanelVisibility(prev => ({ ...prev, editor: !prev.editor }))
      } else if (e.key === 'o' && import.meta.env.DEV && isHomePanelEnabled('processes', 'home')) {
        e.preventDefault()
        setHomePanelVisibility(prev => ({ ...prev, processes: !prev.processes }))
      } else if (e.key === 'u' && testsPanelEnabled && isHomePanelEnabled('tests', 'home')) {
        e.preventDefault()
        setHomePanelVisibility(prev => ({ ...prev, tests: !prev.tests }))
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [tabs, activeTabIndex, selectedProjectId, homePanelVisibility])

  const handleCompleteTaskConfirm = async (): Promise<void> => {
    const activeTab = tabs[activeTabIndex]
    if (activeTab.type !== 'task') return

    const task = tasks.find((item) => item.id === activeTab.taskId)
    if (!task) return
    const project = projects.find((item) => item.id === task.project_id)
    const doneStatus = getDoneStatus(project?.columns_config)
    const prevStatus = task.status
    await window.api.db.updateTask({ id: activeTab.taskId, status: doneStatus })
    updateTask({ ...task, status: doneStatus })
    closeTab(activeTabIndex)
    setCompleteTaskDialogOpen(false)

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
      toast(`Completed "${task.title}"`, {
        action: { label: 'Undo', onClick: () => void undo() }
      })
    }
  }

  // Scratch terminal (creates unnamed task with terminal mode)
  const handleCreateScratchTerminal = useCallback(async (): Promise<void> => {
    if (!selectedProjectId) return
    // Auto-title: "Terminal N" where N is next available
    const existing = tasks
      .filter((t) => t.project_id === selectedProjectId)
      .map((t) => t.title.match(/^Terminal (\d+)$/))
      .filter(Boolean)
      .map((m) => parseInt(m![1], 10))
    const next = existing.length > 0 ? Math.max(...existing) + 1 : 1
    const status = getDefaultStatus(selectedProject?.columns_config)
    const task = await window.api.db.createTask({
      projectId: selectedProjectId,
      title: `Terminal ${next}`,
      status,
      isTemporary: true
    })
    track('temporary_task_created')
    setTasks((prev) => [task, ...prev])
    setTerminalFocusRequests((prev) => ({ ...prev, [task.id]: (prev[task.id] ?? 0) + 1 }))
    // Eagerly sync new task into lookup so openTask can resolve title + worktree position
    const lookup = useTabStore.getState()._taskLookup
    useTabStore.setState({ _taskLookup: { ...lookup, tasks: [task, ...lookup.tasks] } })
    openTask(task.id)

  }, [selectedProjectId, selectedProject, tasks, setTasks, openTask])

  // Cmd+R: reload browser webview if focused, else reload app
  useEffect(() => {
    return window.api.app.onReloadBrowser(() => {
      const el = document.activeElement as HTMLElement | null
      const webview = el?.closest('[data-browser-panel]')?.querySelector('webview') as any
      if (webview?.reload) {
        webview.reload()
      } else {
        window.location.reload()
      }
    })
  }, [])

  useEffect(() => {
    return window.api.app.onNewTemporaryTask(() => {
      handleCreateScratchTerminal()
    })
  }, [handleCreateScratchTerminal])

  // Task handlers
  const handleTaskCreated = (task: Task): void => {
    setTasks((prev) => [task, ...prev])
    setCreateOpen(false)
    setCreateTaskDefaults({})

  }

  const handleTaskCreatedAndOpen = (task: Task): void => {
    setTasks((prev) => [task, ...prev])
    setCreateOpen(false)
    setCreateTaskDefaults({})
    setTerminalFocusRequests((prev) => ({ ...prev, [task.id]: (prev[task.id] ?? 0) + 1 }))
    // Eagerly sync new task into lookup so openTask can resolve title + worktree position
    const lookup = useTabStore.getState()._taskLookup
    useTabStore.setState({ _taskLookup: { ...lookup, tasks: [task, ...lookup.tasks] } })
    openTask(task.id)

  }

  const handleTerminalFocusRequestHandled = useCallback((taskId: string, requestId: number): void => {
    setTerminalFocusRequests((prev) => {
      if ((prev[taskId] ?? 0) !== requestId) return prev
      const next = { ...prev }
      delete next[taskId]
      return next
    })
  }, [])

  const handleCreateTaskFromColumn = (column: Column): void => {
    const defaults: typeof createTaskDefaults = {}
    const vc = getViewConfig(filter)
    if (vc.groupBy === 'status') {
      if (column.id !== '__unknown__') {
        defaults.status = column.id as Task['status']
      }
    } else if (vc.groupBy === 'priority') {
      const priority = parseInt(column.id.slice(1), 10)
      if (!isNaN(priority)) defaults.priority = priority
    } else if (vc.groupBy === 'due_date') {
      const today = new Date().toISOString().split('T')[0]
      if (column.id === 'today') {
        defaults.dueDate = today
      } else if (column.id === 'this_week') {
        const weekEnd = new Date(today)
        weekEnd.setDate(weekEnd.getDate() + 7)
        defaults.dueDate = weekEnd.toISOString().split('T')[0]
      } else if (column.id === 'overdue') {
        const yesterday = new Date(today)
        yesterday.setDate(yesterday.getDate() - 1)
        defaults.dueDate = yesterday.toISOString().split('T')[0]
      }
    }
    setCreateTaskDefaults(defaults)
    setCreateOpen(true)
  }

  const handleTaskUpdated = (task: Task): void => {
    updateTask(task)
    setEditingTask(null)
  }

  const handleConvertTask = useCallback(async (task: Task): Promise<Task> => {
    const project = useTabStore.getState()._taskLookup.projects.find((item) => item.id === task.project_id)
    const converted = await window.api.db.updateTask({
      id: task.id,
      title: 'Untitled task',
      status: getDefaultStatus(project?.columns_config),
      isTemporary: false
    })
    updateTask(converted)
    return converted
  }, [updateTask])

  const handleTaskDeleted = (): void => {
    if (deletingTask) {
      deleteTask(deletingTask.id)
      setDeletingTask(null)
    }
  }

  const handleTaskClick = (task: Task, e: { metaKey: boolean }): void => {
    if (e.metaKey) {
      openTaskInBackground(task.id)
    } else {
      openTask(task.id)
    }
  }

  const handleTaskMove = (taskId: string, newColumnId: string, targetIndex: number): void => {
    moveTask(taskId, newColumnId, targetIndex, getViewConfig(filter).groupBy)
  }

  const openProjectSettings = useCallback((
    project: Project,
    options?: {
      initialTab?: ProjectSettingsTab
      integrationOnboardingProvider?: ProjectIntegrationOnboardingProvider | null
    }
  ): void => {
    setProjectSettingsInitialTab(options?.initialTab ?? 'general')
    setProjectSettingsOnboardingProvider(options?.integrationOnboardingProvider ?? null)
    setEditingProject(project)
  }, [])

  const closeProjectSettings = useCallback((): void => {
    setEditingProject(null)
    setProjectSettingsInitialTab('general')
    setProjectSettingsOnboardingProvider(null)
  }, [])

  const openGlobalAiConfigFromProject = useCallback((section: GlobalAiConfigSection): void => {
    setSettingsInitialTab('ai-config')
    setSettingsInitialAiConfigSection(section)
    setSettingsOpen(true)
  }, [])

  // Project handlers
  const handleProjectCreated = (project: Project, context: ProjectCreationContext): void => {
    setProjects((prev) => [...prev, project])
    setSelectedProjectId(project.id)
    setCreateProjectOpen(false)
    if (context.startMode === 'github' || context.startMode === 'linear') {
      openProjectSettings(project, {
        initialTab: 'integrations',
        integrationOnboardingProvider: context.startMode
      })
    }
  }

  const handleProjectUpdated = (project: Project): void => {
    updateProject(project)
    closeProjectSettings()
    validateProjectPath(project)
  }

  const handleProjectNameSave = async (): Promise<void> => {
    if (!selectedProjectId) return
    const trimmed = projectNameValue.trim()
    if (!trimmed) {
      const project = projects.find((p) => p.id === selectedProjectId)
      if (project) setProjectNameValue(project.name)
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
      const project = projects.find((p) => p.id === selectedProjectId)
      if (project) setProjectNameValue(project.name)
      projectNameInputRef.current?.blur()
    }
  }

  const handleFixProjectPath = useCallback(async (): Promise<void> => {
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project) return
    const result = await window.api.dialog.showOpenDialog({
      title: 'Select Project Directory',
      defaultPath: project.path || undefined,
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return
    const updated = await window.api.db.updateProject({
      id: project.id,
      path: result.filePaths[0]
    })
    updateProject(updated)
    validateProjectPath(updated)
  }, [selectedProjectId, projects, updateProject, validateProjectPath])

  const handleProjectDeleted = (): void => {
    if (deletingProject) {
      deleteProject(deletingProject.id, selectedProjectId, setSelectedProjectId)
      setDeletingProject(null)
    }
  }

  const handleSidebarSelectProject = (projectId: string): void => {
    track('project_switched')
    setSelectedProjectId(projectId)
    setActiveTabIndex(0)
  }

  const handleOpenSettings = (): void => {
    setSettingsInitialTab('general')
    setSettingsInitialAiConfigSection(null)
    setSettingsOpen(true)
  }

  // Allow any component to open settings via custom events
  useEffect(() => {
    const handleGlobal = (e: Event) => {
      const tab = (e as CustomEvent<string>).detail || 'general'
      setSettingsInitialTab(tab)
      setSettingsInitialAiConfigSection(null)
      setSettingsOpen(true)
    }
    const handleProject = (e: Event) => {
      const { projectId, tab } = (e as CustomEvent<{ projectId: string; tab?: string }>).detail
      const project = projects.find(p => p.id === projectId)
      if (project) openProjectSettings(project, { initialTab: (tab ?? 'general') as ProjectSettingsTab })
    }
    window.addEventListener('open-settings', handleGlobal)
    window.addEventListener('open-project-settings', handleProject)
    return () => {
      window.removeEventListener('open-settings', handleGlobal)
      window.removeEventListener('open-project-settings', handleProject)
    }
  }, [projects, openProjectSettings])

  return (
    <AppearanceProvider settingsRevision={settingsRevision}>
    <SidebarProvider defaultOpen={true}>
      <div id="app-shell" className="h-full w-full flex">
        <AppSidebar
          projects={projects}
          tasks={tasks}
          selectedProjectId={selectedProjectId}
          onSelectProject={handleSidebarSelectProject}
          onAddProject={() => setCreateProjectOpen(true)}
          onProjectSettings={(project) => openProjectSettings(project)}
          onProjectDelete={setDeletingProject}
          onSettings={handleOpenSettings}
          onChangelog={() => setChangelogOpen(true)}
          onLeaderboard={() => {
            const store = useTabStore.getState()
            const existing = store.tabs.findIndex((t) => t.type === 'leaderboard')
            if (existing >= 0) {
              setActiveTabIndex(existing)
            }
          }}
          onUsageAnalytics={() => {
            const store = useTabStore.getState()
            const existing = store.tabs.findIndex((t) => t.type === 'usage-analytics')
            if (existing >= 0) {
              setActiveTabIndex(existing)
            } else {
              const newTabs = [...store.tabs, { type: 'usage-analytics' as const, title: 'Usage' }]
              store.setTabs(newTabs)
              setActiveTabIndex(newTabs.length - 1)
            }
          }}
          onTaskClick={openTask}
          zenMode={zenMode}
          onboardingChecklist={onboardingChecklist}
          attentionByProject={attentionByProject}
        />

        <div id="right-column" className={`flex-1 flex flex-col min-w-0 bg-surface-1 pb-2 pr-2 ${zenMode ? 'pl-2' : ''}`}>
              <div className={zenMode ? "pl-16" : ""}>
                  <TabBar
                    tabs={tabs}
                    activeIndex={activeTabIndex}
                    terminalStates={terminalStates}
                    projectColors={taskProjectColors}
                    worktreeColors={taskWorktreeColors}
                    onTabClick={handleTabClick}
                    onTabClose={closeTab}
                    onTabReorder={reorderTabs}
                    rightContent={
                      <div className="flex items-center gap-1">
                        <UsagePopover data={usageData} onRefresh={refreshUsage} />
                        <div className="w-6" />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              disabled={openTaskIds.length < 2}
                              onClick={() => setExplodeMode((prev) => !prev)}
                              className={cn(
                                "h-7 w-7 flex items-center justify-center transition-colors border-b-2",
                                explodeMode
                                  ? "text-foreground border-foreground"
                                  : "text-muted-foreground border-transparent hover:text-foreground",
                                openTaskIds.length < 2 && "opacity-30 pointer-events-none"
                              )}
                            >
                              <LayoutGrid className="size-4" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="text-xs">
                            {explodeMode ? 'Exit explode mode' : 'Explode mode'} (⌘⇧E)
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={selectedProjectId ? handleCreateScratchTerminal : undefined}
                              disabled={!selectedProjectId}
                              className={cn(
                                "h-7 w-7 flex items-center justify-center transition-colors",
                                selectedProjectId
                                  ? "text-muted-foreground hover:text-foreground"
                                  : "text-muted-foreground/40 cursor-not-allowed"
                              )}
                            >
                              <TerminalSquare className="size-4" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="text-xs max-w-64">
                            {selectedProjectId ? (
                              <div className="space-y-1">
                                <p>New temporary task (⌘⇧N)</p>
                                <p className="text-muted-foreground">Temporary tasks auto-delete on close.</p>
                              </div>
                            ) : (
                              <p>Select a project first</p>
                            )}
                          </TooltipContent>
                        </Tooltip>
                        <DesktopNotificationToggle
                          enabled={notificationState.desktopEnabled}
                          onToggle={() => {
                            if (notificationState.desktopEnabled) {
                              window.api.pty.dismissAllNotifications()
                            }
                            setNotificationState({ desktopEnabled: !notificationState.desktopEnabled })
                          }}
                        />
                        <NotificationButton
                          active={notificationState.isLocked}
                          count={attentionTasks.length}
                          onClick={() => setNotificationState({ isLocked: !notificationState.isLocked })}
                        />
                      </div>
                    }
                  />
              </div>

              <div id="content-wrapper" className="flex-1 min-h-0 flex">
                <div
                  id="main-area"
                  className={cn(
                    "flex-1 min-w-0 min-h-0 rounded-lg overflow-hidden bg-background",
                    explodeMode ? "grid gap-1 p-1" : "relative"
                  )}
                  style={explodeMode ? (() => {
                    const cols = Math.ceil(Math.sqrt(openTaskIds.length))
                    const rows = Math.ceil(openTaskIds.length / cols)
                    return {
                      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                      gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`
                    }
                  })() : undefined}
                >
                  {tabs.map((tab, i) => {
                    if (explodeMode && tab.type !== 'task') return null
                    return (
                    <div
                      key={tab.type === 'home' ? 'home' : tab.type === 'leaderboard' ? 'leaderboard' : tab.type === 'usage-analytics' ? 'usage-analytics' : tab.taskId}
                      className={
                        explodeMode
                          ? "rounded overflow-hidden border border-border min-h-0 relative"
                          : `absolute inset-0 ${i !== activeTabIndex ? 'invisible' : 'z-10'}`
                      }
                      inert={!explodeMode && i !== activeTabIndex ? true : undefined}
                    >
                        {tab.type === 'home' ? (
                        <div className="flex flex-col flex-1 p-6 pt-4 h-full" style={{ backgroundColor: colorTintsEnabled ? projectColorBg(selectedProject?.color) : undefined }}>
                          <header className="mb-4 window-no-drag space-y-2">
                            <div className="flex items-center gap-4">
                              <div className="flex-shrink-0">
                                <textarea
                                  ref={selectedProject ? projectNameInputRef : undefined}
                                  value={selectedProject ? projectNameValue : 'No project selected'}
                                  readOnly={!selectedProject}
                                  tabIndex={selectedProject ? undefined : -1}
                                  onChange={selectedProject ? (e) => setProjectNameValue(e.target.value) : undefined}
                                  onBlur={selectedProject ? handleProjectNameSave : undefined}
                                  onKeyDown={selectedProject ? handleProjectNameKeyDown : undefined}
                                  className={cn(
                                    'text-2xl font-bold bg-transparent border-none outline-none resize-none p-0',
                                    selectedProject ? 'cursor-text' : 'cursor-default select-none'
                                  )}
                                  style={{ caretColor: 'currentColor', fieldSizing: 'content' } as React.CSSProperties}
                                  rows={1}
                                />
                              </div>
                              {projects.length > 0 && !(projectPathMissing && selectedProjectId) && (
                                <FilterBar filter={filter} onChange={setFilter} tags={tags} />
                              )}
                              {projects.length > 0 && (
                                <div>
                                <PanelToggle
                                  panels={[
                                    { id: 'kanban', icon: Kanban, label: 'Kanban', active: homePanelVisibility.kanban, disabled: !selectedProjectId },
                                    { id: 'git', icon: GitBranch, label: 'Git', shortcut: '⌘G', active: homePanelVisibility.git, disabled: !selectedProjectId },
                                    { id: 'editor', icon: FileCode, label: 'Editor', shortcut: '⌘E', active: homePanelVisibility.editor, disabled: !selectedProjectId },
                                    ...(import.meta.env.DEV ? [{ id: 'processes', icon: Cpu, label: 'Processes', shortcut: '⌘O', active: homePanelVisibility.processes, disabled: !selectedProjectId }] : [{ id: 'processes', icon: Cpu, label: 'Processes', active: homePanelVisibility.processes, disabled: !selectedProjectId }]),
                                    ...(testsPanelEnabled ? [{ id: 'tests', icon: FlaskConical, label: 'Tests', shortcut: '⌘U', active: homePanelVisibility.tests, disabled: !selectedProjectId }] : []),
                                  ].filter(p => p.id === 'kanban' || isHomePanelEnabled(p.id, 'home'))}
                                  onChange={(id, active) => setHomePanelVisibility(prev => ({ ...prev, [id]: active }))}
                                />
                                </div>
                              )}
                            </div>
                          </header>

                          {projects.length === 0 ? (
                            <div className="text-center text-muted-foreground">
                              Click + in sidebar to create a project
                            </div>
                          ) : projectPathMissing && selectedProjectId ? (
                            <div className="flex-1 flex items-center justify-center">
                              <div className="text-center space-y-4">
                                <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto" />
                                <p className="text-lg font-medium">Project path not found</p>
                                <p className="text-sm text-muted-foreground">
                                  <code className="bg-muted px-2 py-1 rounded">{projects.find((p) => p.id === selectedProjectId)?.path}</code>
                                </p>
                                <Button onClick={handleFixProjectPath}>Update path</Button>
                              </div>
                            </div>
                          ) : (
                            <div ref={homeContainerRef} className="flex-1 min-h-0 flex">
                              {HOME_PANEL_ORDER.filter(id => homePanelVisibility[id]).map((id, i) => {
                                const projectPath = projects.find(p => p.id === selectedProjectId)?.path ?? null
                                const w = homeResolvedWidths[id] ?? 400
                                return (
                                  <React.Fragment key={id}>
                                    {i > 0 && (
                                      <ResizeHandle
                                        width={w}
                                        minWidth={id === 'kanban' ? 400 : 200}
                                        onWidthChange={w => updatePanelSizes({ [HOME_PANEL_SIZE_KEY[id]]: w })}
                                        onReset={() => resetPanelSize(HOME_PANEL_SIZE_KEY[id])}
                                      />
                                    )}
                                    <div className={cn('shrink-0 min-h-0 overflow-hidden rounded-lg border border-border', id === 'kanban' && Object.values(homePanelVisibility).filter(Boolean).length <= 1 ? 'border-transparent' : cn('bg-background', id === 'kanban' ? 'p-3' : ''))} style={{ width: w }}>
                                      {id === 'kanban' && filter.viewMode !== 'list' && (
                                        <KanbanBoard
                                          tasks={displayTasks}
                                          columns={selectedProject?.columns_config}
                                          viewConfig={getViewConfig(filter)}
                                          isActive={tabs[activeTabIndex]?.type === 'home'}
                                          onTaskMove={handleTaskMove}
                                          onTaskReorder={reorderTasks}
                                          onTaskClick={handleTaskClick}
                                          onCreateTask={handleCreateTaskFromColumn}
                                          projectsMap={projectsMap}
                                          showProjectDot={false}
                                          cardProperties={filter.cardProperties}
                                          taskTags={taskTags}
                                          tags={tags}
                                          blockedTaskIds={blockedTaskIds}
                                          allProjects={projects}
                                          onUpdateTask={contextMenuUpdate}
                                          onArchiveTask={archiveTask}
                                          onDeleteTask={deleteTask}
                                          onArchiveAllTasks={archiveTasks}
                                        />
                                      )}
                                      {id === 'kanban' && filter.viewMode === 'list' && (
                                        <KanbanListView
                                          tasks={displayTasks}
                                          columns={selectedProject?.columns_config}
                                          viewConfig={getViewConfig(filter)}
                                          onTaskMove={handleTaskMove}
                                          onTaskReorder={reorderTasks}
                                          onTaskClick={handleTaskClick}
                                          onCreateTask={handleCreateTaskFromColumn}
                                          projectsMap={projectsMap}
                                          showProjectDot={false}
                                          cardProperties={filter.cardProperties}
                                          blockedTaskIds={blockedTaskIds}
                                          allProjects={projects}
                                          onUpdateTask={contextMenuUpdate}
                                          onArchiveTask={archiveTask}
                                          onDeleteTask={deleteTask}
                                        />
                                      )}
                                      {id === 'git' && (
                                        <UnifiedGitPanel
                                          ref={homeGitPanelRef}
                                          projectId={selectedProjectId}
                                          projectPath={projectPath}
                                          visible={true}
                                          defaultTab={homeGitDefaultTab}
                                          onTabChange={setHomeGitDefaultTab}
                                          tasks={tasks}
                                          filter={filter}
                                          projects={projects}
                                          onTaskClick={(t) => handleTaskClick(t, { metaKey: false })}
                                          onUpdateTask={(data) => window.api.db.updateTask(data).then(t => { updateTask(t); return t })}
                                          onCreateTask={(defaults) => {
                                            setCreateTaskDefaults(defaults)
                                            setCreateOpen(true)
                                          }}
                                        />
                                      )}
                                      {id === 'editor' && <Suspense><FileEditorView ref={homeEditorRefCallback} projectPath={projectPath ?? ''} /></Suspense>}
                                      {id === 'processes' && <ProcessesPanel taskId={null} projectId={selectedProjectId} cwd={projectPath} />}
                                      {id === 'tests' && <TestPanel projectId={selectedProjectId} projectPath={projectPath} groupBy={testGroupBy} onOpenSettings={() => { if (selectedProject) openProjectSettings(selectedProject, { initialTab: 'tests' }) }} />}
                                    </div>
                                  </React.Fragment>
                                )
                              })}
                            </div>
                          )}
                        </div>
                        ) : tab.type === 'leaderboard' ? (
                        <LeaderboardPage />
                        ) : tab.type === 'usage-analytics' ? (
                        <UsageAnalyticsPage onTaskClick={openTask} />
                        ) : (
                        <Suspense fallback={<TaskShell />}>
                        <div className={explodeMode ? "absolute inset-0" : "h-full"}>
                          <TaskDetailDataLoader
                            taskId={tab.taskId}
                            isActive={explodeMode || i === activeTabIndex}
                            compact={explodeMode}
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
                          />
                        </div></Suspense>
                        )}
                    </div>
                    )
                  })}
                </div>

                {notificationState.isLocked && (
                  <NotificationSidePanel
                    width={notificationState.panelWidth}
                    onWidthChange={(width) => setNotificationState({ panelWidth: width })}
                    attentionTasks={attentionTasks}
                    projects={projects}
                    filterCurrentProject={notificationState.filterCurrentProject}
                    onFilterToggle={() =>
                      setNotificationState({
                        filterCurrentProject: !notificationState.filterCurrentProject
                      })
                    }
                    onNavigate={openTask}
                    onCloseTerminal={async (sessionId) => {
                      await window.api.pty.kill(sessionId)
                      refreshAttentionTasks()
                    }}
                    selectedProjectId={selectedProjectId}
                    currentProjectName={projects.find((p) => p.id === selectedProjectId)?.name}
                  />
                )}
              </div>
        </div>

        {/* Dialogs */}
        <QuickOpenDialog
          open={homeQuickOpenVisible}
          onOpenChange={setHomeQuickOpenVisible}
          projectPath={projects.find(p => p.id === selectedProjectId)?.path ?? ''}
          onOpenFile={(filePath) => {
            if (homeEditorRef.current) {
              if (!homePanelVisibility.editor) setHomePanelVisibility(prev => ({ ...prev, editor: true }))
              homeEditorRef.current.openFile(filePath)
            } else {
              pendingHomeEditorFileRef.current = filePath
              setHomePanelVisibility(prev => ({ ...prev, editor: true }))
            }
          }}
        />
        <CreateTaskDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={handleTaskCreated}
          onCreatedAndOpen={handleTaskCreatedAndOpen}
          defaultProjectId={selectedProjectId || projects[0]?.id}
          defaultStatus={createTaskDefaults.status}
          defaultPriority={createTaskDefaults.priority}
          defaultDueDate={createTaskDefaults.dueDate}
          tags={tags}
          onTagCreated={(tag: Tag) => setTags((prev) => [...prev, tag])}
        />
        <EditTaskDialog
          task={editingTask}
          open={!!editingTask}
          onOpenChange={(open) => !open && setEditingTask(null)}
          onUpdated={handleTaskUpdated}
        />
        <DeleteTaskDialog
          task={deletingTask}
          open={!!deletingTask}
          onOpenChange={(open) => !open && setDeletingTask(null)}
          onDeleted={handleTaskDeleted}
        />
        <CreateProjectDialog
          open={createProjectOpen}
          onOpenChange={setCreateProjectOpen}
          onCreated={handleProjectCreated}
        />
        <ProjectSettingsDialog
          project={editingProject}
          open={!!editingProject}
          onOpenChange={(open) => !open && closeProjectSettings()}
          initialTab={projectSettingsInitialTab}
          groupBy={testGroupBy}
          onGroupByChange={setTestGroupBy}
          integrationOnboardingProvider={projectSettingsOnboardingProvider}
          onIntegrationOnboardingHandled={() => setProjectSettingsOnboardingProvider(null)}
          onOpenGlobalAiConfig={openGlobalAiConfigFromProject}
          onUpdated={handleProjectUpdated}
        />
        <DeleteProjectDialog
          project={deletingProject}
          open={!!deletingProject}
          onOpenChange={(open) => !open && setDeletingProject(null)}
          onDeleted={handleProjectDeleted}
        />
        <Suspense>
        <UserSettingsDialog
          open={settingsOpen}
          onOpenChange={(open) => {
            setSettingsOpen(open)
            if (!open) {
              setSettingsRevision((r) => r + 1)
              setSettingsInitialAiConfigSection(null)
            }
          }}
          initialTab={settingsInitialTab}
          initialAiConfigSection={settingsInitialAiConfigSection}
          onTabChange={setSettingsInitialTab}
        />
        </Suspense>
        <SearchDialog
          open={searchOpen}
          onOpenChange={setSearchOpen}
          tasks={tasks}
          projects={projects}
          onSelectTask={openTask}
          onSelectProject={setSelectedProjectId}
        />
        <OnboardingDialog
          externalOpen={onboardingOpen}
          onExternalClose={async () => {
            setOnboardingOpen(false)
            const [onboardingCompleted, prompted] = await Promise.all([
              window.api.settings.get('onboarding_completed'),
              window.api.settings.get('tutorial_prompted')
            ])
            if (onboardingCompleted === 'true') {
              markSetupGuideCompleted()
            }
            if (!prompted) {
              void window.api.settings.set('tutorial_prompted', 'true')
              toast('Want a quick tour?', {
                duration: 8000,
                action: { label: 'Take the tour', onClick: startTour }
              })
            }
          }}
        />
        <Suspense>
        <TutorialAnimationModal open={showAnimatedTour} onClose={() => setShowAnimatedTour(false)} />
        </Suspense>
        <ChangelogDialog
          open={changelogOpen || autoChangelogOpen}
          onOpenChange={(open) => {
            if (!open) {
              setChangelogOpen(false)
              dismissAutoChangelog()
            }
          }}
        />
        <AlertDialog open={completeTaskDialogOpen} onOpenChange={setCompleteTaskDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Complete Task</AlertDialogTitle>
              <AlertDialogDescription>Mark as complete and close tab?</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction autoFocus onClick={handleCompleteTaskConfirm}>Complete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <UpdateToast
          version={updateVersion}
          onRestart={() => window.api.app.restartForUpdate()}
          onDismiss={() => setUpdateVersion(null)}
        />
        <Toaster position="bottom-right" theme="dark" />
      </div>
    </SidebarProvider>
    </AppearanceProvider>
  )
}

export default App
