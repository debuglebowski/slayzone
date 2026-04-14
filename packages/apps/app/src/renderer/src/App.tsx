import React, { Suspense, lazy, useState, useEffect, useRef, useMemo, useCallback, useTransition } from 'react'
import { useGuardedHotkeys } from '@slayzone/ui'
import { initShortcuts } from './shortcut-init'
import { AlertTriangle, FolderClosed, LayoutGrid, TerminalSquare, GitBranch, FileCode, Cpu, Kanban, FlaskConical, Zap, BookOpen } from 'lucide-react'
import { buildCreateTaskDraftFromBrowserLink } from '@slayzone/task/shared'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import { getDefaultStatus, getDoneStatus, getStatusByCategory, resolveRepoPath } from '@slayzone/projects/shared'
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
  useSnoozeWakeUp
} from '@slayzone/tasks'
import { ResizeHandle } from '@slayzone/task/client/ResizeHandle'
import { usePanelSizes } from '@slayzone/task/client/usePanelSizes'
import { usePanelConfig } from '@slayzone/task/client/usePanelConfig'
import { useDetectedRepos } from '@slayzone/projects/client/useDetectedRepos'
import type { ProjectCreationContext, ProjectStartMode } from '@slayzone/projects'
import { ProjectLockPopover, ProjectLockScreen, isRateLimited, recordTaskOpen, isProjectDurationLocked } from '@slayzone/projects'
import { useTabStore, useDialogStore, AppearanceProvider, type SearchFileContext } from '@slayzone/settings'
import { track, trackShortcut } from '@slayzone/telemetry/client'
import { usePty } from '@slayzone/terminal/client'
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
  UpdateToast
} from '@slayzone/ui'
import { SidebarProvider, cn, PanelToggle, useUndo, matchesShortcut, useShortcutStore, shortcutDefinitions, useShortcutDisplay, withShortcut, withModalGuard, scopeTracker } from '@slayzone/ui'
import { AppSidebar } from '@/components/sidebar/AppSidebar'
import { useChangelogAutoOpen } from '@/components/changelog/useChangelogAutoOpen'
import { useStaleSkillCount } from '@/hooks/useStaleSkillCount'
import { TabBar } from '@/components/tabs/TabBar'
import {
  DesktopNotificationToggle,
  NotificationButton,
  NotificationSidePanel,
  NOTIFICATION_PANEL_MIN_WIDTH,
  NOTIFICATION_PANEL_MAX_WIDTH,
  useAttentionTasks,
  useNotificationState,
  DEFAULT_NOTIFICATION_PANEL_WIDTH
} from '@/components/notifications'
import { AgentPanelButton, AgentSidePanel, AGENT_PANEL_MIN_WIDTH, AGENT_PANEL_MAX_WIDTH, useAgentPanelState, DEFAULT_AGENT_PANEL_WIDTH } from '@/components/agent-panel'
import { UsagePopover } from '@/components/usage/UsagePopover'
import { BoostPill } from '@/components/usage/BoostPill'
import { useUsage } from '@/components/usage/useUsage'
import { useOnboardingChecklist } from '@/hooks/useOnboardingChecklist'
import { TaskShell } from '@slayzone/task/client/TaskShell'
// Extracted hooks (self-contained, clean interfaces)
import { useHomePanel, HOME_PANEL_ORDER, HOME_PANEL_SIZE_KEY } from '@/hooks/useHomePanel'
import { useTerminalStateTracking } from '@/hooks/useTerminalStateTracking'
import { useTabLifecycle } from '@/hooks/useTabLifecycle'
import { useTabColors } from '@/hooks/useTabColors'
import { useVisibleTabs } from '@/hooks/useVisibleTabs'
import { useDiagnosticsSync } from '@/hooks/useDiagnosticsSync'
// Lazy-loaded: heavy components not needed for first paint
const TaskDetailDataLoader = lazy(() => import('@slayzone/task/client/TaskDetailDataLoader').then(m => ({ default: m.TaskDetailDataLoader })))
const FileEditorView = lazy(() => import('@slayzone/file-editor/client/FileEditorView').then(m => ({ default: m.FileEditorView })))
const UserSettingsDialog = lazy(() => import('@slayzone/settings/client/UserSettingsDialog').then(m => ({ default: m.UserSettingsDialog })))
const TutorialAnimationModal = lazy(() => import('@/components/tutorial/TutorialAnimationModal').then(m => ({ default: m.TutorialAnimationModal })))
// Home panels
const UnifiedGitPanel = lazy(() => import('@slayzone/worktrees').then(m => ({ default: m.UnifiedGitPanel })))
const TestPanel = lazy(() => import('@slayzone/test-panel').then(m => ({ default: m.TestPanel })))
const ProcessesPanel = lazy(() => import('@slayzone/task').then(m => ({ default: m.ProcessesPanel })))
const AutomationsPanel = lazy(() => import('@slayzone/automations').then(m => ({ default: m.AutomationsPanel })))
// Overlay pages
const LeaderboardPage = lazy(() => import('@/components/leaderboard/LeaderboardPage').then(m => ({ default: m.LeaderboardPage })))
const UsageAnalyticsPage = lazy(() => import('@slayzone/usage-analytics/client').then(m => ({ default: m.UsageAnalyticsPage })))
const ContextManagerPage = lazy(() => import('@slayzone/ai-config/client').then(m => ({ default: m.ContextManagerPage })))
// Dialogs
const CreateTaskDialog = lazy(() => import('@slayzone/task').then(m => ({ default: m.CreateTaskDialog })))
const EditTaskDialog = lazy(() => import('@slayzone/task').then(m => ({ default: m.EditTaskDialog })))
const DeleteTaskDialog = lazy(() => import('@slayzone/task').then(m => ({ default: m.DeleteTaskDialog })))
const TemplatesSettingsTab = lazy(() => import('@slayzone/task').then(m => ({ default: m.TemplatesSettingsTab })))
const CreateProjectDialog = lazy(() => import('@slayzone/projects').then(m => ({ default: m.CreateProjectDialog })))
const ProjectSettingsDialog = lazy(() => import('@slayzone/projects').then(m => ({ default: m.ProjectSettingsDialog })))
const DeleteProjectDialog = lazy(() => import('@slayzone/projects').then(m => ({ default: m.DeleteProjectDialog })))
const OnboardingDialog = lazy(() => import('@slayzone/onboarding').then(m => ({ default: m.OnboardingDialog })))
const SearchDialog = lazy(() => import('@/components/dialogs/SearchDialog').then(m => ({ default: m.SearchDialog })))
const CliInstallDialog = lazy(() => import('@/components/dialogs/CliInstallDialog').then(m => ({ default: m.CliInstallDialog })))
const ChangelogDialog = lazy(() => import('@/components/changelog/ChangelogDialog').then(m => ({ default: m.ChangelogDialog })))

type ProjectSettingsTab = 'general' | 'environment' | 'tasks' | 'tasks/general' | 'tasks/statuses' | 'integrations' | 'ai-config' | 'tests'
type ProjectIntegrationOnboardingProvider = Exclude<ProjectStartMode, 'scratch'>
type ContextManagerSection = 'providers' | 'instructions' | 'skill' | 'mcp' | 'files' | 'provider-sync' | 'skills' | 'mcps'
const COMMUNITY_DISCORD_URL = 'https://discord.gg/g7xPHXaU98'
const COMMUNITY_X_URL = 'https://x.com/debuglebowski'

// Lazy-mount: first trigger loads the chunk + mounts; stays mounted after so close/reopen animations work.
function useLazyMounted() {
  const set = useRef(new Set<string>())
  return (key: string, open: boolean) => { if (open) set.current.add(key); return set.current.has(key) }
}

