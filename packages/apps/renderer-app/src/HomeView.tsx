// Chromium-fork Home — the real AppSidebar (left) + the shared @slayzone/home
// shell (right), both fed by ONE lifted useTasksData() instance.
//
// useTasksData() is called once here and passed to both the sidebar (projects/
// tasks + CRUD/reorder mutations) and HomeContainer (via its `data` prop), so
// the two consumers share a single board-data instance instead of each minting
// their own. Sidebar selection drives HomeContainer's selectedProjectId.
//
// Right-side agent panels: the Global Agent panel (a terminal/claude-code
// session) and the Agent Status panel (idle/stalled agent list) are mounted
// here as resizable flex siblings of the main column, with their header toggles
// in the tab bar. Both are the canonical @slayzone/agent-panels components —
// extracted from the Electron renderer, not reimplemented.
//
// PRIMARY-WINDOW ONLY (permanent product constraint): the agent-panel toggles
// MUST NEVER appear in a secondary task window. HomeView is the fork's primary
// surface — a secondary task window renders a different view entirely (mirrors
// the Electron app's SecondaryTaskWindow, which omits the header actions). So
// keeping the toggles + panels confined to HomeView IS the gate; never wire
// them into any task-detail / secondary surface.
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  SidebarProvider,
  useGuardedHotkeys,
  useShortcutStore,
  useShortcutDisplay,
  shortcutDefinitions,
  KeyRecorder,
  useUndo,
  cn
} from '@slayzone/ui'
import { useExplodeMode, AppHeaderActions } from '@slayzone/app-shell/client'
import { useTasksData, useUndoableTaskActions } from '@slayzone/tasks/client'
import {
  useDialogStore,
  useTabStore,
  loadTabStoreState,
  type SearchFileContext
} from '@slayzone/settings'
import { TabBar } from '@slayzone/tabs'
import { HomeContainer, type HomeContainerHandle } from '@slayzone/home/client'
import { taskDetailCache } from '@slayzone/task/client/taskDetailCache'
import { ResizeHandle } from '@slayzone/task/client/ResizeHandle'
import { useTRPCClient } from '@slayzone/transport/client'
import { TerminalStatusButton } from '@slayzone/terminal'
import type { TerminalMode } from '@slayzone/terminal/shared'
import { getDefaultStatus } from '@slayzone/projects/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import {
  useGlobalAgentPanelState,
  GlobalAgentSidePanel,
  GLOBAL_AGENT_PANEL_MIN_WIDTH,
  GLOBAL_AGENT_PANEL_MAX_WIDTH,
  DEFAULT_GLOBAL_AGENT_PANEL_WIDTH,
  useAgentStatusState,
  AgentStatusSidePanel,
  AGENT_STATUS_PANEL_MIN_WIDTH,
  AGENT_STATUS_PANEL_MAX_WIDTH,
  DEFAULT_AGENT_STATUS_PANEL_WIDTH,
  useIdleTasks
} from '@slayzone/agent-panels'
import { AppSidebar } from '@slayzone/sidebar'
import {
  useOnboardingChecklist,
  COMMUNITY_DISCORD_URL,
  COMMUNITY_X_URL
} from '@slayzone/onboarding'
import { TaskDetailView } from './TaskDetailView'
import { OverlayViewRouter } from './OverlayViewRouter'
import { AppDialogs } from './AppDialogs'

function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center bg-background px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

// Stable defaults for the app-chrome props the Electron app supplies but the
// fork doesn't have yet (no native window chrome / convex / feedback in the
// shell). Module-level → referentially stable.
const EMPTY_SESSION_IDS = new Set<string>()
const NOOP = (): void => {}

