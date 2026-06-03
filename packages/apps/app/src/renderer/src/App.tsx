import React, {
  Suspense,
  lazy,
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useDeferredValue,
  useTransition
} from 'react'
import { useGuardedHotkeys } from '@slayzone/ui'
import { initShortcuts } from './shortcut-init'
import {
  AlertTriangle,
  FolderClosed,
  LayoutGrid,
  TerminalSquare,
  GitBranch,
  FileCode,
  Cpu,
  Kanban,
  FlaskConical,
  Zap,
  BookOpen,
  Lock,
  Focus,
  MoreHorizontal,
  Settings,
  Trophy,
  BarChart3,
  Megaphone,
  ListTree,
  PanelLeftClose,
  Bell,
  Bot,
  Check,
  Monitor
} from 'lucide-react'
import { buildCreateTaskDraftFromBrowserLink } from '@slayzone/task/shared'
import type { Task } from '@slayzone/task/shared'
import type { Project, ColumnConfig } from '@slayzone/projects/shared'
import {
  getDefaultStatus,
  getDoneStatus,
  getStatusByCategory,
  isCompletedStatus,
  resolveRepoPath
} from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
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
import { ResizeHandle } from '@slayzone/task/client/ResizeHandle'
import {
  useGlobalPanelSizes,
  applyBoundaryResize,
  effectiveLayout
} from '@slayzone/task/client/usePanelSizes'
import { usePanelConfig } from '@slayzone/task/client/usePanelConfig'
import { useProjectRepos } from '@slayzone/worktrees/hooks'
import type { ProjectCreationContext, ProjectStartMode } from '@slayzone/projects'
import {
  ProjectLockPopover,
  ProjectLockScreen,
  isRateLimited,
  recordTaskOpen,
  isProjectLocked,
  PROJECT_LOCKED_TOAST,
  hasActiveLockOverride,
  clearLockOverrides
} from '@slayzone/projects'
import {
  useTabStore,
  useDialogStore,
  AppearanceProvider,
  type SearchFileContext
} from '@slayzone/settings'
import { track, trackShortcut } from '@slayzone/telemetry/client'
import { usePtyStatus, useTerminalStateStore } from '@slayzone/terminal/client'
// Shared
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
  UpdateButton,
  UpdateToast
} from '@slayzone/ui'
import {
  SidebarProvider,
  cn,
  PanelToggle,
  useUndo,
  matchesShortcut,
  useShortcutStore,
  shortcutDefinitions,
  useShortcutDisplay,
  withShortcut,
  withModalGuard,
  scopeTracker,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@slayzone/ui'
import { AppSidebar } from '@/components/sidebar/AppSidebar'
import { useAuthFailedConnections } from './useAuthFailedConnections'
import { useChangelogAutoOpen } from '@/components/changelog/useChangelogAutoOpen'
import { useStaleSkillCount } from '@slayzone/ai-config/client'
import { TabBar } from '@/components/tabs/TabBar'
import {
  GlobalAgentPanelButton,
  GLOBAL_AGENT_PANEL_MIN_WIDTH,
  GLOBAL_AGENT_PANEL_MAX_WIDTH,
  useGlobalAgentPanelState,
  DEFAULT_GLOBAL_AGENT_PANEL_WIDTH
} from '@/components/global-agent-panel'
import {
  AgentStatusButton,
  AGENT_STATUS_PANEL_MIN_WIDTH,
  AGENT_STATUS_PANEL_MAX_WIDTH,
  useIdleTasks,
  useActiveSessionTaskIds,
  useAgentStatusState,
  DEFAULT_AGENT_STATUS_PANEL_WIDTH
} from '@/components/agent-status'
import { UsagePopover } from '@/components/usage/UsagePopover'
import { BoostPill } from '@/components/usage/BoostPill'
import { useUsage } from '@/components/usage/useUsage'
import { useOnboardingChecklist } from '@/hooks/useOnboardingChecklist'
import { TaskShell } from '@slayzone/task/client/TaskShell'
// Extracted hooks (self-contained, clean interfaces)
import { useHomePanel, HOME_PANEL_SIZE_KEY } from '@/hooks/useHomePanel'
import { useTabLifecycle } from '@/hooks/useTabLifecycle'
import { useTabColors } from '@/hooks/useTabColors'
import { useVisibleTabs } from '@/hooks/useVisibleTabs'
import { useDiagnosticsSync } from '@/hooks/useDiagnosticsSync'
// Lazy-loaded: heavy components not needed for first paint
const TaskDetailDataLoader = lazy(() =>
  import('@slayzone/task/client/TaskDetailDataLoader').then((m) => ({
    default: m.TaskDetailDataLoader
  }))
)
const FileEditorView = lazy(() =>
  import('@slayzone/file-editor/client/FileEditorView').then((m) => ({ default: m.FileEditorView }))
)
const UserSettingsDialog = lazy(() =>
  import('@slayzone/settings/client/UserSettingsDialog').then((m) => ({
    default: m.UserSettingsDialog
  }))
)
const TutorialAnimationModal = lazy(() =>
  import('@/components/tutorial/TutorialAnimationModal').then((m) => ({
    default: m.TutorialAnimationModal
  }))
)
// Home panels
const UnifiedGitPanel = lazy(() =>
  import('@slayzone/worktrees').then((m) => ({ default: m.UnifiedGitPanel }))
)
const TestPanel = lazy(() => import('@slayzone/test-panel').then((m) => ({ default: m.TestPanel })))
const ProcessesPanel = lazy(() =>
  import('@slayzone/task').then((m) => ({ default: m.ProcessesPanel }))
)
const AutomationsPanel = lazy(() =>
  import('@slayzone/automations').then((m) => ({ default: m.AutomationsPanel }))
)
// Overlay pages
const LeaderboardPage = lazy(() =>
  import('@/components/leaderboard/LeaderboardPage').then((m) => ({ default: m.LeaderboardPage }))
)
const UsageAnalyticsPage = lazy(() =>
  import('@slayzone/usage-analytics/client').then((m) => ({ default: m.UsageAnalyticsPage }))
)
const ContextManagerPage = lazy(() =>
  import('@slayzone/ai-config/client').then((m) => ({ default: m.ContextManagerPage }))
)
// Dialogs
const CreateTaskDialog = lazy(() =>
  import('@slayzone/task').then((m) => ({ default: m.CreateTaskDialog }))
)
const EditTaskDialog = lazy(() =>
  import('@slayzone/task').then((m) => ({ default: m.EditTaskDialog }))
)
const DeleteTaskDialog = lazy(() =>
  import('@slayzone/task').then((m) => ({ default: m.DeleteTaskDialog }))
)
const TemplatesSettingsTab = lazy(() =>
  import('@slayzone/task').then((m) => ({ default: m.TemplatesSettingsTab }))
)
const CreateProjectDialog = lazy(() =>
  import('@slayzone/projects').then((m) => ({ default: m.CreateProjectDialog }))
)
const ProjectSettingsDialog = lazy(() =>
  import('@slayzone/projects').then((m) => ({ default: m.ProjectSettingsDialog }))
)
const DeleteProjectDialog = lazy(() =>
  import('@slayzone/projects').then((m) => ({ default: m.DeleteProjectDialog }))
)
const GroupSettingsDialog = lazy(() =>
  import('@slayzone/projects').then((m) => ({ default: m.GroupSettingsDialog }))
)
const OnboardingDialog = lazy(() =>
  import('@slayzone/onboarding').then((m) => ({ default: m.OnboardingDialog }))
)
const SearchDialog = lazy(() =>
  import('@/components/dialogs/SearchDialog').then((m) => ({ default: m.SearchDialog }))
)
const CliInstallDialog = lazy(() =>
  import('@/components/dialogs/CliInstallDialog').then((m) => ({ default: m.CliInstallDialog }))
)
const ChangelogDialog = lazy(() =>
  import('@/components/changelog/ChangelogDialog').then((m) => ({ default: m.ChangelogDialog }))
)
const KanbanBoard = lazy(() =>
  import('@slayzone/tasks').then((m) => ({ default: m.KanbanBoard }))
)
const KanbanListView = lazy(() =>
  import('@slayzone/tasks').then((m) => ({ default: m.KanbanListView }))
)
const FilterBar = lazy(() =>
  import('@slayzone/tasks').then((m) => ({ default: m.FilterBar }))
)
const GlobalAgentSidePanel = lazy(() =>
  import('@/components/global-agent-panel/GlobalAgentSidePanel').then((m) => ({
    default: m.GlobalAgentSidePanel
  }))
)
const AgentStatusSidePanel = lazy(() =>
  import('@/components/agent-status/AgentStatusSidePanel').then((m) => ({
    default: m.AgentStatusSidePanel
  }))
)
const TerminalStatusDialog = lazy(() =>
  import('@slayzone/terminal').then((m) => ({ default: m.TerminalStatusDialog }))
)

type ProjectSettingsTab =
  | 'general'
  | 'environment'
  | 'tasks'
  | 'tasks/general'
  | 'tasks/statuses'
  | 'integrations'
  | 'ai-config'
  | 'tests'
type ProjectIntegrationOnboardingProvider = Exclude<ProjectStartMode, 'scratch'>
type ContextManagerSection =
  | 'providers'
  | 'instructions'
  | 'skill'
  | 'mcp'
  | 'files'
  | 'provider-sync'
  | 'skills'
  | 'mcps'
const COMMUNITY_DISCORD_URL = 'https://discord.gg/g7xPHXaU98'
const COMMUNITY_X_URL = 'https://x.com/debuglebowski'

// Lazy-mount: first trigger loads the chunk + mounts; stays mounted after so close/reopen animations work.
function useLazyMounted() {
  const set = useRef(new Set<string>())
  return (key: string, open: boolean) => {
    if (open) set.current.add(key)
    return set.current.has(key)
  }
}

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
  const [explodeMode, setExplodeMode] = useState(false)
  // In explode mode, tracks which grid cell owns keyboard shortcuts (Cmd+D etc.).
  // Null outside explode mode. Updated via focusin bubble on the grid wrapper.
  const [focusedExplodeTaskId, setFocusedExplodeTaskId] = useState<string | null>(null)
  const explodeGridRef = useRef<HTMLDivElement | null>(null)
  const [explodeGridWidth, setExplodeGridWidth] = useState(0)
  const [panelSizes, updatePanelSizes, resetPanelSize] = useGlobalPanelSizes()
  const {
    config: homePanelConfig,
    isBuiltinEnabled: isHomePanelEnabled,
    getOrderedHomeIds
  } = usePanelConfig()
  const orderedHomeIds = useMemo(() => getOrderedHomeIds(), [getOrderedHomeIds])
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [updateDownloadPercent, setUpdateDownloadPercent] = useState<number | null>(null)
  const [updateToastDismissed, setUpdateToastDismissed] = useState(false)

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

  // Project path validation
  const [projectPathMissing, setProjectPathMissing] = useState(false)
  const validateProjectPath = useCallback(async (project: Project | undefined) => {
    if (!project?.path) {
      setProjectPathMissing(false)
      return
    }
    const fn = window.api.files?.pathExists
    if (typeof fn !== 'function') return
    setProjectPathMissing(!(await fn(project.path)))
  }, [])

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

  // Auto-disable explode mode when fewer than 2 task tabs
  useEffect(() => {
    if (openTaskIds.length < 2) setExplodeMode(false)
  }, [openTaskIds.length])

  // Seed / clear focused explode cell on mode toggle; keep valid as tabs change
  useEffect(() => {
    if (!explodeMode) {
      setFocusedExplodeTaskId(null)
      return
    }
    setFocusedExplodeTaskId((prev) => {
      if (prev && openTaskIds.includes(prev)) return prev
      const activeTab = tabs[activeTabIndex]
      if (activeTab?.type === 'task') return activeTab.taskId
      return openTaskIds[0] ?? null
    })
  }, [explodeMode, openTaskIds, activeTabIndex, tabs])

  // Delegated focusin: bubble from xterm / editor / browser → grid cell; resolve task id.
  useEffect(() => {
    if (!explodeMode) return
    const grid = explodeGridRef.current
    if (!grid) return
    const handleFocusIn = (e: FocusEvent): void => {
      const target = e.target as HTMLElement | null
      const cell = target?.closest('[data-explode-task-id]')
      const id = cell?.getAttribute('data-explode-task-id')
      if (id) setFocusedExplodeTaskId(id)
    }
    grid.addEventListener('focusin', handleFocusIn)
    return () => grid.removeEventListener('focusin', handleFocusIn)
  }, [explodeMode])

  // Track grid width so explode mode can pack more columns as the window grows.
  useEffect(() => {
    if (!explodeMode) return
    const grid = explodeGridRef.current
    if (!grid) return
    setExplodeGridWidth(grid.clientWidth)
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setExplodeGridWidth(w)
    })
    ro.observe(grid)
    return () => ro.disconnect()
  }, [explodeMode])

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

  useEffect(() => {
    validateProjectPath(projects.find((p) => p.id === selectedProjectId))
  }, [selectedProjectId, projects, validateProjectPath])

  useEffect(() => {
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project?.path) return
    const handleFocus = (): void => {
      validateProjectPath(project)
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [selectedProjectId, projects, validateProjectPath])

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

  // Shortcut store (dynamic hotkey bindings)
  const overrides = useShortcutStore((s) => s.overrides)
  const isRecording = useShortcutStore((s) => s.isRecording)
  // Resolve effective keys from overrides + defaults. Subscribing to `overrides` above
  // ensures re-render when shortcuts change, so useHotkeys picks up new key strings.
  const getKeys = useCallback(
    (id: string): string => {
      if (overrides[id]) return overrides[id]
      const def = shortcutDefinitions.find((d) => d.id === id)
      return def?.defaultKeys ?? ''
    },
    [overrides]
  )
  useEffect(() => {
    useShortcutStore.getState().load()
  }, [])

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

  // Keyboard shortcuts
  useGuardedHotkeys(
    getKeys('new-task'),
    (e) => {
      if (projects.length > 0) {
        e.preventDefault()
        trackShortcut(getKeys('new-task'))
        useDialogStore.getState().openCreateTask()
      }
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  // Build a snapshot of the home file-open context for the unified palette.
  // Captured into the dialog payload at the moment the shortcut fires; cleared on close.
  const buildHomeFileContext = useCallback((): SearchFileContext | undefined => {
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project?.path) return undefined
    return {
      projectPath: project.path,
      openFile: (filePath) => {
        if (homePanel.homeEditorRef.current) {
          if (!homePanel.homePanelVisibility.editor) {
            homePanel.setHomePanelVisibility((prev) => ({ ...prev, editor: true }))
          }
          homePanel.homeEditorRef.current.openFile(filePath)
        } else {
          homePanel.pendingHomeEditorFileRef.current = filePath
          homePanel.setHomePanelVisibility((prev) => ({ ...prev, editor: true }))
        }
      }
    }
  }, [projects, selectedProjectId, homePanel])

  useGuardedHotkeys(
    getKeys('search'),
    (e) => {
      // Only fire on home tab; TaskDetailPage owns the search shortcut when a task tab is active.
      if (tabs[activeTabIndex]?.type !== 'home') return
      e.preventDefault()
      trackShortcut(getKeys('search'))
      useDialogStore.getState().openSearch({ fileContext: buildHomeFileContext() })
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    'mod+z',
    async (e) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
      if (el.closest?.('.cm-editor') || el.closest?.('.xterm')) return
      e.preventDefault()
      const label = await undo()
      if (label) {
        track('undo_used')
        toast(`Undid: ${label}`)
      }
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    'mod+shift+z',
    async (e) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
      if (el.closest?.('.cm-editor') || el.closest?.('.xterm')) return
      e.preventDefault()
      const label = await redo()
      if (label) {
        track('redo_used')
        toast(`Redid: ${label}`)
      }
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  // Stable refs for IPC listeners
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

  useEffect(() => {
    return window.api.app.onCloseActiveTask(() => closeActiveTaskRef.current())
  }, [])
  useEffect(() => {
    return window.api.app.onCloseCurrent(() => closeCurrentHomeRef.current())
  }, [])
  useEffect(() => {
    return window.api.app.onCloseTask((taskId) => {
      useTabStore.getState().closeTabByTaskId(taskId)
      void window.api.processes.killTask(taskId)
    })
  }, [])
  useEffect(() => {
    return window.api.app.onOpenTask((taskId, background) => {
      if (background) guardTaskOpen(taskId, openTaskInBackground)
      else openTaskRef.current(taskId)
    })
  }, [guardTaskOpen, openTaskInBackground])
  useEffect(() => {
    return window.api.app.onGoHome(() => {
      const homeIndex = useTabStore.getState().tabs.findIndex((tab) => tab.type === 'home')
      if (homeIndex >= 0) setActiveTabIndex(homeIndex)
    })
  }, [])
  useEffect(() => {
    return window.api.app.onToggleGlobalAgentPanel(() => {
      if (selectedProjectId) setGlobalAgentPanelState({ isOpen: !globalAgentPanelState.isOpen })
    })
  }, [selectedProjectId, globalAgentPanelState.isOpen])
  useEffect(() => {
    return window.api.app.onToggleAgentStatusPanel(() => {
      setAgentStatusState({ isLocked: !agentStatusState.isLocked })
    })
  }, [agentStatusState.isLocked])
  useEffect(() => {
    return window.api.app.onOpenSettings(() => {
      setSettingsInitialTab('appearance')
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
          setUpdateDownloadPercent(status.percent)
          setUpdateVersion(null)
          toast.dismiss('update-check')
          break
        case 'downloaded':
          toast.dismiss('update-check')
          setUpdateDownloadPercent(null)
          setUpdateVersion(status.version)
          setUpdateToastDismissed(false)
          break
        case 'not-available':
          setUpdateDownloadPercent(null)
          toast.success("You're on the latest version", { id: 'update-check' })
          break
        case 'error':
          setUpdateDownloadPercent(null)
          toast.dismiss('update-check')
          toast.error(`Update failed: ${status.message}`, { duration: 8000 })
          break
      }
    })
  }, [])

  useGuardedHotkeys(
    'mod+1,mod+2,mod+3,mod+4,mod+5,mod+6,mod+7,mod+8,mod+9',
    (e) => {
      e.preventDefault()
      const num = parseInt(e.key, 10)
      if (num < visibleTabs.length) setActiveTabIndex(toFullIndex(num))
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    'mod+shift+1,mod+shift+2,mod+shift+3,mod+shift+4,mod+shift+5,mod+shift+6,mod+shift+7,mod+shift+8,mod+shift+9',
    (e) => {
      e.preventDefault()
      const num = parseInt(e.code.replace('Digit', ''), 10)
      if (num > 0 && num <= projects.length) {
        setSelectedProjectId(projects[num - 1].id)
        setActiveTabIndex(0)
      }
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  const navigateCycle = useCallback(
    (direction: 1 | -1) => {
      const cycle = tabCycleOrder.filter((i) => toVisibleIndex(i) >= 0)
      if (cycle.length === 0) return
      const { activeTabIndex: idx, activeView: view } = useTabStore.getState()
      const pos = view === 'context' ? -1 : cycle.indexOf(idx)
      const current = pos >= 0 ? pos : 0
      const target = cycle[(current + direction + cycle.length) % cycle.length]
      useTabStore.getState().setActiveView('tabs')
      setActiveTabIndex(target)
    },
    [tabCycleOrder, toVisibleIndex, setActiveTabIndex]
  )

  const cycleSidebarTreeItems = useCallback((direction: 1 | -1) => {
    const items = Array.from(
      document.querySelectorAll<HTMLElement>('[data-sidebar-tree-item="task"][data-task-id]')
    )
    if (items.length === 0) return
    const activeIdx = items.findIndex((el) => el.dataset.active === 'true')
    const nextIdx =
      activeIdx === -1
        ? direction === 1
          ? 0
          : items.length - 1
        : (activeIdx + direction + items.length) % items.length
    const id = items[nextIdx]?.dataset.taskId
    if (id) openTaskRef.current(id)
  }, [])

  useGuardedHotkeys(
    getKeys('next-tab'),
    (e) => {
      e.preventDefault()
      const { sidebarView: sv } = useTabStore.getState()
      if (sv === 'tree') cycleSidebarTreeItems(1)
      else navigateCycle(1)
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('prev-tab'),
    (e) => {
      e.preventDefault()
      const { sidebarView: sv } = useTabStore.getState()
      if (sv === 'tree') cycleSidebarTreeItems(-1)
      else navigateCycle(-1)
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('reopen-closed-tab'),
    (e) => {
      e.preventDefault()
      track('tab_reopened')
      reopenClosedTab()
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('toggle-project-tabs'),
    (e) => {
      e.preventDefault()
      trackShortcut(getKeys('toggle-project-tabs'))
      useTabStore.getState().toggleProjectScopedTabs()
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('complete-close-tab'),
    (e) => {
      e.preventDefault()
      if (tabs[activeTabIndex].type === 'task') useDialogStore.getState().openCompleteTaskDialog()
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('zen-mode'),
    (e) => {
      e.preventDefault()
      track('zen_mode_toggled')
      trackShortcut(getKeys('zen-mode'))
      setZenMode((prev) => !prev)
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('sidebar-auto-hide'),
    (e) => {
      e.preventDefault()
      trackShortcut(getKeys('sidebar-auto-hide'))
      useTabStore.getState().setSidebarAutoHide(!useTabStore.getState().sidebarAutoHide)
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('explode-mode'),
    (e) => {
      e.preventDefault()
      if (openTaskIds.length >= 2) {
        track('explode_mode_toggled')
        trackShortcut(getKeys('explode-mode'))
        setExplodeMode((prev) => !prev)
      }
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('exit-zen-explode'),
    () => {
      if (explodeMode) setExplodeMode(false)
      else if (zenMode) setZenMode(false)
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('global-agent-panel'),
    (e) => {
      e.preventDefault()
      trackShortcut(getKeys('global-agent-panel'))
      if (selectedProjectId) setGlobalAgentPanelState({ isOpen: !globalAgentPanelState.isOpen })
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  useGuardedHotkeys(
    getKeys('agent-status-panel'),
    (e) => {
      e.preventDefault()
      trackShortcut(getKeys('agent-status-panel'))
      setAgentStatusState({ isLocked: !agentStatusState.isLocked })
    },
    { enableOnFormTags: true, enabled: !isRecording }
  )

  // Home tab panel shortcuts
  useEffect(() => {
    const handleKeyDown = withModalGuard((e: KeyboardEvent): void => {
      if (tabs[activeTabIndex]?.type !== 'home') return
      if (!selectedProjectId) return
      if (isRecording) return

      // These shortcuts work even inside editors (no binding conflict)
      if (matchesShortcut(e, getKeys('editor-search')) && isHomePanelEnabled('editor', 'home')) {
        e.preventDefault()
        if (homePanel.homeEditorRef.current) {
          if (!homePanel.homePanelVisibility.editor)
            homePanel.setHomePanelVisibility((prev) => ({ ...prev, editor: true }))
          homePanel.homeEditorRef.current.toggleSearch()
        } else {
          homePanel.pendingHomeSearchToggleRef.current = true
          homePanel.setHomePanelVisibility((prev) => ({ ...prev, editor: true }))
        }
        return
      }

      // Git Diff (panel-git-diff)
      if (matchesShortcut(e, getKeys('panel-git-diff')) && isHomePanelEnabled('git', 'home')) {
        e.preventDefault()
        if (!homePanel.homePanelVisibility.git) {
          homePanel.setHomeGitDefaultTab('changes')
          homePanel.setHomePanelVisibility((prev) => ({ ...prev, git: true }))
        } else if (homePanel.homeGitPanelRef.current?.getActiveTab() === 'changes') {
          homePanel.setHomePanelVisibility((prev) => ({ ...prev, git: false }))
        } else {
          homePanel.homeGitPanelRef.current?.switchToTab('changes')
        }
        return
      }

      // Git (panel-git)
      if (matchesShortcut(e, getKeys('panel-git')) && isHomePanelEnabled('git', 'home')) {
        e.preventDefault()
        if (!homePanel.homePanelVisibility.git) {
          homePanel.setHomeGitDefaultTab('general')
          homePanel.setHomePanelVisibility((prev) => ({ ...prev, git: true }))
        } else if (homePanel.homeGitPanelRef.current?.getActiveTab() === 'general') {
          homePanel.setHomePanelVisibility((prev) => ({ ...prev, git: false }))
        } else {
          homePanel.homeGitPanelRef.current?.switchToTab('general')
        }
      } else if (
        matchesShortcut(e, getKeys('panel-editor')) &&
        isHomePanelEnabled('editor', 'home')
      ) {
        e.preventDefault()
        homePanel.setHomePanelVisibility((prev) => ({ ...prev, editor: !prev.editor }))
      } else if (
        matchesShortcut(e, getKeys('panel-processes')) &&
        isHomePanelEnabled('processes', 'home')
      ) {
        e.preventDefault()
        homePanel.setHomePanelVisibility((prev) => ({ ...prev, processes: !prev.processes }))
      } else if (
        matchesShortcut(e, getKeys('panel-tests')) &&
        testsPanelEnabled &&
        isHomePanelEnabled('tests', 'home')
      ) {
        e.preventDefault()
        homePanel.setHomePanelVisibility((prev) => ({ ...prev, tests: !prev.tests }))
      } else if (
        matchesShortcut(e, getKeys('panel-automations')) &&
        isHomePanelEnabled('automations', 'home')
      ) {
        e.preventDefault()
        homePanel.setHomePanelVisibility((prev) => ({ ...prev, automations: !prev.automations }))
      }
    })
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    tabs,
    activeTabIndex,
    selectedProjectId,
    homePanel.homePanelVisibility,
    getKeys,
    isRecording,
    buildHomeFileContext
  ])

  // Cmd+R: reload the active browser view (WebContentsView or webview fallback)
  useEffect(() => {
    return window.api.app.onReloadBrowser(() => {
      // Find visible WebContentsView placeholder and reload via IPC
      const placeholder = document.querySelector(
        '[data-browser-panel][data-view-id]'
      ) as HTMLElement | null
      const viewId = placeholder?.dataset.viewId
      if (viewId) {
        void window.api.browser.reload(viewId)
        return
      }
      // Fallback: webview (multi-device grid)
      const webview = document.querySelector('[data-browser-panel] webview') as any
      if (webview?.reload) webview.reload()
    })
  }, [])

  // Cmd+Shift+R: reload the app
  useEffect(() => {
    return window.api.app.onReloadApp?.(() => {
      window.location.reload()
    })
  }, [])

  // Keep app zoom on an explicit IPC path instead of relying on Electron's default zoom roles.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return

      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        void window.api.app.adjustZoom('in')
        return
      }

      if (e.key === '-') {
        e.preventDefault()
        void window.api.app.adjustZoom('out')
        return
      }

      if (e.key === '0') {
        e.preventDefault()
        void window.api.app.adjustZoom('reset')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Forward keyboard shortcuts from WebContentsView back into the DOM
  useEffect(() => {
    return window.api.browser.onBrowserViewShortcut((payload) => {
      // WebContentsView is a separate web contents — focusin never fires in
      // renderer when it has focus. Set browser scope before dispatching so
      // the shortcut registry sees the correct active scopes.
      // Web panels should NOT activate browser scope — browser-scoped shortcuts
      // (T for new tab, D for split) are wrong for web panels.
      if (payload.kind !== 'web-panel') {
        scopeTracker.setComponentScope('browser', payload.viewId)
      }
      // Dispatch on document (not window) so react-hotkeys-hook sees it —
      // it listens on document. Events on document also bubble to window,
      // so raw window.addEventListener handlers still work.
      // react-hotkeys-hook tracks pressed keys by e.code via keydown events.
      // Emit modifier keydowns first so the pressed-key set is correct, then
      // emit the actual key. Include code on all events.
      const key = payload.key
      const code = key.length === 1 ? `Key${key.toUpperCase()}` : key
      const mods = {
        shiftKey: payload.shift,
        metaKey: payload.meta,
        ctrlKey: payload.control,
        altKey: payload.alt
      }
      if (payload.control)
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Control',
            code: 'ControlLeft',
            ...mods,
            bubbles: true
          })
        )
      if (payload.meta)
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Meta', code: 'MetaLeft', ...mods, bubbles: true })
        )
      if (payload.shift)
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', ...mods, bubbles: true })
        )
      if (payload.alt)
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Alt', code: 'AltLeft', ...mods, bubbles: true })
        )
      document.dispatchEvent(new KeyboardEvent('keydown', { key, code, ...mods, bubbles: true }))
    })
  }, [])

  // When a WebContentsView gains focus, dispatch a synthetic focusin on the
  // owning panel element so TaskDetailPage's glow tracking picks it up.
  // Uses DOM lookup via data-view-id → closest data-panel-id to work for
  // both browser tabs and web panels.
  useEffect(() => {
    return window.api.browser.onBrowserViewFocused(({ viewId }) => {
      const el = document.querySelector(`[data-view-id="${viewId}"]`)
      const panel = el?.closest('[data-panel-id]')
      if (panel) {
        panel.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      }
    })
  }, [])

  useEffect(() => {
    return window.api.browser.onCreateTaskFromLink((intent) => {
      const sourceTask = tasksMap.get(intent.taskId)
      const fallbackProjectId = sourceTask?.project_id ?? selectedProjectId ?? projects[0]?.id
      useDialogStore.getState().openCreateTask({
        ...buildCreateTaskDraftFromBrowserLink(intent.url, intent.linkText),
        projectId: fallbackProjectId
      })
    })
  }, [tasksMap, selectedProjectId, projects])

  // Tab management
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

  const { failed: authFailedConnections, refetch: refetchAuthFailures } =
    useAuthFailedConnections()
  useEffect(() => {
    if (!editingProject) refetchAuthFailures()
  }, [editingProject, refetchAuthFailures])
  const [dismissedAuthFailureIds, setDismissedAuthFailureIds] = useState<Set<string>>(new Set())
  const visibleAuthFailures = useMemo(
    () =>
      authFailedConnections.filter(
        (f) =>
          !dismissedAuthFailureIds.has(f.connection.id) &&
          selectedProjectId !== null &&
          f.projectIds.includes(selectedProjectId)
      ),
    [authFailedConnections, dismissedAuthFailureIds, selectedProjectId]
  )
  const reconnectAuthFailure = useCallback(() => {
    if (!selectedProjectId) return
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project) return
    openProjectSettings(project, { initialTab: 'integrations' })
  }, [selectedProjectId, projects, openProjectSettings])
  const dismissAuthFailures = useCallback(() => {
    setDismissedAuthFailureIds(
      (prev) => new Set([...prev, ...visibleAuthFailures.map((f) => f.connection.id)])
    )
  }, [visibleAuthFailures])

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

  const handleFixProjectPath = useCallback(async (): Promise<void> => {
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project) return
    const result = await window.api.dialog.showOpenDialog({
      title: 'Select Project Directory',
      defaultPath: project.path || undefined,
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return
    const updated = await window.api.db.updateProject({ id: project.id, path: result.filePaths[0] })
    updateProject(updated)
    validateProjectPath(updated)
  }, [selectedProjectId, projects, updateProject, validateProjectPath])

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
  const renderHeaderActions = (compact: boolean) => {
    const btnSize = compact ? 'h-7 w-7' : 'size-10 rounded-lg'
    const iconSize = compact ? 'size-3.5' : 'size-5'
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => useTabStore.getState().toggleProjectScopedTabs()}
              className={cn(
                btnSize,
                'flex items-center justify-center transition-colors border-b-2',
                projectScopedTabs
                  ? 'text-foreground border-foreground'
                  : 'text-muted-foreground border-transparent hover:text-foreground'
              )}
            >
              <FolderClosed className={iconSize} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {projectScopedTabs ? 'Show all tabs' : 'Show project tabs only'} ({projectTabsShortcut})
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setZenMode((prev) => !prev)}
              className={cn(
                btnSize,
                'flex items-center justify-center transition-colors border-b-2',
                zenMode
                  ? 'text-foreground border-foreground'
                  : 'text-muted-foreground border-transparent hover:text-foreground'
              )}
            >
              <Focus className={iconSize} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {zenMode ? 'Exit zen mode' : 'Zen mode'} ({zenModeShortcut})
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              disabled={openTaskIds.length < 2}
              onClick={() => setExplodeMode((prev) => !prev)}
              className={cn(
                btnSize,
                'flex items-center justify-center transition-colors border-b-2',
                explodeMode
                  ? 'text-foreground border-foreground'
                  : 'text-muted-foreground border-transparent hover:text-foreground',
                openTaskIds.length < 2 && 'opacity-30 pointer-events-none'
              )}
            >
              <LayoutGrid className={iconSize} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {explodeMode ? 'Exit explode mode' : 'Explode mode'} ({explodeModeShortcut})
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label="New temporary task"
              onClick={
                selectedProjectId && !durationLocked
                  ? () => {
                      void handleCreateScratchTerminal()
                    }
                  : undefined
              }
              disabled={!selectedProjectId || durationLocked}
              className={cn(
                btnSize,
                'flex items-center justify-center transition-colors',
                selectedProjectId && !durationLocked
                  ? 'text-muted-foreground hover:text-foreground'
                  : 'text-muted-foreground/40 cursor-not-allowed'
              )}
            >
              <TerminalSquare className={iconSize} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs max-w-64">
            {!selectedProjectId ? (
              <p>Select a project first</p>
            ) : durationLocked ? (
              <p>Project locked</p>
            ) : (
              <div className="space-y-1">
                <p>{withShortcut('New temporary task', newTempTaskShortcut)}</p>
                <p className="text-muted-foreground">Temporary tasks auto-delete on close.</p>
              </div>
            )}
          </TooltipContent>
        </Tooltip>
        <AgentStatusButton
          active={agentStatusState.isLocked}
          count={attentionTaskIds.size}
          onClick={() => setAgentStatusState({ isLocked: !agentStatusState.isLocked })}
          shortcutHint={agentStatusPanelShortcut}
          size={compact ? 'sm' : 'lg'}
        />
        <GlobalAgentPanelButton
          active={globalAgentPanelState.isOpen}
          disabled={!selectedProjectId}
          onClick={() => setGlobalAgentPanelState({ isOpen: !globalAgentPanelState.isOpen })}
          shortcutHint={globalAgentPanelShortcut}
          size={compact ? 'sm' : 'lg'}
        />
        <UpdateButton
          version={updateVersion}
          downloadPercent={updateDownloadPercent}
          onRestart={() => window.api.app.restartForUpdate()}
          size={compact ? 'sm' : 'lg'}
        />
      </>
    )
  }
  const tabBarRightContent = (
    <div className="flex items-center gap-1">
      <BoostPill />
      <div className="w-4" />
      <UsagePopover data={usageData} onRefresh={refreshUsage} />
      <div className="w-4" />
      {renderHeaderActions(true)}
    </div>
  )
  const compactFooterContent = (
    <div className="flex items-center justify-between gap-2 px-2 py-1">
      <div className="min-w-0 flex items-center">
        <UsagePopover data={usageData} onRefresh={refreshUsage} />
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={handleOpenSettings}
          className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Settings"
        >
          <Settings className="size-4" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More"
              className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="min-w-[240px]">
            <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Layout
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => setExplodeMode((p) => !p)}
              disabled={openTaskIds.length < 2}
              className="cursor-pointer"
            >
              <LayoutGrid className="size-4" />
              <span>Explode mode</span>
              {explodeMode && <Check className="size-4 col-start-3" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Panels
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => useDialogStore.getState().openTerminals()}
              className="cursor-pointer"
            >
              <Monitor className="size-4" />
              <span className="flex items-center gap-2">
                <span>Active terminals</span>
                {activePtyCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-foreground text-background text-[10px] font-medium tabular-nums">
                    {activePtyCount}
                  </span>
                )}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setGlobalAgentPanelState({ isOpen: !globalAgentPanelState.isOpen })}
              disabled={!selectedProjectId}
              className="cursor-pointer"
            >
              <Bot className="size-4" />
              <span>Global Agent panel</span>
              {globalAgentPanelState.isOpen && <Check className="size-4 col-start-3" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setAgentStatusState({ isLocked: !agentStatusState.isLocked })}
              className="cursor-pointer"
            >
              <Bell className="size-4" />
              <span className="flex items-center gap-2">
                <span>Agent status panel</span>
                {idleTasks.length > 0 && (
                  <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-foreground text-background text-[10px] font-medium tabular-nums">
                    {idleTasks.length}
                  </span>
                )}
              </span>
              {agentStatusState.isLocked && <Check className="size-4 col-start-3" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Insights
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => useTabStore.getState().setActiveView('leaderboard')}
              className="cursor-pointer"
            >
              <Trophy className="size-4" />
              <span>Leaderboard</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => useTabStore.getState().setActiveView('usage-analytics')}
              className="cursor-pointer"
            >
              <BarChart3 className="size-4" />
              <span>Usage Analytics</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => useDialogStore.getState().openChangelog()}
              className="cursor-pointer"
            >
              <Megaphone className="size-4" />
              <span>What's New</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Sidebar
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => useTabStore.getState().setSidebarView('tree')}
              className="cursor-pointer"
            >
              <ListTree className="size-4" />
              <span>Tree view</span>
              {sidebarView === 'tree' && <Check className="size-4 col-start-3" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => useTabStore.getState().setSidebarView('projects')}
              className="cursor-pointer"
            >
              <Kanban className="size-4" />
              <span>Projects view</span>
              {sidebarView === 'projects' && <Check className="size-4 col-start-3" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault()
                useTabStore.getState().setSidebarAutoHide(!sidebarAutoHide)
              }}
              className="cursor-pointer"
            >
              <PanelLeftClose className="size-4" />
              <span>Auto-hide sidebar</span>
              {sidebarAutoHide && <Check className="size-4 col-start-3" />}
            </DropdownMenuItem>
            {updateVersion && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => window.api.app.restartForUpdate()}
                  className="cursor-pointer text-green-500"
                >
                  <span>Restart to install v{updateVersion}</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
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
                            <div id="home-detail" className="flex flex-col flex-1 h-full p-4">
                              {durationLocked && selectedProject?.lock_config ? (
                                <ProjectLockScreen
                                  project={selectedProject}
                                  lockedUntil={selectedProject.lock_config?.locked_until}
                                  schedule={selectedProject.lock_config?.schedule}
                                  onUnlocked={updateProject}
                                />
                              ) : (
                                <>
                                  <header className="mb-4 window-no-drag space-y-2">
                                    <div className="flex items-center gap-4">
                                      <div className="flex-shrink-0">
                                        <textarea
                                          ref={selectedProject ? projectNameInputRef : undefined}
                                          value={
                                            selectedProject
                                              ? projectNameValue
                                              : 'No project selected'
                                          }
                                          readOnly={!selectedProject}
                                          tabIndex={selectedProject ? undefined : -1}
                                          onChange={
                                            selectedProject
                                              ? (e) => setProjectNameValue(e.target.value)
                                              : undefined
                                          }
                                          onBlur={
                                            selectedProject ? handleProjectNameSave : undefined
                                          }
                                          onKeyDown={
                                            selectedProject ? handleProjectNameKeyDown : undefined
                                          }
                                          className={cn(
                                            'text-2xl font-bold bg-transparent border-none outline-none resize-none p-0',
                                            selectedProject
                                              ? 'cursor-text'
                                              : 'cursor-default select-none'
                                          )}
                                          style={
                                            {
                                              caretColor: 'currentColor',
                                              fieldSizing: 'content'
                                            } as React.CSSProperties
                                          }
                                          rows={1}
                                        />
                                      </div>
                                      {projects.length > 0 &&
                                        !(projectPathMissing && selectedProjectId) && (
                                          <div className="ml-auto flex items-center gap-1">
                                            {selectedProject &&
                                              hasActiveLockOverride(selectedProject) && (
                                                <Button
                                                  variant="ghost"
                                                  size="sm"
                                                  className="h-7 gap-1.5 px-2 text-xs font-medium text-amber-600 dark:text-amber-400"
                                                  onClick={() => {
                                                    clearLockOverrides(selectedProject.id)
                                                    updateProject(selectedProject)
                                                  }}
                                                >
                                                  <Lock className="size-3.5" />
                                                  Re-lock
                                                </Button>
                                              )}
                                            {selectedProject && (
                                              <ProjectLockPopover
                                                project={selectedProject}
                                                onUpdated={updateProject}
                                              />
                                            )}
                                            <div className="h-4 w-px bg-border" />
                                            <Suspense fallback={null}>
                                              <FilterBar
                                                filter={filter}
                                                onChange={setFilter}
                                                tags={projectTags}
                                                columns={selectedProject?.columns_config}
                                              />
                                            </Suspense>
                                          </div>
                                        )}
                                      {projects.length > 0 &&
                                        (() => {
                                          const entries: Record<
                                            string,
                                            {
                                              id: string
                                              icon: typeof Kanban
                                              label: string
                                              shortcut?: string | null
                                              active: boolean
                                              disabled: boolean
                                            }
                                          > = {
                                            kanban: {
                                              id: 'kanban',
                                              icon: Kanban,
                                              label: 'Kanban',
                                              active: homePanel.homePanelVisibility.kanban,
                                              disabled: !selectedProjectId
                                            },
                                            git: {
                                              id: 'git',
                                              icon: GitBranch,
                                              label: 'Git',
                                              shortcut: panelGitShortcut,
                                              active: homePanel.homePanelVisibility.git,
                                              disabled: !selectedProjectId
                                            },
                                            editor: {
                                              id: 'editor',
                                              icon: FileCode,
                                              label: 'Editor',
                                              shortcut: panelEditorShortcut,
                                              active: homePanel.homePanelVisibility.editor,
                                              disabled: !selectedProjectId
                                            },
                                            processes: {
                                              id: 'processes',
                                              icon: Cpu,
                                              label: 'Processes',
                                              shortcut: panelProcessesShortcut,
                                              active: homePanel.homePanelVisibility.processes,
                                              disabled: !selectedProjectId
                                            },
                                            tests: {
                                              id: 'tests',
                                              icon: FlaskConical,
                                              label: 'Tests',
                                              shortcut: panelTestsShortcut,
                                              active: homePanel.homePanelVisibility.tests,
                                              disabled: !selectedProjectId
                                            },
                                            automations: {
                                              id: 'automations',
                                              icon: Zap,
                                              label: 'Automations',
                                              shortcut: panelAutomationsShortcut,
                                              active: homePanel.homePanelVisibility.automations,
                                              disabled: !selectedProjectId
                                            }
                                          }
                                          const ordered = homePanel.orderedHomePanelIds
                                            .map((id) => entries[id])
                                            .filter((e): e is NonNullable<typeof e> => !!e)
                                            .filter(
                                              (p) =>
                                                p.id === 'kanban' ||
                                                isHomePanelEnabled(p.id, 'home')
                                            )
                                            .filter((p) => p.id !== 'tests' || testsPanelEnabled)
                                          return (
                                            <div className="min-w-0">
                                              <PanelToggle
                                                panels={ordered}
                                                onChange={(id, active) =>
                                                  homePanel.setHomePanelVisibility((prev) => ({
                                                    ...prev,
                                                    [id]: active
                                                  }))
                                                }
                                              />
                                            </div>
                                          )
                                        })()}
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
                                        <p className="text-lg font-medium">
                                          Project path not found
                                        </p>
                                        <p className="text-sm text-muted-foreground">
                                          <code className="bg-muted px-2 py-1 rounded">
                                            {projects.find((p) => p.id === selectedProjectId)?.path}
                                          </code>
                                        </p>
                                        <Button onClick={handleFixProjectPath}>Update path</Button>
                                      </div>
                                    </div>
                                  ) : (
                                    <div
                                      ref={homePanel.homeContainerRef}
                                      className="flex-1 min-h-0 flex overflow-x-auto"
                                    >
                                      {homePanel.homeRenderOrder.map((id, j) => {
                                          const projectPath =
                                            homeResolvedRepo.path ??
                                            projects.find((p) => p.id === selectedProjectId)
                                              ?.path ??
                                            null
                                          const sizeKey = HOME_PANEL_SIZE_KEY[id]
                                          const w = homePanel.homeResolvedWidths[sizeKey] ?? 400
                                          // Cluster boundary (left→right anchor): the leftover gap sits
                                          // just before the boundary handle (or the left edge if no
                                          // left cluster).
                                          const isClusterBoundary =
                                            j === homePanel.homeLeftCount &&
                                            homePanel.homeResolved.rightKeys.length > 0
                                          // A handle renders before every panel except the very first —
                                          // including the boundary (last-left ↔ first-right).
                                          const leftId =
                                            j > 0 ? homePanel.homeRenderOrder[j - 1] : undefined
                                          const leftL = leftId
                                            ? effectiveLayout(
                                                HOME_PANEL_SIZE_KEY[leftId],
                                                homePanelConfig,
                                                panelSizes
                                              )
                                            : undefined
                                          const rightL = effectiveLayout(
                                            sizeKey,
                                            homePanelConfig,
                                            panelSizes
                                          )
                                          return (
                                            <React.Fragment key={id}>
                                              {isClusterBoundary && (
                                                <div
                                                  aria-hidden
                                                  data-testid="panel-gap"
                                                  className="shrink-0"
                                                  style={{ width: homePanel.homeResolved.gapPx }}
                                                />
                                              )}
                                              {leftId && leftL && (
                                                <ResizeHandle
                                                  leftWidth={
                                                    homePanel.homeResolvedWidths[
                                                      HOME_PANEL_SIZE_KEY[leftId]
                                                    ] ?? 400
                                                  }
                                                  rightWidth={w}
                                                  leftMinWidth={
                                                    homePanel.homeResolved.minPx[
                                                      HOME_PANEL_SIZE_KEY[leftId]
                                                    ] ?? 200
                                                  }
                                                  rightMinWidth={
                                                    homePanel.homeResolved.minPx[sizeKey] ?? 200
                                                  }
                                                  leftMaxWidth={
                                                    homePanel.homeResolved.maxPx[
                                                      HOME_PANEL_SIZE_KEY[leftId]
                                                    ]
                                                  }
                                                  rightMaxWidth={
                                                    homePanel.homeResolved.maxPx[sizeKey]
                                                  }
                                                  onResize={(lw, rw) =>
                                                    updatePanelSizes(
                                                      applyBoundaryResize(
                                                        leftL,
                                                        rightL,
                                                        HOME_PANEL_SIZE_KEY[leftId],
                                                        sizeKey,
                                                        lw,
                                                        rw,
                                                        homePanel.homeContainerWidth
                                                      )
                                                    )
                                                  }
                                                  onReset={() => {
                                                    resetPanelSize(HOME_PANEL_SIZE_KEY[leftId])
                                                    resetPanelSize(sizeKey)
                                                  }}
                                                />
                                              )}
                                              <div
                                                className={cn(
                                                  'shrink-0 min-h-0 overflow-hidden',
                                                  cn(
                                                    'rounded-lg border border-border',
                                                    id === 'kanban' &&
                                                      Object.values(
                                                        homePanel.homePanelVisibility
                                                      ).filter(Boolean).length <= 1 &&
                                                      !globalAgentPanelState.isOpen &&
                                                      !agentStatusState.isLocked
                                                      ? 'border-transparent'
                                                      : id === 'kanban'
                                                        ? 'bg-surface-1 p-3'
                                                        : 'bg-surface-1'
                                                  )
                                                )}
                                                style={{ width: w }}
                                              >
                                                {id === 'kanban' && filter.viewMode !== 'list' && (
                                                  <Suspense fallback={null}>
                                                    <KanbanBoard
                                                      tasks={displayTasks}
                                                      columns={selectedProject?.columns_config}
                                                      viewConfig={getViewConfig(filter)}
                                                      isActive={tabs[activeTabIndex]?.type === 'home'}
                                                      onTaskMove={handleTaskMove}
                                                      onTaskBulkMove={handleTaskBulkMove}
                                                      onTaskReorder={reorderTasks}
                                                      onTaskClick={handleTaskClick}
                                                      cardProperties={filter.cardProperties}
                                                      taskTags={taskTags}
                                                      tags={projectTags}
                                                      onTaskTagsChange={handleTaskTagsChange}
                                                      blockedTaskIds={blockedTaskIds}
                                                      allProjects={projects}
                                                      onUpdateTask={contextMenuUpdate}
                                                      onBulkUpdateTasks={bulkContextMenuUpdate}
                                                      onClearBlockers={clearBlockers}
                                                      onArchiveTask={archiveTask}
                                                      onDeleteTask={deleteTask}
                                                      onBulkDeleteTasks={bulkDelete}
                                                      onArchiveAllTasks={archiveTasks}
                                                      activeAgentTaskIds={activeAgentTaskIds}
                                                      onShutdownAgent={shutdownAgentForTask}
                                                      selectionResetKey={selectedProjectId}
                                                    />
                                                  </Suspense>
                                                )}
                                                {id === 'kanban' && filter.viewMode === 'list' && (
                                                  <Suspense fallback={null}>
                                                    <KanbanListView
                                                      tasks={displayTasks}
                                                      columns={selectedProject?.columns_config}
                                                      viewConfig={getViewConfig(filter)}
                                                      onTaskMove={handleTaskMove}
                                                      onTaskReorder={reorderTasks}
                                                      onTaskClick={handleTaskClick}
                                                      cardProperties={filter.cardProperties}
                                                      blockedTaskIds={blockedTaskIds}
                                                      allProjects={projects}
                                                      onUpdateTask={contextMenuUpdate}
                                                      onArchiveTask={archiveTask}
                                                      onDeleteTask={deleteTask}
                                                      tags={projectTags}
                                                      taskTags={taskTags}
                                                      onTaskTagsChange={handleTaskTagsChange}
                                                      activeAgentTaskIds={activeAgentTaskIds}
                                                      onShutdownAgent={shutdownAgentForTask}
                                                    />
                                                  </Suspense>
                                                )}
                                                {id === 'git' && (
                                                  <Suspense
                                                    fallback={
                                                      <div className="h-full animate-pulse bg-muted/30 rounded" />
                                                    }
                                                  >
                                                    <UnifiedGitPanel
                                                      ref={homePanel.homeGitPanelRef}
                                                      projectId={selectedProjectId}
                                                      projectPath={projectPath}
                                                      visible={isViewActive}
                                                      defaultTab={homePanel.homeGitDefaultTab}
                                                      onTabChange={homePanel.setHomeGitDefaultTab}
                                                      tasks={tasks}
                                                      filter={filter}
                                                      projects={projects}
                                                      onTaskClick={(t) => handleTaskClick(t)}
                                                      onUpdateTask={(data) =>
                                                        window.api.db.updateTask(data).then((t) => {
                                                          updateTask(t)
                                                          return t
                                                        })
                                                      }
                                                      detectedRepos={homeDetectedRepos}
                                                      selectedRepoName={
                                                        homeSelectedProject?.selected_repo
                                                      }
                                                      isRepoStale={homeResolvedRepo.stale}
                                                      onRepoChange={handleHomeRepoChange}
                                                    />
                                                  </Suspense>
                                                )}
                                                {id === 'editor' && (
                                                  <Suspense>
                                                    <FileEditorView
                                                      ref={homePanel.homeEditorRefCallback}
                                                      projectPath={projectPath ?? ''}
                                                    />
                                                  </Suspense>
                                                )}
                                                {id === 'processes' && (
                                                  <Suspense
                                                    fallback={
                                                      <div className="h-full animate-pulse bg-muted/30 rounded" />
                                                    }
                                                  >
                                                    <ProcessesPanel
                                                      taskId={null}
                                                      projectId={selectedProjectId}
                                                      cwd={projectPath}
                                                    />
                                                  </Suspense>
                                                )}
                                                {id === 'tests' && (
                                                  <Suspense
                                                    fallback={
                                                      <div className="h-full animate-pulse bg-muted/30 rounded" />
                                                    }
                                                  >
                                                    <TestPanel
                                                      projectId={selectedProjectId}
                                                      projectPath={projectPath}
                                                      groupBy={testGroupBy}
                                                      onOpenSettings={() => {
                                                        if (selectedProject)
                                                          openProjectSettings(selectedProject, {
                                                            initialTab: 'tests'
                                                          })
                                                      }}
                                                    />
                                                  </Suspense>
                                                )}
                                                {id === 'automations' && (
                                                  <Suspense
                                                    fallback={
                                                      <div className="h-full animate-pulse bg-muted/30 rounded" />
                                                    }
                                                  >
                                                    <AutomationsPanel
                                                      projectId={selectedProjectId}
                                                    />
                                                  </Suspense>
                                                )}
                                              </div>
                                            </React.Fragment>
                                          )
                                        })}
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
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

                  {agentSessionId &&
                    globalAgentPanelMountedRef.current &&
                    globalAgentPanelState.isOpen &&
                    !hideSidebarPanel && (
                      <ResizeHandle
                        // Edge side panel against the flex-1 main area. The boundary
                        // handle needs two widths; model the left (main) side as
                        // effectively unbounded so the drag just resizes this panel
                        // and the flex-1 main absorbs the slack. 100_000 is large
                        // enough that the left clamp never binds yet keeps the
                        // `total - newLeft` arithmetic exact. Max is enforced here.
                        leftWidth={100_000}
                        rightWidth={globalAgentPanelState.panelWidth}
                        leftMinWidth={0}
                        rightMinWidth={GLOBAL_AGENT_PANEL_MIN_WIDTH}
                        onResize={(_lw, rw) =>
                          setGlobalAgentPanelState({
                            panelWidth: Math.min(
                              GLOBAL_AGENT_PANEL_MAX_WIDTH,
                              Math.max(GLOBAL_AGENT_PANEL_MIN_WIDTH, rw)
                            )
                          })
                        }
                        onDragStart={() => setIsSidePanelResizing(true)}
                        onDragEnd={() => setIsSidePanelResizing(false)}
                        onReset={() =>
                          setGlobalAgentPanelState({ panelWidth: DEFAULT_GLOBAL_AGENT_PANEL_WIDTH })
                        }
                      />
                    )}
                  {agentSessionId && globalAgentPanelMountedRef.current && !hideSidebarPanel && (
                    <div
                      className={
                        globalAgentPanelState.isOpen ? 'min-h-0' : 'w-0 overflow-hidden invisible'
                      }
                      style={
                        globalAgentPanelState.isOpen ? undefined : { position: 'absolute' as const }
                      }
                    >
                      <Suspense fallback={null}>
                        <GlobalAgentSidePanel
                          width={globalAgentPanelState.panelWidth}
                          sessionId={agentSessionId}
                          cwd={projects.find((p) => p.id === selectedProjectId)?.path ?? ''}
                          mode={agentMode as import('@slayzone/terminal/shared').TerminalMode}
                          isActive={globalAgentPanelState.isOpen}
                          isResizing={isSidePanelResizing}
                          onNewSession={handleAgentNewSession}
                          onModeChange={handleAgentModeChange}
                          floatingEnabled={globalAgentPanelState.floatingEnabled}
                          onToggleFloating={() =>
                            setGlobalAgentPanelState({
                              floatingEnabled: !globalAgentPanelState.floatingEnabled
                            })
                          }
                          floatingState={floatingGlobalAgentPanelState.kind}
                          onDetach={() => window.api.floatingGlobalAgentPanel.detach()}
                          onReattach={() => window.api.floatingGlobalAgentPanel.reattach()}
                        />
                      </Suspense>
                    </div>
                  )}
                  {agentStatusState.isLocked && (
                    <ResizeHandle
                      // Edge side panel — left side modeled as unbounded (see the
                      // GlobalAgentSidePanel handle above); max enforced here.
                      leftWidth={100_000}
                      rightWidth={agentStatusState.panelWidth}
                      leftMinWidth={0}
                      rightMinWidth={AGENT_STATUS_PANEL_MIN_WIDTH}
                      onResize={(_lw, rw) =>
                        setAgentStatusState({
                          panelWidth: Math.min(
                            AGENT_STATUS_PANEL_MAX_WIDTH,
                            Math.max(AGENT_STATUS_PANEL_MIN_WIDTH, rw)
                          )
                        })
                      }
                      onDragStart={() => setIsSidePanelResizing(true)}
                      onDragEnd={() => setIsSidePanelResizing(false)}
                      onReset={() =>
                        setAgentStatusState({ panelWidth: DEFAULT_AGENT_STATUS_PANEL_WIDTH })
                      }
                    />
                  )}
                  {agentStatusState.isLocked && (
                    <Suspense fallback={null}>
                      <AgentStatusSidePanel
                        width={agentStatusState.panelWidth}
                        idleTasks={idleTasks}
                        filterCurrentProject={agentStatusState.filterCurrentProject}
                        onFilterToggle={() =>
                          setAgentStatusState({
                            filterCurrentProject: !agentStatusState.filterCurrentProject
                          })
                        }
                        onNavigate={openTask}
                        onDismiss={handleDismissIdle}
                        columnsByProjectId={columnsByProjectId}
                        selectedProjectId={selectedProjectId}
                        currentProjectName={projects.find((p) => p.id === selectedProjectId)?.name}
                      />
                    </Suspense>
                  )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Dialogs — lazy-mounted on first trigger, stay mounted for close/reopen animations */}
          {shouldMount('createTask', createTaskOpen) && (
            <Suspense fallback={null}>
              <CreateTaskDialog
                open={createTaskOpen}
                onOpenChange={(open) => {
                  if (!open) useDialogStore.getState().closeCreateTask()
                }}
                onCreated={handleTaskCreated}
                onCreatedAndOpen={handleTaskCreatedAndOpen}
                draft={createTaskDialogDraft}
                tags={projectTags}
                onTagCreated={(tag: Tag) => setTags((prev) => [...prev, tag])}
              />
            </Suspense>
          )}
          {shouldMount('editTask', !!editingTask) && (
            <Suspense fallback={null}>
              <EditTaskDialog
                task={editingTask}
                open={!!editingTask}
                onOpenChange={(open) => {
                  if (!open) useDialogStore.getState().closeEditTask()
                }}
                onUpdated={handleTaskUpdated}
              />
            </Suspense>
          )}
          {shouldMount('deleteTask', !!deletingTask) && (
            <Suspense fallback={null}>
              <DeleteTaskDialog
                task={deletingTask}
                open={!!deletingTask}
                onOpenChange={(open) => {
                  if (!open) useDialogStore.getState().closeDeleteTask()
                }}
                onDeleted={handleTaskDeleted}
              />
            </Suspense>
          )}
          {shouldMount('createProject', createProjectOpen) && (
            <Suspense fallback={null}>
              <CreateProjectDialog
                open={createProjectOpen}
                onOpenChange={(open) => {
                  if (!open) useDialogStore.getState().closeCreateProject()
                }}
                onCreated={handleProjectCreated}
              />
            </Suspense>
          )}
          {shouldMount('projectSettings', !!editingProject) && (
            <Suspense fallback={null}>
              <ProjectSettingsDialog
                project={editingProject}
                open={!!editingProject}
                onOpenChange={(open) => !open && closeProjectSettings()}
                initialTab={projectSettingsInitialTab}
                groupBy={testGroupBy}
                onGroupByChange={setTestGroupBy}
                integrationOnboardingProvider={projectSettingsOnboardingProvider}
                onIntegrationOnboardingHandled={() => setProjectSettingsOnboardingProvider(null)}
                onUpdated={handleProjectUpdated}
                onChanged={handleProjectChanged}
                renderTemplatesTab={(projectId) => <TemplatesSettingsTab projectId={projectId} />}
              />
            </Suspense>
          )}
          {shouldMount('deleteProject', !!deletingProject) && (
            <Suspense fallback={null}>
              <DeleteProjectDialog
                project={deletingProject}
                open={!!deletingProject}
                onOpenChange={(open) => {
                  if (!open) useDialogStore.getState().closeDeleteProject()
                }}
                onDeleted={handleProjectDeleted}
              />
            </Suspense>
          )}
          {groupSettingsTarget && (
            <Suspense fallback={null}>
              <GroupSettingsDialog
                group={groupSettingsTarget}
                open={!!groupSettingsTarget}
                onClose={() => useDialogStore.getState().closeGroupSettings()}
                onRename={(name) => renameProjectGroup(groupSettingsTarget.id, name)}
                onDelete={() => deleteProjectGroup(groupSettingsTarget.id)}
              />
            </Suspense>
          )}
          {shouldMount('settings', settingsOpen) && (
            <Suspense fallback={null}>
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
          )}
          {shouldMount('search', searchOpen) && (
            <Suspense fallback={null}>
              <SearchDialog
                open={searchOpen}
                onOpenChange={(open) => {
                  if (!open) useDialogStore.getState().closeSearch()
                }}
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
                onSelectTask={openTask}
                onSelectProject={setSelectedProjectId}
                onNewTask={() => useDialogStore.getState().openCreateTask()}
                onNewTemporaryTask={() => {
                  void handleCreateScratchTerminal()
                }}
                onReopenClosedTab={() => useTabStore.getState().reopenClosedTab()}
                onAddProject={() => useDialogStore.getState().openCreateProject()}
                onGoHome={() => {
                  const hi = useTabStore.getState().tabs.findIndex((t) => t.type === 'home')
                  if (hi >= 0) setActiveTabIndex(hi)
                }}
                onToggleGlobalAgentPanel={() => {
                  if (selectedProjectId)
                    setGlobalAgentPanelState({ isOpen: !globalAgentPanelState.isOpen })
                }}
                onOpenChangelog={() => useDialogStore.getState().openChangelog()}
                onOpenSettings={handleOpenSettings}
              />
            </Suspense>
          )}
          {shouldMount('onboarding', shouldMountOnboarding) && (
            <Suspense fallback={null}>
              <OnboardingDialog
                externalOpen={onboardingOpen}
                onExternalClose={async () => {
                  useDialogStore.getState().closeOnboarding()
                  const [onboardingCompleted, prompted] = await Promise.all([
                    window.api.settings.get('onboarding_completed'),
                    window.api.settings.get('tutorial_prompted')
                  ])
                  if (onboardingCompleted === 'true') markSetupGuideCompleted()
                  if (!prompted) {
                    void window.api.settings.set('tutorial_prompted', 'true')
                    toast('Want a quick tour?', {
                      duration: 8000,
                      action: { label: 'Take the tour', onClick: startTour }
                    })
                  }
                }}
              />
            </Suspense>
          )}
          <Suspense fallback={null}>
            <CliInstallDialog />
          </Suspense>
          {shouldMount('tutorial', showAnimatedTour) && (
            <Suspense fallback={null}>
              <TutorialAnimationModal
                open={showAnimatedTour}
                onClose={() => useDialogStore.getState().closeAnimatedTour()}
              />
            </Suspense>
          )}
          {shouldMount('changelog', changelogOpen || autoChangelogOpen) && (
            <Suspense fallback={null}>
              <ChangelogDialog
                open={changelogOpen || autoChangelogOpen}
                onOpenChange={(open) => {
                  if (!open) {
                    useDialogStore.getState().closeChangelog()
                    dismissAutoChangelog()
                  }
                }}
                lastSeenVersion={autoChangelogOpen ? lastSeenVersion : null}
              />
            </Suspense>
          )}
          <AlertDialog
            open={completeTaskDialogOpen}
            onOpenChange={(open) => {
              if (!open) useDialogStore.getState().closeCompleteTaskDialog()
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Complete Task</AlertDialogTitle>
                <AlertDialogDescription>Mark as complete and close tab?</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction autoFocus onClick={handleCompleteTaskConfirm}>
                  Complete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <UpdateToast
            version={updateToastDismissed ? null : updateVersion}
            onRestart={() => window.api.app.restartForUpdate()}
            onDismiss={() => setUpdateToastDismissed(true)}
          />
          <Suspense fallback={null}>
            <TerminalStatusDialog tasks={tasks} onTaskClick={openTask} />
          </Suspense>
          <Toaster position="bottom-right" theme="dark" closeButton />
        </div>
      </SidebarProvider>
    </AppearanceProvider>
  )
}

export default App