function App(): React.JSX.Element {
  performance.mark('sz:app:render')
  const shouldMount = useLazyMounted()
  // Core data from domain hook
  const {
    tasks, projects, tags, taskTags, blockedTaskIds,
    setTasks, setProjects, setTags, setTaskTags,
    updateTask, moveTask, reorderTasks,
    archiveTask: rawArchiveTask, archiveTasks: rawArchiveTasks,
    deleteTask: rawDeleteTask, contextMenuUpdate: rawContextMenuUpdate,
    updateProject, reorderProjects, deleteProject
  } = useTasksData()

  // Snooze wake-up timer — clears snooze + notifies when expiry passes
  useSnoozeWakeUp(tasks)

  // Undo/redo stack
  const { push: pushUndo, undo, redo } = useUndo()
  const { contextMenuUpdate, archiveTask, archiveTasks, deleteTask } = useUndoableTaskActions(
    { tasks, updateTask, setTasks, archiveTask: rawArchiveTask, archiveTasks: rawArchiveTasks, deleteTask: rawDeleteTask, contextMenuUpdate: rawContextMenuUpdate },
    { push: pushUndo, undo }
  )

  // View state (tabs + selected project, persisted via zustand)
  const tabs = useTabStore((s) => s.tabs)
  const activeTabIndex = useTabStore((s) => s.activeTabIndex)
  const activeView = useTabStore((s) => s.activeView)
  const selectedProjectId = useTabStore((s) => s.selectedProjectId)
  const { setActiveTabIndex, setSelectedProjectId, openTask: rawOpenTask, openTaskInBackground, reorderTabs, reopenClosedTab } = useTabStore.getState()
  const [, startTransition] = useTransition()

  // Expose tab store for e2e tests
  if (!(window as any).__slayzone_tabStore) (window as any).__slayzone_tabStore = useTabStore
  if (!(window as any).__slayzone_dialogStore) (window as any).__slayzone_dialogStore = useDialogStore

  // Filter state (persisted per project)
  const [filter, setFilter] = useFilterState(selectedProjectId)

  // Dialog state (from zustand store — see useDialogStore)
  const createTaskOpen = useDialogStore((s) => s.createTaskOpen)
  const createTaskDraft = useDialogStore((s) => s.createTaskDraft)
  const editingTask = useDialogStore((s) => s.editingTask)
  const deletingTask = useDialogStore((s) => s.deletingTask)
  const createProjectOpen = useDialogStore((s) => s.createProjectOpen)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [projectSettingsInitialTab, setProjectSettingsInitialTab] = useState<ProjectSettingsTab>('general')
  const [testGroupBy, setTestGroupBy] = useState<'none' | 'path' | 'label'>('none')
  const [projectSettingsOnboardingProvider, setProjectSettingsOnboardingProvider] =
    useState<ProjectIntegrationOnboardingProvider | null>(null)
  const deletingProject = useDialogStore((s) => s.deletingProject)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const [colorTintsEnabled, setColorTintsEnabled] = useState(true)
  const [contextManagerEnabled, setContextManagerEnabled] = useState(false)
  const [testsPanelEnabled, setTestsPanelEnabled] = useState(false)
  const [automationsPanelEnabled, setAutomationsPanelEnabled] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<string>('appearance')
  const [settingsInitialAiConfigSection, setSettingsInitialAiConfigSection] = useState<ContextManagerSection | null>(null)
  const onboardingOpen = useDialogStore((s) => s.onboardingOpen)
  const [shouldMountOnboarding, setShouldMountOnboarding] = useState(onboardingOpen)
  const changelogOpen = useDialogStore((s) => s.changelogOpen)
  const [autoChangelogOpen, lastSeenVersion, dismissAutoChangelog] = useChangelogAutoOpen()
  const searchOpen = useDialogStore((s) => s.searchOpen)
  const completeTaskDialogOpen = useDialogStore((s) => s.completeTaskDialogOpen)
  const [terminalFocusRequests, setTerminalFocusRequests] = useState<Record<string, number>>({})
  const [zenMode, setZenMode] = useState(false)
  const [explodeMode, setExplodeMode] = useState(false)
  const [panelSizes, updatePanelSizes, resetPanelSize] = usePanelSizes()
  const { isBuiltinEnabled: isHomePanelEnabled } = usePanelConfig()
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)

  // Home panel state (extracted — owns its own state fully)
  const homePanel = useHomePanel(selectedProjectId, panelSizes)

  // Multi-repo detection for home tab
  const homeSelectedProject = useMemo(() => projects.find(p => p.id === selectedProjectId), [projects, selectedProjectId])
  const homeDetectedRepos = useDetectedRepos(homeSelectedProject?.path ?? null)
  const homeResolvedRepo = useMemo(
    () => resolveRepoPath(homeSelectedProject?.path ?? null, homeDetectedRepos, homeSelectedProject?.selected_repo ?? null),
    [homeSelectedProject?.path, homeDetectedRepos, homeSelectedProject?.selected_repo]
  )
  const handleHomeRepoChange = useCallback((repoName: string) => {
    if (!homeSelectedProject) return
    window.api.db.updateProject({ id: homeSelectedProject.id, selectedRepo: repoName }).then((updated) => {
      updateProject(updated)
    })
  }, [homeSelectedProject?.id, updateProject])

  // Project path validation
  const [projectPathMissing, setProjectPathMissing] = useState(false)
  const validateProjectPath = useCallback(async (project: Project | undefined) => {
    if (!project?.path) { setProjectPathMissing(false); return }
    const fn = window.api.files?.pathExists
    if (typeof fn !== 'function') return
    setProjectPathMissing(!(await fn(project.path)))
  }, [])

  // Project rename state
  const [projectNameValue, setProjectNameValue] = useState('')
  const projectNameInputRef = useRef<HTMLTextAreaElement>(null)

  // Terminal state tracking (extracted — pure input/output)
  const ptyContext = usePty()
  const openTaskIds = useMemo(
    () => tabs.filter((t): t is { type: 'task'; taskId: string; title: string } => t.type === 'task').map((t) => t.taskId),
    [tabs]
  )
  const terminalStates = useTerminalStateTracking(openTaskIds, ptyContext)

  // Tab lifecycle (extracted — manages sync, cleanup, cache eviction, page tracking)
  useTabLifecycle({ tasks, projects, tabs, activeTabIndex, setTasks, ptyContext, setTerminalFocusRequests })

  // Tab colors (extracted — pure derivation)
  const { taskProjectColors, taskWorktreeColors, tabCycleOrder } = useTabColors(tabs, tasks, projects, colorTintsEnabled)

  // Onboarding
  const showAnimatedTour = useDialogStore((s) => s.showAnimatedTour)
  const handleChecklistCheckLeaderboard = useCallback((): void => {
    useTabStore.getState().setActiveView('leaderboard')
  }, [])
  const handleChecklistJoinCommunity = useCallback((): void => { void window.api.shell.openExternal(COMMUNITY_DISCORD_URL) }, [])
  const handleChecklistFollowOnX = useCallback((): void => { void window.api.shell.openExternal(COMMUNITY_X_URL) }, [])

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

  useEffect(() => { performance.mark('sz:app:mounted') }, [])
  useEffect(() => { return initShortcuts() }, [])

  useEffect(() => {
    Promise.all([
      window.api.settings.get('onboarding_completed'),
      window.api.settings.get('tutorial_prompted')
    ]).then(([onboarded, prompted]) => {
      if (onboarded === 'true' && !prompted) {
        void window.api.settings.set('tutorial_prompted', 'true')
        toast('Want a quick tour?', { duration: 8000, action: { label: 'Take the tour', onClick: startTour } })
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

  // Usage, notification & agent panel state
  const { data: usageData, refresh: refreshUsage } = useUsage()
  const [notificationState, setNotificationState] = useNotificationState()
  const [agentPanelState, setAgentPanelState] = useAgentPanelState()
  const [isSidePanelResizing, setIsSidePanelResizing] = useState(false)
  const agentPanelMountedRef = useRef(false)
  if (agentPanelState.isOpen) agentPanelMountedRef.current = true
  const agentMode = agentPanelState.mode ?? 'claude-code'
  useEffect(() => {
    if (agentPanelState.mode) return
    window.api.settings.get('default_terminal_mode').then(m => {
      if (m) setAgentPanelState({ mode: m })
    })
  }, [agentPanelState.mode, setAgentPanelState])
  const { attentionTasks: allAttentionTasks, refresh: refreshAttentionTasks } = useAttentionTasks(tasks, null)
  const attentionTasks = useMemo(
    () => notificationState.filterCurrentProject
      ? allAttentionTasks.filter((at) => at.task.project_id === selectedProjectId)
      : allAttentionTasks,
    [allAttentionTasks, notificationState.filterCurrentProject, selectedProjectId]
  )
  const attentionByProject = useMemo(() => {
    const map = new Map<string, number>()
    for (const at of allAttentionTasks) map.set(at.task.project_id, (map.get(at.task.project_id) ?? 0) + 1)
    return map
  }, [allAttentionTasks])

  const selectedProject = useMemo(() => projects.find((p) => p.id === selectedProjectId) ?? null, [projects, selectedProjectId])

  // Project lock guard — wraps all task-open paths
  const durationLocked = isProjectDurationLocked(selectedProject)
  const guardTaskOpen = useCallback((taskId: string, fn: (id: string) => void) => {
    if (durationLocked) return
    const existing = useTabStore.getState().tabs.some(t => t.type === 'task' && t.taskId === taskId)
    if (!existing && selectedProject && isRateLimited(selectedProject)) {
      toast('Task limit reached — try again later')
      return
    }
    if (!existing && selectedProject) recordTaskOpen(selectedProject.id)
    fn(taskId)
  }, [durationLocked, selectedProject])

  const openTask = useCallback((taskId: string) => {
    guardTaskOpen(taskId, (id) => startTransition(() => rawOpenTask(id)))
  }, [guardTaskOpen, rawOpenTask, startTransition])

  const guardedOpenTaskInBackground = useCallback((taskId: string) => {
    guardTaskOpen(taskId, openTaskInBackground)
  }, [guardTaskOpen, openTaskInBackground])

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
    if (!selectedProjectId || !projects.some((p) => p.id === selectedProjectId)) setSelectedProjectId(projects[0].id)
  }, [projects, selectedProjectId, setSelectedProjectId])

  // Task lookup map (used for tab props and active-tab project switching)
  const tasksMap = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])

  // Visible tabs (project-scoped filtering — purely visual, full tabs stay mounted)
  const { visibleTabs, visibleActiveIndex, toFullIndex, toVisibleIndex } = useVisibleTabs(tabs, tasksMap)

  // Auto-switch project when activating a task tab
  const activeTab = tabs[activeTabIndex]
  const activeTaskProjectId = activeTab?.type === 'task' ? tasksMap.get(activeTab.taskId)?.project_id : undefined
  useEffect(() => {
    if (activeTaskProjectId && activeTaskProjectId !== selectedProjectId) setSelectedProjectId(activeTaskProjectId)
  }, [activeTaskProjectId, selectedProjectId, setSelectedProjectId])

  // Auto-disable explode mode when fewer than 2 task tabs
  useEffect(() => { if (openTaskIds.length < 2) setExplodeMode(false) }, [openTaskIds.length])

  // Read settings on mount and whenever settings change
  useEffect(() => {
    window.api.settings.get('project_color_tints_enabled').then((v) => setColorTintsEnabled(v !== '0'))
    window.api.app.isContextManagerEnabled().then(setContextManagerEnabled)
    window.api.app.isTestsPanelEnabled().then(setTestsPanelEnabled)
    window.api.app.isAutomationsEnabled().then(setAutomationsPanelEnabled)
  }, [settingsRevision])

  // Close context manager when lab is disabled
  useEffect(() => {
    if (!contextManagerEnabled && useTabStore.getState().activeView === 'context') useTabStore.getState().setActiveView('tabs')
  }, [contextManagerEnabled])

  useEffect(() => {
    if (selectedProjectId) {
      const project = projects.find((p) => p.id === selectedProjectId)
      if (project) setProjectNameValue(project.name)
    }
  }, [selectedProjectId, projects])

  useEffect(() => { validateProjectPath(projects.find((p) => p.id === selectedProjectId)) }, [selectedProjectId, projects, validateProjectPath])

  useEffect(() => {
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project?.path) return
    const handleFocus = (): void => { validateProjectPath(project) }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [selectedProjectId, projects, validateProjectPath])

  // Computed values
  const projectTasks = selectedProjectId ? tasks.filter((t) => t.project_id === selectedProjectId) : []
  const projectTags = selectedProjectId ? tags.filter((t) => t.project_id === selectedProjectId) : tags
  const displayTasks = applyFilters(projectTasks, filter, taskTags, selectedProject?.columns_config)
  const projectsMap = new Map(projects.map((p) => [p.id, p]))
  const createTaskDialogDraft = useMemo(
    () => ({ projectId: selectedProjectId || projects[0]?.id, ...createTaskDraft }),
    [selectedProjectId, projects, createTaskDraft]
  )

  const handleTaskTagsChange = async (taskId: string, tagIds: string[]) => {
    await window.api.taskTags.setTagsForTask(taskId, tagIds)
    setTaskTags((prev) => { const next = new Map(prev); next.set(taskId, tagIds); return next })
  }

  // Diagnostics (extracted — fire-and-forget side effects)
  useDiagnosticsSync({ tabs, activeTabIndex, activeView, selectedProjectId, projects, tasks, displayTaskCount: displayTasks.length, notificationState, projectPathMissing })

  // Shortcut store (dynamic hotkey bindings)
  const overrides = useShortcutStore((s) => s.overrides)
  const isRecording = useShortcutStore((s) => s.isRecording)
  // Resolve effective keys from overrides + defaults. Subscribing to `overrides` above
  // ensures re-render when shortcuts change, so useHotkeys picks up new key strings.
  const getKeys = useCallback((id: string): string => {
    if (overrides[id]) return overrides[id]
    const def = shortcutDefinitions.find(d => d.id === id)
    return def?.defaultKeys ?? ''
  }, [overrides])
  useEffect(() => {
    useShortcutStore.getState().load()
  }, [])

  // Shortcut display strings (reactive to user customization)
  const projectScopedTabs = useTabStore((s) => s.projectScopedTabs)
  const explodeModeShortcut = useShortcutDisplay('explode-mode')
  const projectTabsShortcut = useShortcutDisplay('toggle-project-tabs')
  const newTempTaskShortcut = useShortcutDisplay('new-temp-task')
  const panelGitShortcut = useShortcutDisplay('panel-git')
  const panelEditorShortcut = useShortcutDisplay('panel-editor')
  const panelProcessesShortcut = useShortcutDisplay('panel-processes')
  const panelTestsShortcut = useShortcutDisplay('panel-tests')
  const panelAutomationsShortcut = useShortcutDisplay('panel-automations')
  const attentionPanelShortcut = useShortcutDisplay('attention-panel')
  const agentPanelShortcut = useShortcutDisplay('agent-panel')
  const agentSessionId = selectedProjectId ? `__agent-panel:${selectedProjectId}:${agentPanelState.sessionIndex}` : null

  const handleAgentNewSession = useCallback(async () => {
    if (agentSessionId) await window.api.pty.kill(agentSessionId)
    setAgentPanelState({ sessionIndex: (agentPanelState.sessionIndex ?? 0) + 1 })
  }, [agentSessionId, agentPanelState.sessionIndex, setAgentPanelState])

  const handleAgentModeChange = useCallback(async (nextMode: string) => {
    if (nextMode === agentMode) return
    if (agentSessionId) await window.api.pty.kill(agentSessionId)
    setAgentPanelState({ mode: nextMode, sessionIndex: (agentPanelState.sessionIndex ?? 0) + 1 })
  }, [agentMode, agentSessionId, agentPanelState.sessionIndex, setAgentPanelState])

  // Floating agent panel: push context to main-process state machine.
  // All detach/reattach decisions happen in main; renderer just keeps ctx in sync.
  useEffect(() => {
    window.api.floatingAgent.setSessionId(agentSessionId)
  }, [agentSessionId])
  useEffect(() => {
    window.api.floatingAgent.setPanelOpen(agentPanelState.isOpen)
  }, [agentPanelState.isOpen])
  useEffect(() => {
    window.api.floatingAgent.setEnabled(agentPanelState.floatingEnabled)
  }, [agentPanelState.floatingEnabled])

  // Subscribe to floating-agent state for menu label + sidebar visibility.
  const [floatingAgentState, setFloatingAgentState] = useState<{ kind: 'attached' | 'detached' | 'disabled'; mode: 'auto' | 'manual' | null }>({ kind: 'attached', mode: null })
  useEffect(() => {
    window.api.floatingAgent.getState().then((s) => {
      setFloatingAgentState({ kind: s.kind as 'attached' | 'detached' | 'disabled', mode: s.mode })
    })
    return window.api.floatingAgent.onState((s) => {
      setFloatingAgentState({ kind: s.kind as 'attached' | 'detached' | 'disabled', mode: s.mode })
    })
  }, [])
  // Hide sidebar panel when manually detached (auto mode keeps panel visible to avoid layout flash).
  const hideSidebarPanel = floatingAgentState.kind === 'detached' && floatingAgentState.mode === 'manual'

  // Keyboard shortcuts
  useGuardedHotkeys(getKeys('new-task'), (e) => {
    if (projects.length > 0) { e.preventDefault(); trackShortcut(getKeys('new-task')); useDialogStore.getState().openCreateTask() }
  }, { enableOnFormTags: true, enabled: !isRecording })

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

  useGuardedHotkeys(getKeys('search'), (e) => {
    // Only fire on home tab; TaskDetailPage owns the search shortcut when a task tab is active.
    if (tabs[activeTabIndex]?.type !== 'home') return
    e.preventDefault()
    trackShortcut(getKeys('search'))
    useDialogStore.getState().openSearch({ fileContext: buildHomeFileContext() })
  }, { enableOnFormTags: true, enabled: !isRecording })

  useGuardedHotkeys('mod+z', async (e) => {
    const el = e.target as HTMLElement
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
    if (el.closest?.('.cm-editor') || el.closest?.('.xterm')) return
    e.preventDefault()
    const label = await undo()
    if (label) { track('undo_used'); toast(`Undid: ${label}`) }
  }, { enableOnFormTags: true, enabled: !isRecording })

  useGuardedHotkeys('mod+shift+z', async (e) => {
    const el = e.target as HTMLElement
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return
    if (el.closest?.('.cm-editor') || el.closest?.('.xterm')) return
    e.preventDefault()
    const label = await redo()
    if (label) { track('redo_used'); toast(`Redid: ${label}`) }
  }, { enableOnFormTags: true, enabled: !isRecording })

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

  useEffect(() => { return window.api.app.onCloseActiveTask(() => closeActiveTaskRef.current()) }, [])
  useEffect(() => { return window.api.app.onCloseCurrent(() => closeCurrentHomeRef.current()) }, [])
  useEffect(() => { return window.api.app.onCloseTask((taskId) => { useTabStore.getState().closeTabByTaskId(taskId) }) }, [])
  useEffect(() => { return window.api.app.onOpenTask((taskId) => { openTaskRef.current(taskId) }) }, [])
  useEffect(() => {
    return window.api.app.onGoHome(() => {
      const homeIndex = useTabStore.getState().tabs.findIndex((tab) => tab.type === 'home')
      if (homeIndex >= 0) setActiveTabIndex(homeIndex)
    })
  }, [])
  useEffect(() => {
    return window.api.app.onToggleAttentionPanel(() => {
      setNotificationState({ isLocked: !notificationState.isLocked })
    })
  }, [notificationState.isLocked])
  useEffect(() => {
    return window.api.app.onToggleAgentPanel(() => {
      if (selectedProjectId) setAgentPanelState({ isOpen: !agentPanelState.isOpen })
    })
  }, [selectedProjectId, agentPanelState.isOpen])
  useEffect(() => {
    return window.api.app.onOpenSettings(() => {
      setSettingsInitialTab('appearance'); setSettingsInitialAiConfigSection(null); setSettingsOpen(true)
    })
  }, [])
  useEffect(() => {
    return window.api.app.onOpenProjectSettings(() => {
      if (!selectedProjectId) return
      const project = projects.find((p) => p.id === selectedProjectId)
      if (!project) return
      setProjectSettingsInitialTab('general'); setProjectSettingsOnboardingProvider(null); setEditingProject(project)
    })
  }, [selectedProjectId, projects])

  useEffect(() => {
    return window.api.app.onUpdateStatus((status) => {
      switch (status.type) {
        case 'checking': toast.loading('Checking for updates...', { id: 'update-check' }); break
        case 'downloading': toast.loading(`Downloading update... ${status.percent}%`, { id: 'update-check' }); break
        case 'downloaded': toast.dismiss('update-check'); setUpdateVersion(status.version); break
        case 'not-available': toast.success('You\'re on the latest version', { id: 'update-check' }); break
        case 'error': toast.dismiss('update-check'); toast.error(`Update failed: ${status.message}`, { duration: 8000 }); break
      }
    })
  }, [])

  useGuardedHotkeys('mod+1,mod+2,mod+3,mod+4,mod+5,mod+6,mod+7,mod+8,mod+9', (e) => {
    e.preventDefault()
    const num = parseInt(e.key, 10)
    if (num < visibleTabs.length) setActiveTabIndex(toFullIndex(num))
  }, { enableOnFormTags: true, enabled: !isRecording })

  useGuardedHotkeys('mod+shift+1,mod+shift+2,mod+shift+3,mod+shift+4,mod+shift+5,mod+shift+6,mod+shift+7,mod+shift+8,mod+shift+9', (e) => {
    e.preventDefault()
    const num = parseInt(e.code.replace('Digit', ''), 10)
    if (num > 0 && num <= projects.length) { setSelectedProjectId(projects[num - 1].id); setActiveTabIndex(0) }
  }, { enableOnFormTags: true, enabled: !isRecording })

  const navigateCycle = useCallback((direction: 1 | -1) => {
    const filtered = tabCycleOrder.filter((i) => toVisibleIndex(i) >= 0)
    const cycle: ('context' | number)[] = [...filtered]
    if (contextManagerEnabled && cycle.length > 0) cycle.splice(1, 0, 'context')
    if (cycle.length === 0) return
    const { activeTabIndex: idx, activeView: view } = useTabStore.getState()
    const pos = view === 'context' ? cycle.indexOf('context') : cycle.indexOf(idx)
    const current = pos >= 0 ? pos : 0
    const target = cycle[(current + direction + cycle.length) % cycle.length]
    if (target === 'context') {
      useTabStore.getState().setActiveView('context')
    } else {
      useTabStore.getState().setActiveView('tabs')
      setActiveTabIndex(target)
    }
  }, [tabCycleOrder, toVisibleIndex, contextManagerEnabled, setActiveTabIndex])

  useGuardedHotkeys(getKeys('next-tab'), (e) => {
    e.preventDefault()
    navigateCycle(1)
  }, { enableOnFormTags: true, enabled: !isRecording })

  useGuardedHotkeys(getKeys('prev-tab'), (e) => {
    e.preventDefault()
    navigateCycle(-1)
  }, { enableOnFormTags: true, enabled: !isRecording })

  useGuardedHotkeys(getKeys('reopen-closed-tab'), (e) => { e.preventDefault(); track('tab_reopened'); reopenClosedTab() }, { enableOnFormTags: true, enabled: !isRecording })

  useGuardedHotkeys(getKeys('toggle-project-tabs'), (e) => { e.preventDefault(); trackShortcut(getKeys('toggle-project-tabs')); useTabStore.getState().toggleProjectScopedTabs() }, { enableOnFormTags: true, enabled: !isRecording })

  useGuardedHotkeys(getKeys('complete-close-tab'), (e) => {
    e.preventDefault()
    if (tabs[activeTabIndex].type === 'task') useDialogStore.getState().openCompleteTaskDialog()
  }, { enableOnFormTags: true, enabled: !isRecording })

  useGuardedHotkeys(getKeys('zen-mode'), (e) => { e.preventDefault(); track('zen_mode_toggled'); trackShortcut(getKeys('zen-mode')); setZenMode(prev => !prev) }, { enableOnFormTags: true, enabled: !isRecording })

  useGuardedHotkeys(getKeys('explode-mode'), (e) => {
    e.preventDefault()
    if (openTaskIds.length >= 2) { track('explode_mode_toggled'); trackShortcut(getKeys('explode-mode')); setExplodeMode(prev => !prev) }
  }, { enableOnFormTags: true, enabled: !isRecording })

  useGuardedHotkeys(getKeys('exit-zen-explode'), () => { if (explodeMode) setExplodeMode(false); else if (zenMode) setZenMode(false) }, { enableOnFormTags: true, enabled: !isRecording })

  useGuardedHotkeys(getKeys('attention-panel'), (e) => { e.preventDefault(); trackShortcut(getKeys('attention-panel')); setNotificationState({ isLocked: !notificationState.isLocked }) }, { enableOnFormTags: true, enabled: !isRecording })
  useGuardedHotkeys(getKeys('agent-panel'), (e) => { e.preventDefault(); trackShortcut(getKeys('agent-panel')); if (selectedProjectId) setAgentPanelState({ isOpen: !agentPanelState.isOpen }) }, { enableOnFormTags: true, enabled: !isRecording })

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
          if (!homePanel.homePanelVisibility.editor) homePanel.setHomePanelVisibility(prev => ({ ...prev, editor: true }))
          homePanel.homeEditorRef.current.toggleSearch()
        } else {
          homePanel.pendingHomeSearchToggleRef.current = true
          homePanel.setHomePanelVisibility(prev => ({ ...prev, editor: true }))
        }
        return
      }

      // Git Diff (panel-git-diff)
      if (matchesShortcut(e, getKeys('panel-git-diff')) && isHomePanelEnabled('git', 'home')) {
        e.preventDefault()
        if (!homePanel.homePanelVisibility.git) {
          homePanel.setHomeGitDefaultTab('changes')
          homePanel.setHomePanelVisibility(prev => ({ ...prev, git: true }))
        } else if (homePanel.homeGitPanelRef.current?.getActiveTab() === 'changes') {
          homePanel.setHomePanelVisibility(prev => ({ ...prev, git: false }))
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
          homePanel.setHomePanelVisibility(prev => ({ ...prev, git: true }))
        } else if (homePanel.homeGitPanelRef.current?.getActiveTab() === 'general') {
          homePanel.setHomePanelVisibility(prev => ({ ...prev, git: false }))
        } else {
          homePanel.homeGitPanelRef.current?.switchToTab('general')
        }
      } else if (matchesShortcut(e, getKeys('panel-editor')) && isHomePanelEnabled('editor', 'home')) {
        e.preventDefault()
        homePanel.setHomePanelVisibility(prev => ({ ...prev, editor: !prev.editor }))
      } else if (matchesShortcut(e, getKeys('panel-processes')) && isHomePanelEnabled('processes', 'home')) {
        e.preventDefault()
        homePanel.setHomePanelVisibility(prev => ({ ...prev, processes: !prev.processes }))
      } else if (matchesShortcut(e, getKeys('panel-tests')) && testsPanelEnabled && isHomePanelEnabled('tests', 'home')) {
        e.preventDefault()
        homePanel.setHomePanelVisibility(prev => ({ ...prev, tests: !prev.tests }))
      } else if (matchesShortcut(e, getKeys('panel-automations')) && automationsPanelEnabled && isHomePanelEnabled('automations', 'home')) {
        e.preventDefault()
        homePanel.setHomePanelVisibility(prev => ({ ...prev, automations: !prev.automations }))
      }
    })
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [tabs, activeTabIndex, selectedProjectId, homePanel.homePanelVisibility, getKeys, isRecording, buildHomeFileContext])

  // Cmd+R: reload the active browser view (WebContentsView or webview fallback)
  useEffect(() => {
    return window.api.app.onReloadBrowser(() => {
      // Find visible WebContentsView placeholder and reload via IPC
      const placeholder = document.querySelector('[data-browser-panel][data-view-id]') as HTMLElement | null
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
      if ((!(e.metaKey || e.ctrlKey)) || e.altKey) return

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
      scopeTracker.setComponentScope('browser', payload.viewId)
      // Dispatch on document (not window) so react-hotkeys-hook sees it —
      // it listens on document. Events on document also bubble to window,
      // so raw window.addEventListener handlers still work.
      // react-hotkeys-hook tracks pressed keys by e.code via keydown events.
      // Emit modifier keydowns first so the pressed-key set is correct, then
      // emit the actual key. Include code on all events.
      const key = payload.key
      const code = key.length === 1 ? `Key${key.toUpperCase()}` : key
      const mods = { shiftKey: payload.shift, metaKey: payload.meta, ctrlKey: payload.control, altKey: payload.alt }
      if (payload.control) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ...mods, bubbles: true }))
      if (payload.meta) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', code: 'MetaLeft', ...mods, bubbles: true }))
      if (payload.shift) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', ...mods, bubbles: true }))
      if (payload.alt) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', code: 'AltLeft', ...mods, bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key, code, ...mods, bubbles: true }))
    })
  }, [])

  // When a WebContentsView gains focus, dispatch a synthetic focusin on the
  // browser panel element so TaskDetailPage's glow tracking picks it up.
  useEffect(() => {
    return window.api.browser.onBrowserViewFocused(() => {
      const browserPanel = document.querySelector('[data-panel-id="browser"]')
      if (browserPanel) {
        browserPanel.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      }
    })
  }, [])

  useEffect(() => {
    return window.api.browser.onCreateTaskFromLink((intent) => {
      const sourceTask = tasksMap.get(intent.taskId)
      const fallbackProjectId = sourceTask?.project_id ?? selectedProjectId ?? projects[0]?.id
      useDialogStore.getState().openCreateTask({
        ...buildCreateTaskDraftFromBrowserLink(intent.url, intent.linkText),
        projectId: fallbackProjectId,
      })
    })
  }, [tasksMap, selectedProjectId, projects])

  // Tab management
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
        undo: async () => { await window.api.db.updateTask({ id: task.id, status: prevStatus }); setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: prevStatus } : t))) },
        redo: async () => { await window.api.db.updateTask({ id: task.id, status: doneStatus }); setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: doneStatus } : t))) }
      })
      toast(`Completed "${task.title}"`, { action: { label: 'Undo', onClick: () => void undo() } })
    }
  }

  // Scratch terminal
  const handleCreateScratchTerminal = useCallback(async (): Promise<void> => {
    if (!selectedProjectId) return
    const existing = tasks.filter((t) => t.project_id === selectedProjectId).map((t) => t.title.match(/^Terminal (\d+)$/)).filter(Boolean).map((m) => parseInt(m![1], 10))
    const next = existing.length > 0 ? Math.max(...existing) + 1 : 1
    const status = getDefaultStatus(selectedProject?.columns_config)
    const task = await window.api.db.createTask({ projectId: selectedProjectId, title: `Terminal ${next}`, status, isTemporary: true })
    track('temporary_task_created')
    setTasks((prev) => [task, ...prev])
    setTerminalFocusRequests((prev) => ({ ...prev, [task.id]: (prev[task.id] ?? 0) + 1 }))
    const lookup = useTabStore.getState()._taskLookup
    useTabStore.setState({ _taskLookup: { ...lookup, tasks: [task, ...lookup.tasks] } })
    openTask(task.id)
  }, [selectedProjectId, selectedProject, tasks, setTasks, openTask])

  useEffect(() => {
    ;(window as { __slayzone_createScratchTerminal?: () => Promise<void> }).__slayzone_createScratchTerminal = handleCreateScratchTerminal
    return () => {
      delete (window as { __slayzone_createScratchTerminal?: () => Promise<void> }).__slayzone_createScratchTerminal
    }
  }, [handleCreateScratchTerminal])

  useEffect(() => { return window.api.app.onNewTemporaryTask(() => { handleCreateScratchTerminal() }) }, [handleCreateScratchTerminal])

  // Task handlers
  const handleTaskCreated = (task: Task): void => { setTasks((prev) => [task, ...prev]); useDialogStore.getState().closeCreateTask() }

  const handleTaskCreatedAndOpen = (task: Task): void => {
    setTasks((prev) => [task, ...prev]); useDialogStore.getState().closeCreateTask()
    setTerminalFocusRequests((prev) => ({ ...prev, [task.id]: (prev[task.id] ?? 0) + 1 }))
    const lookup = useTabStore.getState()._taskLookup
    useTabStore.setState({ _taskLookup: { ...lookup, tasks: [task, ...lookup.tasks] } })
    openTask(task.id)
  }

  const handleTerminalFocusRequestHandled = useCallback((taskId: string, requestId: number): void => {
    setTerminalFocusRequests((prev) => {
      if ((prev[taskId] ?? 0) !== requestId) return prev
      const next = { ...prev }; delete next[taskId]; return next
    })
  }, [])

  const handleTaskUpdated = (task: Task): void => { updateTask(task); useDialogStore.getState().closeEditTask() }

  const handleConvertTask = useCallback(async (task: Task): Promise<Task> => {
    const project = useTabStore.getState()._taskLookup.projects.find((item) => item.id === task.project_id)
    const converted = await window.api.db.updateTask({ id: task.id, title: 'Untitled task', status: getStatusByCategory('started', project?.columns_config) ?? getDefaultStatus(project?.columns_config), isTemporary: false })
    updateTask(converted); return converted
  }, [updateTask])

  const handleTaskDeleted = (): void => { if (deletingTask) { deleteTask(deletingTask.id); useDialogStore.getState().closeDeleteTask() } }
  const handleTaskClick = (task: Task, e: { metaKey: boolean }): void => { if (e.metaKey) guardedOpenTaskInBackground(task.id); else openTask(task.id) }
  const handleTaskMove = (taskId: string, newColumnId: string, targetIndex: number): void => { moveTask(taskId, newColumnId, targetIndex, getViewConfig(filter).groupBy) }

  useEffect(() => {
    ;(window as { __slayzone_moveTaskForTest?: (taskId: string, newColumnId: string, targetIndex: number) => void }).__slayzone_moveTaskForTest = handleTaskMove
    return () => {
      delete (window as { __slayzone_moveTaskForTest?: (taskId: string, newColumnId: string, targetIndex: number) => void }).__slayzone_moveTaskForTest
    }
  }, [handleTaskMove])

  // Project handlers
  const openProjectSettings = useCallback((project: Project, options?: { initialTab?: ProjectSettingsTab; integrationOnboardingProvider?: ProjectIntegrationOnboardingProvider | null }): void => {
    setProjectSettingsInitialTab(options?.initialTab ?? 'general')
    setProjectSettingsOnboardingProvider(options?.integrationOnboardingProvider ?? null)
    setEditingProject(project)
  }, [])

  const closeProjectSettings = useCallback((): void => { setEditingProject(null); setProjectSettingsInitialTab('general'); setProjectSettingsOnboardingProvider(null) }, [])


  const handleProjectCreated = (project: Project, context: ProjectCreationContext): void => {
    setProjects((prev) => [...prev, project]); setSelectedProjectId(project.id); useDialogStore.getState().closeCreateProject()
    if (context.startMode === 'github' || context.startMode === 'linear') openProjectSettings(project, { initialTab: 'integrations', integrationOnboardingProvider: context.startMode })
  }

  const handleProjectUpdated = (project: Project): void => { updateProject(project); closeProjectSettings(); validateProjectPath(project) }
  const handleProjectChanged = (project: Project): void => { updateProject(project); setEditingProject(project); validateProjectPath(project) }

  const handleProjectNameSave = async (): Promise<void> => {
    if (!selectedProjectId) return
    const trimmed = projectNameValue.trim()
    if (!trimmed) { const p = projects.find((p) => p.id === selectedProjectId); if (p) setProjectNameValue(p.name); return }
    const project = projects.find((p) => p.id === selectedProjectId)
    if (project && trimmed !== project.name) {
      try { const updated = await window.api.db.updateProject({ id: selectedProjectId, name: trimmed, color: project.color }); updateProject(updated) }
      catch { if (project) setProjectNameValue(project.name) }
    }
  }

  const handleProjectNameKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleProjectNameSave(); projectNameInputRef.current?.blur() }
    else if (e.key === 'Escape') { const p = projects.find((p) => p.id === selectedProjectId); if (p) setProjectNameValue(p.name); projectNameInputRef.current?.blur() }
  }

  const handleFixProjectPath = useCallback(async (): Promise<void> => {
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project) return
    const result = await window.api.dialog.showOpenDialog({ title: 'Select Project Directory', defaultPath: project.path || undefined, properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return
    const updated = await window.api.db.updateProject({ id: project.id, path: result.filePaths[0] })
    updateProject(updated); validateProjectPath(updated)
  }, [selectedProjectId, projects, updateProject, validateProjectPath])

  const handleProjectDeleted = (): void => { if (deletingProject) { deleteProject(deletingProject.id, selectedProjectId, setSelectedProjectId); useDialogStore.getState().closeDeleteProject() } }
  const handleSidebarSelectProject = (projectId: string): void => { track('project_switched'); setSelectedProjectId(projectId); setActiveTabIndex(0) }
  const handleOpenSettings = (): void => { setSettingsInitialTab('appearance'); setSettingsInitialAiConfigSection(null); setSettingsOpen(true) }

  // Custom event listeners for settings
  useEffect(() => {
    const handleGlobal = (e: Event) => { const tab = (e as CustomEvent<string>).detail || 'appearance'; setSettingsInitialTab(tab); setSettingsInitialAiConfigSection(null); setSettingsOpen(true) }
    const handleProject = (e: Event) => {
      const { projectId, tab } = (e as CustomEvent<{ projectId: string; tab?: string }>).detail
      const project = projects.find(p => p.id === projectId)
      if (project) openProjectSettings(project, { initialTab: (tab ?? 'general') as ProjectSettingsTab })
    }
    window.addEventListener('open-settings', handleGlobal); window.addEventListener('open-project-settings', handleProject)
    return () => { window.removeEventListener('open-settings', handleGlobal); window.removeEventListener('open-project-settings', handleProject) }
  }, [projects, openProjectSettings])

  return (
    <AppearanceProvider settingsRevision={settingsRevision}>
    <SidebarProvider defaultOpen={true}>
      <div id="app-shell" className="h-full w-full flex">
        <AppSidebar
          projects={projects} tasks={tasks} selectedProjectId={selectedProjectId}
          onSelectProject={handleSidebarSelectProject}
          onProjectSettings={(project) => openProjectSettings(project)}
          onSettings={handleOpenSettings}
          onLeaderboard={() => { useTabStore.getState().setActiveView('leaderboard') }}
          onUsageAnalytics={() => { useTabStore.getState().setActiveView('usage-analytics') }}
          onTaskClick={openTask} zenMode={zenMode} onboardingChecklist={onboardingChecklist} attentionByProject={attentionByProject} onReorderProjects={reorderProjects}
        />

        <div id="right-column" className={`flex-1 flex min-w-0 bg-sidebar pb-2 pr-2 ${zenMode ? 'pl-2' : ''}`}>
          <div id="right-main" className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className={zenMode ? "pl-16" : ""}>
            <TabBar
              tabs={visibleTabs} activeIndex={visibleActiveIndex} activeView={activeView} terminalStates={terminalStates}
              projectColors={taskProjectColors} worktreeColors={taskWorktreeColors}
              onTabClick={(i) => setActiveTabIndex(toFullIndex(i))} onTabClose={(i) => closeTab(toFullIndex(i))} onTabReorder={(from, to) => reorderTabs(toFullIndex(from), toFullIndex(to))}
              onTabRename={async (taskId, title) => { const t = await window.api.db.updateTask({ id: taskId, title }); updateTask(t) }}
              leftContent={contextManagerEnabled ? (
                <Tooltip><TooltipTrigger asChild>
                  <div className={cn(
                    "relative ml-1 flex items-center gap-1.5 h-7 px-3 rounded-md cursor-pointer transition-colors select-none flex-shrink-0",
                    "hover:bg-neutral-200/80 dark:hover:bg-neutral-700/50",
                    "border",
                    activeView === 'context'
                      ? "bg-neutral-200 dark:bg-neutral-700 border-neutral-300 dark:border-neutral-600"
                      : "border-transparent text-neutral-500 dark:text-neutral-400"
                  )} onClick={() => useTabStore.getState().setActiveView(activeView === 'context' ? 'tabs' : 'context')}>
                    <BookOpen className="h-4 w-4" />
                    {staleSkillCount > 0 && (
                      <span
                        aria-label={`${staleSkillCount} stale skill${staleSkillCount === 1 ? '' : 's'}`}
                        data-testid="context-manager-stale-dot"
                        className="absolute top-1 right-1 w-2 h-2 rounded-full bg-amber-500"
                      />
                    )}
                  </div>
                </TooltipTrigger><TooltipContent side="bottom" className="text-xs">
                  {staleSkillCount > 0 ? `Context Manager (${staleSkillCount} stale)` : 'Context Manager'}
                </TooltipContent></Tooltip>
              ) : undefined}
              rightContent={
                <div className="flex items-center gap-1">
                  <BoostPill />
                  <div className="w-4" />
                  <UsagePopover data={usageData} onRefresh={refreshUsage} />
                  <div className="w-4" />
                  <Tooltip><TooltipTrigger asChild>
                    <button onClick={() => useTabStore.getState().toggleProjectScopedTabs()}
                      className={cn("h-7 w-7 flex items-center justify-center transition-colors border-b-2", projectScopedTabs ? "text-foreground border-foreground" : "text-muted-foreground border-transparent hover:text-foreground")}>
                      <FolderClosed className="size-4" />
                    </button>
                  </TooltipTrigger><TooltipContent side="bottom" className="text-xs">{projectScopedTabs ? 'Show all tabs' : 'Show project tabs only'} ({projectTabsShortcut})</TooltipContent></Tooltip>
                  <Tooltip><TooltipTrigger asChild>
                    <button disabled={openTaskIds.length < 2} onClick={() => setExplodeMode((prev) => !prev)}
                      className={cn("h-7 w-7 flex items-center justify-center transition-colors border-b-2", explodeMode ? "text-foreground border-foreground" : "text-muted-foreground border-transparent hover:text-foreground", openTaskIds.length < 2 && "opacity-30 pointer-events-none")}>
                      <LayoutGrid className="size-4" />
                    </button>
                  </TooltipTrigger><TooltipContent side="bottom" className="text-xs">{explodeMode ? 'Exit explode mode' : 'Explode mode'} ({explodeModeShortcut})</TooltipContent></Tooltip>
                  <Tooltip><TooltipTrigger asChild>
                    <button onClick={selectedProjectId ? handleCreateScratchTerminal : undefined} disabled={!selectedProjectId}
                      className={cn("h-7 w-7 flex items-center justify-center transition-colors", selectedProjectId ? "text-muted-foreground hover:text-foreground" : "text-muted-foreground/40 cursor-not-allowed")}>
                      <TerminalSquare className="size-4" />
                    </button>
                  </TooltipTrigger><TooltipContent side="bottom" className="text-xs max-w-64">
                    {selectedProjectId ? <div className="space-y-1"><p>{withShortcut('New temporary task', newTempTaskShortcut)}</p><p className="text-muted-foreground">Temporary tasks auto-delete on close.</p></div> : <p>Select a project first</p>}
                  </TooltipContent></Tooltip>
                  <DesktopNotificationToggle enabled={notificationState.desktopEnabled} onToggle={() => {
                    if (notificationState.desktopEnabled) window.api.pty.dismissAllNotifications()
                    setNotificationState({ desktopEnabled: !notificationState.desktopEnabled })
                  }} />
                  <AgentPanelButton active={agentPanelState.isOpen} disabled={!selectedProjectId} onClick={() => setAgentPanelState({ isOpen: !agentPanelState.isOpen })} shortcutHint={agentPanelShortcut} />
                  <NotificationButton active={notificationState.isLocked} count={attentionTasks.length} onClick={() => setNotificationState({ isLocked: !notificationState.isLocked })} shortcutHint={attentionPanelShortcut} />
                </div>
              }
            />
          </div>

          <div id="content-wrapper" className="flex-1 min-h-0 flex">
            <div id="main-area" className="flex-1 min-w-0 min-h-0 rounded-lg bg-surface-0 flex overflow-hidden p-4">
            <div
              className={cn("flex-1 min-w-0 min-h-0 rounded-lg overflow-hidden", explodeMode ? "grid gap-1 p-1" : "relative")}
              style={{
                ...(explodeMode ? (() => { const visibleTaskCount = visibleTabs.filter(t => t.type === 'task').length; const cols = Math.ceil(Math.sqrt(visibleTaskCount)); const rows = Math.ceil(visibleTaskCount / cols); return { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` } })() : undefined),
              }}
            >
              {tabs.map((tab, i) => {
                const isVisible = toVisibleIndex(i) >= 0
                if (explodeMode && (tab.type !== 'task' || !isVisible)) return null
                const isViewActive = activeView === 'tabs' && i === activeTabIndex
                return (
                <div
                  key={tab.type === 'home' ? 'home' : tab.taskId}
                  className={explodeMode ? "rounded overflow-hidden border border-border min-h-0 relative" : `absolute inset-0 ${!isViewActive ? 'invisible' : 'z-10'}`}
                  inert={!explodeMode && !isViewActive ? true : undefined}
                >
                    {tab.type === 'home' ? (
                    <div id="home-detail" className="flex flex-col flex-1 h-full">
                      <header className="mb-4 window-no-drag space-y-2">
                        <div className="flex items-center gap-4">
                          <div className="flex-shrink-0">
                            <textarea ref={selectedProject ? projectNameInputRef : undefined} value={selectedProject ? projectNameValue : 'No project selected'}
                              readOnly={!selectedProject} tabIndex={selectedProject ? undefined : -1}
                              onChange={selectedProject ? (e) => setProjectNameValue(e.target.value) : undefined}
                              onBlur={selectedProject ? handleProjectNameSave : undefined} onKeyDown={selectedProject ? handleProjectNameKeyDown : undefined}
                              className={cn('text-2xl font-bold bg-transparent border-none outline-none resize-none p-0', selectedProject ? 'cursor-text' : 'cursor-default select-none')}
                              style={{ caretColor: 'currentColor', fieldSizing: 'content' } as React.CSSProperties} rows={1} />
                          </div>
                          {projects.length > 0 && !(projectPathMissing && selectedProjectId) && (
                            <div className="ml-auto flex items-center gap-1">
                              {selectedProject && <ProjectLockPopover project={selectedProject} onUpdated={updateProject} onCloseProjectTabs={(pid) => {
                                const { tabs } = useTabStore.getState()
                                for (let i = tabs.length - 1; i >= 0; i--) {
                                  const t = tabs[i]
                                  if (t.type === 'task') {
                                    const task = tasks.find(tk => tk.id === t.taskId)
                                    if (task?.project_id === pid) useTabStore.getState().closeTabByTaskId(t.taskId)
                                  }
                                }
                              }} />}
                              <div className="h-4 w-px bg-border" />
                              <FilterBar filter={filter} onChange={setFilter} tags={projectTags} columns={selectedProject?.columns_config} />
                            </div>
                          )}
                          {projects.length > 0 && (
                            <div className="min-w-0">
                            <PanelToggle
                              panels={[
                                { id: 'kanban', icon: Kanban, label: 'Kanban', active: homePanel.homePanelVisibility.kanban, disabled: !selectedProjectId },
                                { id: 'git', icon: GitBranch, label: 'Git', shortcut: panelGitShortcut, active: homePanel.homePanelVisibility.git, disabled: !selectedProjectId },
                                { id: 'editor', icon: FileCode, label: 'Editor', shortcut: panelEditorShortcut, active: homePanel.homePanelVisibility.editor, disabled: !selectedProjectId },
                                { id: 'processes', icon: Cpu, label: 'Processes', shortcut: panelProcessesShortcut, active: homePanel.homePanelVisibility.processes, disabled: !selectedProjectId },
                                ...(testsPanelEnabled ? [{ id: 'tests', icon: FlaskConical, label: 'Tests', shortcut: panelTestsShortcut, active: homePanel.homePanelVisibility.tests, disabled: !selectedProjectId }] : []),
                                ...(automationsPanelEnabled ? [{ id: 'automations', icon: Zap, label: 'Automations', shortcut: panelAutomationsShortcut, active: homePanel.homePanelVisibility.automations, disabled: !selectedProjectId }] : []),
                              ].filter(p => p.id === 'kanban' || isHomePanelEnabled(p.id, 'home'))}
                              onChange={(id, active) => homePanel.setHomePanelVisibility(prev => ({ ...prev, [id]: active }))}
                            />
                            </div>
                          )}
                        </div>
                      </header>

                      {projects.length === 0 ? (
                        <div className="text-center text-muted-foreground">Click + in sidebar to create a project</div>
                      ) : projectPathMissing && selectedProjectId ? (
                        <div className="flex-1 flex items-center justify-center">
                          <div className="text-center space-y-4">
                            <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto" />
                            <p className="text-lg font-medium">Project path not found</p>
                            <p className="text-sm text-muted-foreground"><code className="bg-muted px-2 py-1 rounded">{projects.find((p) => p.id === selectedProjectId)?.path}</code></p>
                            <Button onClick={handleFixProjectPath}>Update path</Button>
                          </div>
                        </div>
                      ) : durationLocked && selectedProject?.lock_config?.locked_until ? (
                        <ProjectLockScreen project={selectedProject} lockedUntil={selectedProject.lock_config.locked_until} onUnlocked={updateProject} />
                      ) : (
                        <div ref={homePanel.homeContainerRef} className="flex-1 min-h-0 flex">
                          {HOME_PANEL_ORDER.filter(id => homePanel.homePanelVisibility[id]).map((id, i) => {
                            const projectPath = homeResolvedRepo.path ?? (projects.find(p => p.id === selectedProjectId)?.path ?? null)
                            const w = homePanel.homeResolvedWidths[id] ?? 400
                            return (
                              <React.Fragment key={id}>
                                {i > 0 && <ResizeHandle width={w} minWidth={id === 'kanban' ? 400 : 200} onWidthChange={w => updatePanelSizes({ [HOME_PANEL_SIZE_KEY[id]]: w })} onReset={() => resetPanelSize(HOME_PANEL_SIZE_KEY[id])} />}
                                <div className={cn('shrink-0 min-h-0 overflow-hidden', cn('rounded-lg border border-border', id === 'kanban' && Object.values(homePanel.homePanelVisibility).filter(Boolean).length <= 1 && !agentPanelState.isOpen && !notificationState.isLocked ? 'border-transparent' : id === 'kanban' ? 'bg-surface-1 p-3' : 'bg-surface-1'))} style={{ width: w }}>
                                  {id === 'kanban' && filter.viewMode !== 'list' && (
                                    <KanbanBoard tasks={displayTasks} columns={selectedProject?.columns_config} viewConfig={getViewConfig(filter)} isActive={tabs[activeTabIndex]?.type === 'home'}
                                      onTaskMove={handleTaskMove} onTaskReorder={reorderTasks} onTaskClick={handleTaskClick}
                                      projectsMap={projectsMap} showProjectDot={false} cardProperties={filter.cardProperties} taskTags={taskTags} tags={projectTags} onTaskTagsChange={handleTaskTagsChange} blockedTaskIds={blockedTaskIds}
                                      allProjects={projects} onUpdateTask={contextMenuUpdate} onArchiveTask={archiveTask} onDeleteTask={deleteTask} onArchiveAllTasks={archiveTasks} />
                                  )}
                                  {id === 'kanban' && filter.viewMode === 'list' && (
                                    <KanbanListView tasks={displayTasks} columns={selectedProject?.columns_config} viewConfig={getViewConfig(filter)}
                                      onTaskMove={handleTaskMove} onTaskReorder={reorderTasks} onTaskClick={handleTaskClick}
                                      projectsMap={projectsMap} showProjectDot={false} cardProperties={filter.cardProperties} blockedTaskIds={blockedTaskIds}
                                      allProjects={projects} onUpdateTask={contextMenuUpdate} onArchiveTask={archiveTask} onDeleteTask={deleteTask}
                                      tags={projectTags} taskTags={taskTags} onTaskTagsChange={handleTaskTagsChange} />
                                  )}
                                  {id === 'git' && (
                                    <Suspense fallback={<div className="h-full animate-pulse bg-muted/30 rounded" />}>
                                    <UnifiedGitPanel ref={homePanel.homeGitPanelRef} projectId={selectedProjectId} projectPath={projectPath} visible={true}
                                      defaultTab={homePanel.homeGitDefaultTab} onTabChange={homePanel.setHomeGitDefaultTab} tasks={tasks} filter={filter} projects={projects}
                                      onTaskClick={(t) => handleTaskClick(t, { metaKey: false })}
                                      onUpdateTask={(data) => window.api.db.updateTask(data).then(t => { updateTask(t); return t })}
                                      detectedRepos={homeDetectedRepos}
                                      selectedRepoName={homeSelectedProject?.selected_repo}
                                      isRepoStale={homeResolvedRepo.stale}
                                      onRepoChange={handleHomeRepoChange} />
                                    </Suspense>
                                  )}
                                  {id === 'editor' && <Suspense><FileEditorView ref={homePanel.homeEditorRefCallback} projectPath={projectPath ?? ''} /></Suspense>}
                                  {id === 'processes' && <Suspense fallback={<div className="h-full animate-pulse bg-muted/30 rounded" />}><ProcessesPanel taskId={null} projectId={selectedProjectId} cwd={projectPath} /></Suspense>}
                                  {id === 'tests' && <Suspense fallback={<div className="h-full animate-pulse bg-muted/30 rounded" />}><TestPanel projectId={selectedProjectId} projectPath={projectPath} groupBy={testGroupBy} onOpenSettings={() => { if (selectedProject) openProjectSettings(selectedProject, { initialTab: 'tests' }) }} /></Suspense>}
                                  {id === 'automations' && <Suspense fallback={<div className="h-full animate-pulse bg-muted/30 rounded" />}><AutomationsPanel projectId={selectedProjectId} /></Suspense>}
                                </div>
                              </React.Fragment>
                            )
                          })}
                        </div>
                      )}
                    </div>
                    ) : (
                    <Suspense fallback={<TaskShell />}>
                    <div className={explodeMode ? "absolute inset-0" : "h-full"}>
                      <TaskDetailDataLoader taskId={tab.taskId}
                        task={tasksMap.get(tab.taskId) ?? null} project={projectsMap.get(tasksMap.get(tab.taskId)?.project_id ?? '') ?? null}
                        isActive={explodeMode || isViewActive} compact={explodeMode}
                        onBack={goBack} onTaskUpdated={updateTask} onArchiveTask={archiveTask} onDeleteTask={deleteTask}
                        onNavigateToTask={openTask} onConvertTask={handleConvertTask} onCloseTab={closeTabByTaskId}
                        settingsRevision={settingsRevision} terminalFocusRequestId={terminalFocusRequests[tab.taskId] ?? 0}
                        onTerminalFocusRequestHandled={handleTerminalFocusRequestHandled} isSidePanelResizing={isSidePanelResizing} />
                    </div></Suspense>
                    )}
                </div>
                )
              })}
              {activeView === 'leaderboard' && (
                <div className="absolute inset-0 z-20">
                  <Suspense fallback={null}><LeaderboardPage /></Suspense>
                </div>
              )}
              {activeView === 'usage-analytics' && (
                <div className="absolute inset-0 z-20">
                  <Suspense fallback={null}><UsageAnalyticsPage onTaskClick={openTask} /></Suspense>
                </div>
              )}
              {activeView === 'context' && (
                <div className="absolute inset-0 z-20">
                  <Suspense fallback={null}>
                    <ContextManagerPage
                      selectedProjectId={selectedProjectId}
                      projectPath={projects.find(p => p.id === selectedProjectId)?.path}
                      projectName={projects.find(p => p.id === selectedProjectId)?.name}
                      onBack={() => useTabStore.getState().setActiveView('tabs')}
                    />
                  </Suspense>
                </div>
              )}
            </div>

            {agentSessionId && agentPanelMountedRef.current && agentPanelState.isOpen && !hideSidebarPanel && (
              <ResizeHandle width={agentPanelState.panelWidth} minWidth={AGENT_PANEL_MIN_WIDTH} maxWidth={AGENT_PANEL_MAX_WIDTH}
                onWidthChange={(w) => setAgentPanelState({ panelWidth: w })}
                onDragStart={() => setIsSidePanelResizing(true)} onDragEnd={() => setIsSidePanelResizing(false)}
                onReset={() => setAgentPanelState({ panelWidth: DEFAULT_AGENT_PANEL_WIDTH })} />
            )}
            {agentSessionId && agentPanelMountedRef.current && !hideSidebarPanel && (
              <div className={agentPanelState.isOpen ? 'min-h-0' : 'w-0 overflow-hidden invisible'} style={agentPanelState.isOpen ? undefined : { position: 'absolute' as const }}>
                <AgentSidePanel width={agentPanelState.panelWidth}
                  sessionId={agentSessionId} cwd={projects.find(p => p.id === selectedProjectId)?.path ?? ''} mode={agentMode as import('@slayzone/terminal/shared').TerminalMode} isActive={agentPanelState.isOpen} isResizing={isSidePanelResizing}
                  onNewSession={handleAgentNewSession} onModeChange={handleAgentModeChange}
                  floatingEnabled={agentPanelState.floatingEnabled}
                  onToggleFloating={() => setAgentPanelState({ floatingEnabled: !agentPanelState.floatingEnabled })}
                  floatingState={floatingAgentState.kind}
                  onDetach={() => window.api.floatingAgent.detach()}
                  onReattach={() => window.api.floatingAgent.reattach()} />
              </div>
            )}
            {notificationState.isLocked && (
              <ResizeHandle width={notificationState.panelWidth} minWidth={NOTIFICATION_PANEL_MIN_WIDTH} maxWidth={NOTIFICATION_PANEL_MAX_WIDTH}
                onWidthChange={(w) => setNotificationState({ panelWidth: w })}
                onDragStart={() => setIsSidePanelResizing(true)} onDragEnd={() => setIsSidePanelResizing(false)}
                onReset={() => setNotificationState({ panelWidth: DEFAULT_NOTIFICATION_PANEL_WIDTH })} />
            )}
            {notificationState.isLocked && (
              <NotificationSidePanel width={notificationState.panelWidth}
                attentionTasks={attentionTasks} projects={projects} filterCurrentProject={notificationState.filterCurrentProject}
                onFilterToggle={() => setNotificationState({ filterCurrentProject: !notificationState.filterCurrentProject })}
                onNavigate={openTask} onCloseTerminal={async (sessionId) => { await window.api.pty.kill(sessionId); refreshAttentionTasks() }}
                selectedProjectId={selectedProjectId} currentProjectName={projects.find((p) => p.id === selectedProjectId)?.name} />
            )}
            </div>
          </div>
          </div>
        </div>

        {/* Dialogs — lazy-mounted on first trigger, stay mounted for close/reopen animations */}
        {shouldMount('createTask', createTaskOpen) && <Suspense fallback={null}><CreateTaskDialog open={createTaskOpen} onOpenChange={(open) => { if (!open) useDialogStore.getState().closeCreateTask() }} onCreated={handleTaskCreated} onCreatedAndOpen={handleTaskCreatedAndOpen}
          draft={createTaskDialogDraft}
          tags={projectTags} onTagCreated={(tag: Tag) => setTags((prev) => [...prev, tag])} /></Suspense>}
        {shouldMount('editTask', !!editingTask) && <Suspense fallback={null}><EditTaskDialog task={editingTask} open={!!editingTask} onOpenChange={(open) => { if (!open) useDialogStore.getState().closeEditTask() }} onUpdated={handleTaskUpdated} /></Suspense>}
        {shouldMount('deleteTask', !!deletingTask) && <Suspense fallback={null}><DeleteTaskDialog task={deletingTask} open={!!deletingTask} onOpenChange={(open) => { if (!open) useDialogStore.getState().closeDeleteTask() }} onDeleted={handleTaskDeleted} /></Suspense>}
        {shouldMount('createProject', createProjectOpen) && <Suspense fallback={null}><CreateProjectDialog open={createProjectOpen} onOpenChange={(open) => { if (!open) useDialogStore.getState().closeCreateProject() }} onCreated={handleProjectCreated} /></Suspense>}
        {shouldMount('projectSettings', !!editingProject) && <Suspense fallback={null}><ProjectSettingsDialog project={editingProject} open={!!editingProject} onOpenChange={(open) => !open && closeProjectSettings()}
          initialTab={projectSettingsInitialTab} groupBy={testGroupBy} onGroupByChange={setTestGroupBy}
          integrationOnboardingProvider={projectSettingsOnboardingProvider} onIntegrationOnboardingHandled={() => setProjectSettingsOnboardingProvider(null)}
          onUpdated={handleProjectUpdated}
          onChanged={handleProjectChanged}
          renderTemplatesTab={(projectId) => <TemplatesSettingsTab projectId={projectId} />} /></Suspense>}
        {shouldMount('deleteProject', !!deletingProject) && <Suspense fallback={null}><DeleteProjectDialog project={deletingProject} open={!!deletingProject} onOpenChange={(open) => { if (!open) useDialogStore.getState().closeDeleteProject() }} onDeleted={handleProjectDeleted} /></Suspense>}
        {shouldMount('settings', settingsOpen) && <Suspense fallback={null}><UserSettingsDialog open={settingsOpen} onOpenChange={(open) => { setSettingsOpen(open); if (!open) { setSettingsRevision((r) => r + 1); setSettingsInitialAiConfigSection(null) } }}
          initialTab={settingsInitialTab} initialAiConfigSection={settingsInitialAiConfigSection} onTabChange={setSettingsInitialTab} /></Suspense>}
        {shouldMount('search', searchOpen) && <Suspense fallback={null}><SearchDialog open={searchOpen} onOpenChange={(open) => { if (!open) useDialogStore.getState().closeSearch() }} tasks={tasks} projects={projects} onSelectTask={openTask} onSelectProject={setSelectedProjectId} /></Suspense>}
        {shouldMount('onboarding', shouldMountOnboarding) && <Suspense fallback={null}><OnboardingDialog externalOpen={onboardingOpen} onExternalClose={async () => {
          useDialogStore.getState().closeOnboarding()
          const [onboardingCompleted, prompted] = await Promise.all([window.api.settings.get('onboarding_completed'), window.api.settings.get('tutorial_prompted')])
          if (onboardingCompleted === 'true') markSetupGuideCompleted()
          if (!prompted) { void window.api.settings.set('tutorial_prompted', 'true'); toast('Want a quick tour?', { duration: 8000, action: { label: 'Take the tour', onClick: startTour } }) }
        }} /></Suspense>}
        <Suspense fallback={null}><CliInstallDialog /></Suspense>
        {shouldMount('tutorial', showAnimatedTour) && <Suspense fallback={null}><TutorialAnimationModal open={showAnimatedTour} onClose={() => useDialogStore.getState().closeAnimatedTour()} /></Suspense>}
        {shouldMount('changelog', changelogOpen || autoChangelogOpen) && <Suspense fallback={null}><ChangelogDialog open={changelogOpen || autoChangelogOpen} onOpenChange={(open) => { if (!open) { useDialogStore.getState().closeChangelog(); dismissAutoChangelog() } }} lastSeenVersion={autoChangelogOpen ? lastSeenVersion : null} /></Suspense>}
        <AlertDialog open={completeTaskDialogOpen} onOpenChange={(open) => { if (!open) useDialogStore.getState().closeCompleteTaskDialog() }}>
          <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Complete Task</AlertDialogTitle><AlertDialogDescription>Mark as complete and close tab?</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction autoFocus onClick={handleCompleteTaskConfirm}>Complete</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
        </AlertDialog>
        <UpdateToast version={updateVersion} onRestart={() => window.api.app.restartForUpdate()} onDismiss={() => setUpdateVersion(null)} />
        <Toaster position="bottom-right" theme="dark" closeButton />
      </div>
    </SidebarProvider>
    </AppearanceProvider>
  )
}

export default App