export function HomeView(): React.JSX.Element {
  const rawData = useTasksData()
  const trpcClient = useTRPCClient()

  // Wrap task mutations with undo (toast + undo/redo) and merge them over the
  // raw board data, so EVERY consumer — sidebar context-menu edits, the board,
  // task-detail archive/delete, the delete-task dialog — gets the same undo
  // affordance the Electron app provides (App.tsx useUndoableTaskActions). The
  // underlying useTasksData instance stays single; only the wrapped action fns
  // are swapped in. (Temp-task auto-cleanup in closeTab calls rawData.deleteTask
  // directly to avoid a spurious "undo" toast for scratch terminals.)
  const { push: pushUndo, undo } = useUndo()
  const {
    contextMenuUpdate,
    archiveTask,
    archiveTasks,
    deleteTask,
    bulkContextMenuUpdate,
    bulkDelete
  } = useUndoableTaskActions(
    {
      tasks: rawData.tasks,
      updateTask: rawData.updateTask,
      setTasks: rawData.setTasks,
      archiveTask: rawData.archiveTask,
      archiveTasks: rawData.archiveTasks,
      deleteTask: rawData.deleteTask,
      bulkDelete: rawData.bulkDelete,
      contextMenuUpdate: rawData.contextMenuUpdate,
      bulkContextMenuUpdate: rawData.bulkContextMenuUpdate
    },
    { push: pushUndo, undo }
  )
  const data = useMemo(
    () => ({
      ...rawData,
      contextMenuUpdate,
      archiveTask,
      archiveTasks,
      deleteTask,
      bulkContextMenuUpdate,
      bulkDelete
    }),
    [rawData, contextMenuUpdate, archiveTask, archiveTasks, deleteTask, bulkContextMenuUpdate, bulkDelete]
  )
  const { projects, boardStatus, boardError } = data

  // Canonical tab store (the exact store the Electron app uses). Primitive
  // selectors keep re-renders scoped; actions are read off getState() (stable
  // zustand refs). The home tab is always tabs[0]; task tabs follow.
  const tabs = useTabStore((s) => s.tabs)
  const activeTabIndex = useTabStore((s) => s.activeTabIndex)
  const deferredActiveTabIndex = useDeferredValue(activeTabIndex)
  const activeView = useTabStore((s) => s.activeView)
  const projectScopedTabs = useTabStore((s) => s.projectScopedTabs)
  const storeProjectId = useTabStore((s) => s.selectedProjectId)
  const selectedProjectId = storeProjectId || projects[0]?.id || ''

  // ── Special view modes (zen + explode) — mirrors the Electron App.tsx shell ──
  // Zen is a plain boolean that collapses the sidebar (AppSidebar `zenMode` prop)
  // and hides the header chrome. Explode tiles the open task tabs into a grid;
  // useExplodeMode (shared @slayzone/app-shell) owns the toggle, focused cell,
  // grid ref + responsive width.
  const [zenMode, setZenMode] = useState(false)
  const openTaskIds = useMemo(
    () => tabs.filter((t) => t.type === 'task').map((t) => (t as { taskId: string }).taskId),
    [tabs]
  )
  const { explodeMode, setExplodeMode, focusedExplodeTaskId, explodeGridRef, explodeGridWidth } =
    useExplodeMode(openTaskIds, tabs, activeTabIndex)
  const visibleTaskCount = openTaskIds.length

  // Expose the tab + dialog stores for e2e / CDP introspection (mirrors the
  // Electron App.tsx exposure). Idempotent guards → safe to run each render.
  if (typeof window !== 'undefined') {
    const w = window as unknown as Record<string, unknown>
    if (!w.__slayzone_tabStore) w.__slayzone_tabStore = useTabStore
    if (!w.__slayzone_dialogStore) w.__slayzone_dialogStore = useDialogStore
  }

  // Keep the store's task/project lookup fresh — openTask reads it to build a
  // tab's title and worktree-grouped insert position.
  useEffect(() => {
    useTabStore.setState({ _taskLookup: { tasks: data.tasks, projects: data.projects } })
  }, [data.tasks, data.projects])

  // Hydrate persisted tabs/view state once on boot (mirrors the Electron
  // renderer main.tsx loadTabStoreState() call). Flips the store's isLoaded gate
  // so subsequent tab changes persist back to settings.
  useEffect(() => {
    void loadTabStoreState()
  }, [])

  // Warm the Suspense cache for every open task tab so switching to / restoring a
  // tab paints without the cold use() scheduling delay (mirrors the Electron tab
  // lifecycle's prefetch of open tabs).
  useEffect(() => {
    for (const tab of tabs) {
      if (tab.type === 'task') taskDetailCache.prefetch('taskDetail', tab.taskId)
    }
  }, [tabs])

  // Open or focus a task tab (sidebar / board / sibling-link / agent-panel
  // clicks). Prefetch first so the page is warm by the time the tab activates.
  const openTask = useCallback((id: string) => {
    if (!id) return
    taskDetailCache.prefetch('taskDetail', id)
    useTabStore.getState().openTask(id)
  }, [])

  // Expose openTask for e2e / CDP + domain UI that calls it (mirrors the Electron
  // App.tsx window.__slayzone_openTask hook).
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__slayzone_openTask = openTask
  }, [openTask])

  // Close a tab by index. Temporary tasks have no persistent home, so closing
  // one kills its PTY + deletes the task (mirrors the Electron App.tsx wrapper);
  // the live board subscription + optimistic deleteTask drop it from the board.
  const closeTab = useCallback(
    async (index: number): Promise<void> => {
      const store = useTabStore.getState()
      const tab = store.tabs[index]
      if (tab?.type === 'task') {
        const task = store._taskLookup.tasks.find((t) => t.id === tab.taskId)
        if (task?.is_temporary) {
          void trpcClient.pty.kill.mutate({ sessionId: `${tab.taskId}:${tab.taskId}` })
          // Raw delete (not the undoable wrapper) — a scratch terminal closing
          // shouldn't surface an "undo delete" toast.
          void rawData.deleteTask(tab.taskId)
        }
      }
      store.closeTab(index)
    },
    [rawData, trpcClient]
  )

  const closeTabByTaskId = useCallback(
    (taskId: string): void => {
      const index = useTabStore
        .getState()
        .tabs.findIndex((t) => t.type === 'task' && t.taskId === taskId)
      if (index >= 0) void closeTab(index)
    },
    [closeTab]
  )

  // Scratch terminal — create a temporary `Terminal N` task and open it (mirrors
  // the Electron App.tsx handleCreateScratchTerminal). Temp tasks auto-delete on
  // close via closeTab above. No project-duration lock in the fork.
  const handleCreateScratchTerminal = useCallback(async (): Promise<void> => {
    if (!selectedProjectId) return
    const project = projects.find((p) => p.id === selectedProjectId)
    const existing = data.tasks
      .filter((t) => t.project_id === selectedProjectId)
      .map((t) => t.title.match(/^Terminal (\d+)$/))
      .filter(Boolean)
      .map((m) => parseInt(m![1], 10))
    const next = existing.length > 0 ? Math.max(...existing) + 1 : 1
    const task = await trpcClient.task.create.mutate({
      projectId: selectedProjectId,
      title: `Terminal ${next}`,
      status: getDefaultStatus(project?.columns_config),
      isTemporary: true
    })
    data.setTasks((prev) => [task, ...prev])
    const lookup = useTabStore.getState()._taskLookup
    useTabStore.setState({ _taskLookup: { ...lookup, tasks: [task, ...lookup.tasks] } })
    openTask(task.id)
  }, [selectedProjectId, projects, data, trpcClient, openTask])

  // ── Command palette (Cmd+K) ───────────────────────────────────────────────
  // Imperative handle into the Home file-editor panel so palette file results
  // open in the Home editor (mirrors the canonical buildHomeFileContext path).
  const homeEditorHandle = useRef<HomeContainerHandle>(null)

  // Resolve the search hotkey from user overrides (defaults to mod+k). load()
  // hydrates overrides from settings; useGuardedHotkeys auto-skips when a modal
  // is already open and maps `mod` → meta/ctrl per platform.
  const shortcutOverrides = useShortcutStore((s) => s.overrides)
  useEffect(() => {
    void useShortcutStore.getState().load()
  }, [])
  const searchKeys =
    shortcutOverrides['search'] ||
    shortcutDefinitions.find((d) => d.id === 'search')?.defaultKeys ||
    'mod+k'

  // The palette's file results open in the Home editor: switch to the Home tab so
  // the file is visible, then drive the editor through HomeContainer's handle.
  const buildHomeFileContext = useCallback((): SearchFileContext | undefined => {
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project?.path) return undefined
    return {
      projectPath: project.path,
      openFile: (filePath) => {
        const hi = useTabStore.getState().tabs.findIndex((t) => t.type === 'home')
        if (hi >= 0) useTabStore.getState().setActiveTabIndex(hi)
        homeEditorHandle.current?.openFile(filePath)
      }
    }
  }, [projects, selectedProjectId])

  useGuardedHotkeys(
    searchKeys,
    (e) => {
      e.preventDefault()
      useDialogStore.getState().openSearch({ fileContext: buildHomeFileContext() })
    },
    { enableOnFormTags: true }
  )

  // Resolve a shortcut id → key string (user override else default). Used for the
  // zen / explode / exit bindings below (mirrors the Electron useAppShortcuts getKeys).
  const getKeys = useCallback(
    (id: string): string =>
      shortcutOverrides[id] || shortcutDefinitions.find((d) => d.id === id)?.defaultKeys || '',
    [shortcutOverrides]
  )

  // Zen / explode / exit — mirrors useAppShortcuts. Explode gated on ≥2 task tabs.
  useGuardedHotkeys(
    getKeys('zen-mode'),
    (e) => {
      e.preventDefault()
      setZenMode((prev) => !prev)
    },
    { enableOnFormTags: true }
  )
  useGuardedHotkeys(
    getKeys('explode-mode'),
    (e) => {
      e.preventDefault()
      if (openTaskIds.length >= 2) setExplodeMode((prev) => !prev)
    },
    { enableOnFormTags: true }
  )
  useGuardedHotkeys(
    getKeys('exit-zen-explode'),
    () => {
      if (explodeMode) setExplodeMode(false)
      else if (zenMode) setZenMode(false)
    },
    { enableOnFormTags: true }
  )

  // Shortcut display strings for the header action tooltips.
  const projectTabsShortcut = useShortcutDisplay('toggle-project-tabs')
  const zenModeShortcut = useShortcutDisplay('zen-mode')
  const explodeModeShortcut = useShortcutDisplay('explode-mode')
  const newTempTaskShortcut = useShortcutDisplay('new-temp-task')
  const agentStatusPanelShortcut = useShortcutDisplay('agent-status-panel')
  const globalAgentPanelShortcut = useShortcutDisplay('global-agent-panel')

  // ── Onboarding checklist (sidebar footer popover) ─────────────────────────
  // Real checklist hook, extracted to @slayzone/onboarding and shared with the
  // Electron renderer (no reimplementation). Setup-guide / take-tour flip store
  // dialogs; community + X open through the sidecar's app.shell.openExternal;
  // leaderboard flips the overlay view. startTour / markSetupGuideCompleted feed
  // AppDialogs' onboarding close-flow.
  const {
    checklist: onboardingChecklist,
    startTour,
    markSetupGuideCompleted
  } = useOnboardingChecklist({
    projectCount: projects.length,
    hasCreatedTask: data.tasks.some((t) => !t.is_temporary),
    onCheckLeaderboard: () => useTabStore.getState().setActiveView('leaderboard'),
    onJoinCommunity: () =>
      void trpcClient.app.shell.openExternal.mutate({ url: COMMUNITY_DISCORD_URL }),
    onFollowOnX: () => void trpcClient.app.shell.openExternal.mutate({ url: COMMUNITY_X_URL })
  })

  // ── Agent panels (primary-window only — see file header) ──────────────────
  const [globalAgentPanelState, setGlobalAgentPanelState] = useGlobalAgentPanelState()
  const [agentStatusState, setAgentStatusState] = useAgentStatusState()
  const [isSidePanelResizing, setIsSidePanelResizing] = useState(false)

  // Default the agent mode from the user's `default_terminal_mode` setting until
  // they pick one explicitly (mirrors the Electron App.tsx bootstrap).
  const agentMode = globalAgentPanelState.mode ?? 'claude-code'
  useEffect(() => {
    if (globalAgentPanelState.mode) return
    void trpcClient.settings.get.query({ key: 'default_terminal_mode' }).then((m) => {
      if (m) setGlobalAgentPanelState({ mode: m })
    })
  }, [globalAgentPanelState.mode, setGlobalAgentPanelState, trpcClient])

  const columnsByProjectId = useMemo(() => {
    const map = new Map<string, ColumnConfig[] | null>()
    for (const p of projects) map.set(p.id, p.columns_config)
    return map
  }, [projects])

  // Global-agent session key — one persistent session per (project, sessionIndex);
  // "clear conversation" / mode-change bump the index to spawn a fresh session.
  const agentSessionId = selectedProjectId
    ? `__global-agent-panel:${selectedProjectId}:${globalAgentPanelState.sessionIndex}`
    : null
  // Keep the panel mounted once opened so the terminal session survives toggling.
  const globalAgentMountedRef = useRef(false)
  if (globalAgentPanelState.isOpen) globalAgentMountedRef.current = true

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
    [agentMode, agentSessionId, globalAgentPanelState.sessionIndex, setGlobalAgentPanelState, trpcClient]
  )

  // Idle-agent list for the Agent Status panel. useIdleTasks fetches unfiltered;
  // dismissals + the All/Current toggle are applied here (mirrors Electron App.tsx).
  const { idleTasks: rawIdleTasks } = useIdleTasks(data.tasks, null, columnsByProjectId)
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
  const attentionTaskIds = useMemo(
    () => new Set(data.tasks.filter((t) => t.needs_attention).map((t) => t.id)),
    [data.tasks]
  )

  // A dead tRPC WebSocket leaves the board query PENDING forever (wsLink retries,
  // it never errors). Escalate a long pending state to a connection warning.
  const [stalled, setStalled] = useState(false)
  useEffect(() => {
    if (boardStatus !== 'pending') {
      setStalled(false)
      return
    }
    const t = setTimeout(() => setStalled(true), 5000)
    return () => clearTimeout(t)
  }, [boardStatus])

  if (boardStatus === 'error') {
    return <Centered>Couldn’t load the board: {boardError?.message ?? 'unknown error'}. Retrying…</Centered>
  }
  if (boardStatus === 'pending') {
    return <Centered>{stalled ? 'Can’t reach the sidecar — is the server running?' : 'Connecting…'}</Centered>
  }
  if (projects.length === 0) {
    return <Centered>No projects in this workspace yet.</Centered>
  }

  const currentProjectName = projects.find((p) => p.id === selectedProjectId)?.name
  const currentProjectPath = projects.find((p) => p.id === selectedProjectId)?.path ?? ''
  const globalAgentVisible =
    agentSessionId !== null && globalAgentMountedRef.current && globalAgentPanelState.isOpen

  // Header action bar — fork-only TerminalStatusButton + the shared
  // AppHeaderActions (project-tabs / zen / explode / scratch terminal / agent
  // status / global agent / update). All confined to HomeView (the primary
  // surface) → the agent-panel toggles never leak into a secondary window. The
  // fork has no auto-updater backend, so UpdateButton gets null version → hidden.
  const headerActions = (
    <>
      {/* Active-terminals trigger — auto-hides at 0 running PTYs; opens the
          store-driven TerminalStatusDialog rendered in AppDialogs. */}
      <TerminalStatusButton side="bottom" />
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
        durationLocked={false}
        handleCreateScratchTerminal={handleCreateScratchTerminal}
        newTempTaskShortcut={newTempTaskShortcut}
        agentStatusState={agentStatusState}
        setAgentStatusState={setAgentStatusState}
        attentionTaskIds={attentionTaskIds}
        agentStatusPanelShortcut={agentStatusPanelShortcut}
        globalAgentPanelState={globalAgentPanelState}
        setGlobalAgentPanelState={setGlobalAgentPanelState}
        globalAgentPanelShortcut={globalAgentPanelShortcut}
        updateVersion={null}
        updateDownloadPercent={null}
      />
    </>
  )

  return (
    <SidebarProvider defaultOpen className="h-svh min-h-0 bg-background text-foreground">
      <AppSidebar
        projects={projects}
        projectGroups={data.projectGroups}
        tasks={data.tasks}
        selectedProjectId={selectedProjectId}
        onSelectProject={(id) => useTabStore.getState().selectProject(id)}
        // Store-driven orchestration: sidebar buttons flip useDialogStore /
        // useTabStore state; AppDialogs + OverlayViewRouter (below) render the
        // target. Settings + project (create/settings/delete) + group dialogs are
        // registered in AppDialogs; the sidebar's create/delete/group-settings
        // buttons flip the store directly (ProjectsRailView/TreeView), so only
        // onProjectSettings is routed through here.
        onProjectSettings={(project) => useDialogStore.getState().openProjectSettings(project)}
        onSettings={() => useDialogStore.getState().openSettings()}
        onUsageAnalytics={() => useTabStore.getState().setActiveView('usage-analytics')}
        onLeaderboard={() => useTabStore.getState().setActiveView('leaderboard')}
        onboardingChecklist={onboardingChecklist}
        zenMode={zenMode}
        onSetWindowButtonVisibility={NOOP}
        convexConfigured={false}
        feedbackSlot={null}
        keyRecorder={KeyRecorder}
        sessionTaskIds={EMPTY_SESSION_IDS}
        onReorderProjects={data.reorderProjects}
        onCreateProjectGroup={data.createProjectGroup}
        onCreateFolderWithProjects={data.createFolderWithProjects}
        onRenameProjectGroup={data.renameProjectGroup}
        onDeleteProjectGroup={data.deleteProjectGroup}
        onSetGroupCollapsed={data.setGroupCollapsed}
        onReorderTopLevel={data.reorderTopLevel}
        onMoveProjectToGroup={data.moveProjectToGroup}
        onReorderProjectsInGroup={data.reorderProjectsInGroup}
        onTaskReorder={data.reorderTasks}
        onTaskMove={data.moveTask}
        onTaskReparent={data.reparentTask}
        onTaskBulkReparent={data.bulkReparent}
        onTaskFieldUpdate={data.contextMenuUpdate}
        onTaskBulkFieldUpdate={data.bulkContextMenuUpdate}
        onSetTasksPinned={data.setTasksPinned}
        onSetCollapsed={data.setTaskCollapsed}
        onPinnedReorder={data.reorderPinnedTasks}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <TabBar
          tabs={tabs}
          activeIndex={activeTabIndex}
          activeView={activeView}
          onTabClick={(i) => useTabStore.getState().setActiveTabIndex(i)}
          onTabClose={(i) => void closeTab(i)}
          onTabReorder={(from, to) => useTabStore.getState().reorderTabs(from, to)}
          onTabRename={async (taskId, title) => {
            const updated = await trpcClient.task.update.mutate({ id: taskId, title })
            data.updateTask(updated)
          }}
          hideTabs={explodeMode}
          rightContent={headerActions}
        />
        {/* `relative` so OverlayViewRouter's `absolute inset-0` plane covers the
            content. Every tab stays mounted; inactive tabs hide via `invisible` +
            `inert` so terminal/chat sessions survive tab switches (matches
            canonical App.tsx). In explode mode this same container becomes a CSS
            grid that tiles the open task tabs (mirrors canonical App.tsx). */}
        <div
          ref={explodeGridRef}
          className={cn(
            'relative min-h-0 flex-1 overflow-hidden',
            explodeMode && 'grid gap-1 p-1'
          )}
          style={
            explodeMode
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
              : undefined
          }
        >
          {tabs.map((tab, i) => {
            const isViewActive = activeView === 'tabs' && i === deferredActiveTabIndex
            // Explode mode tiles only task tabs; the home tab is hidden.
            if (explodeMode && tab.type !== 'task') return null
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
                        'relative min-h-0 overflow-hidden rounded border',
                        isExplodeFocused
                          ? 'border-primary/60 ring-2 ring-primary/40'
                          : 'border-border'
                      )
                    : `absolute inset-0 ${!isViewActive ? 'invisible [&_*]:transition-none!' : 'z-10'}`
                }
                inert={!explodeMode && !isViewActive ? true : undefined}
              >
                {tab.type === 'home' ? (
                  <HomeContainer
                    data={data}
                    selectedProjectId={selectedProjectId}
                    isActive={isViewActive}
                    onTaskClick={(task) => openTask(task.id)}
                    editorHandleRef={homeEditorHandle}
                  />
                ) : (
                  <div className={explodeMode ? 'absolute inset-0' : 'h-full'}>
                    <TaskDetailView
                      data={data}
                      taskId={tab.taskId}
                      isActive={explodeMode || isViewActive}
                      hasShortcutFocus={
                        explodeMode ? focusedExplodeTaskId === tab.taskId : isViewActive
                      }
                      compact={explodeMode}
                      zenMode={zenMode}
                      onClose={() => closeTabByTaskId(tab.taskId)}
                      onNavigateToTask={openTask}
                    />
                  </div>
                )}
              </div>
            )
          })}
          <OverlayViewRouter
            selectedProjectId={selectedProjectId}
            projectName={currentProjectName}
            projectPath={currentProjectPath}
            onTaskClick={openTask}
          />
        </div>
      </div>

      {/* Global Agent panel — kept mounted (hidden, not unmounted) once opened so
          the terminal session persists across toggles. Floating-window controls
          are omitted (no floating-window infra in the fork) → the panel renders
          without the detach dropdown. */}
      {agentSessionId !== null && globalAgentMountedRef.current && (
        <>
          {globalAgentVisible && (
            <ResizeHandle
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
          <div
            className={globalAgentVisible ? 'min-h-0' : 'invisible w-0 overflow-hidden'}
            style={globalAgentVisible ? undefined : { position: 'absolute' }}
          >
            <GlobalAgentSidePanel
              width={globalAgentPanelState.panelWidth}
              sessionId={agentSessionId}
              cwd={currentProjectPath}
              mode={agentMode as TerminalMode}
              isActive={globalAgentPanelState.isOpen}
              isResizing={isSidePanelResizing}
              onNewSession={handleAgentNewSession}
              onModeChange={handleAgentModeChange}
            />
          </div>
        </>
      )}

      {/* Agent Status panel — idle/stalled agent list with dismiss + navigate. */}
      {agentStatusState.isLocked && (
        <>
          <ResizeHandle
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
            onReset={() => setAgentStatusState({ panelWidth: DEFAULT_AGENT_STATUS_PANEL_WIDTH })}
          />
          <AgentStatusSidePanel
            width={agentStatusState.panelWidth}
            idleTasks={idleTasks}
            filterCurrentProject={agentStatusState.filterCurrentProject}
            onFilterToggle={() =>
              setAgentStatusState({ filterCurrentProject: !agentStatusState.filterCurrentProject })
            }
            onNavigate={openTask}
            onDismiss={handleDismissIdle}
            columnsByProjectId={columnsByProjectId}
            selectedProjectId={selectedProjectId}
            currentProjectName={currentProjectName}
          />
        </>
      )}

      {/* Store-driven dialog registry + toast surface (mounted once at root).
          Project CRUD + group dialogs patch the lifted board (`data`) + selection
          so the sidebar updates without forking a second useTasksData instance. */}
      <AppDialogs
        data={data}
        selectedProjectId={selectedProjectId}
        onSelectProject={(id) => useTabStore.getState().selectProject(id)}
        onOpenTask={openTask}
        startTour={startTour}
        markSetupGuideCompleted={markSetupGuideCompleted}
      />
    </SidebarProvider>
  )
}
