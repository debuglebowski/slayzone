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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SidebarProvider } from '@slayzone/ui'
import { useTasksData } from '@slayzone/tasks/client'
import { useDialogStore, useTabStore } from '@slayzone/settings'
import { HomeContainer } from '@slayzone/home/client'
import { taskDetailCache } from '@slayzone/task/client/taskDetailCache'
import { ResizeHandle } from '@slayzone/task/client/ResizeHandle'
import { useTRPCClient } from '@slayzone/transport/client'
import type { TerminalMode } from '@slayzone/terminal/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import {
  useGlobalAgentPanelState,
  GlobalAgentPanelButton,
  GlobalAgentSidePanel,
  GLOBAL_AGENT_PANEL_MIN_WIDTH,
  GLOBAL_AGENT_PANEL_MAX_WIDTH,
  DEFAULT_GLOBAL_AGENT_PANEL_WIDTH,
  useAgentStatusState,
  AgentStatusButton,
  AgentStatusSidePanel,
  AGENT_STATUS_PANEL_MIN_WIDTH,
  AGENT_STATUS_PANEL_MAX_WIDTH,
  DEFAULT_AGENT_STATUS_PANEL_WIDTH,
  useIdleTasks
} from '@slayzone/agent-panels'
import {
  AppSidebar,
  type OnboardingChecklistState,
  type KeyRecorderComponent
} from '@slayzone/sidebar'
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

// Placeholder tab-bar chrome. The fork is single-view (Home) until the task
// detail view lands — at which point this is replaced by the real tab system
// (useTabStore). For now it just frames the Home tab so the chrome is in place.
// The agent-panel toggles live on the right edge of this bar.
function TabBarPlaceholder({ actions }: { actions?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-3 py-1.5">
      <div className="rounded-md bg-tab-active px-3 py-1 text-xs font-medium text-foreground">
        Home
      </div>
      <span className="text-[11px] text-muted-foreground">Task tabs arrive with the task view</span>
      {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
    </div>
  )
}

// Stable defaults for the app-chrome props the Electron app supplies but the
// fork doesn't have yet (no native window chrome, convex, feedback, onboarding,
// or shortcut recorder in the shell). Module-level → referentially stable.
const EMPTY_SESSION_IDS = new Set<string>()
const NOOP = (): void => {}
const NOOP_KEY_RECORDER: KeyRecorderComponent = () => null
const FORK_CHECKLIST: OnboardingChecklistState = {
  steps: [],
  dismissed: true,
  remainingCount: 0,
  hasRemaining: false,
  onDismiss: NOOP
}

export function HomeView(): React.JSX.Element {
  const data = useTasksData()
  const { projects, boardStatus, boardError } = data
  const trpcClient = useTRPCClient()

  const [picked, setPicked] = useState('')
  const selectedProjectId = picked || projects[0]?.id || ''

  // Fork selected-task router. The real tab system isn't ported yet (the tab bar
  // is still a placeholder), so a task open simply swaps the content area to the
  // canonical Task Detail page and back. Prefetch warms the Suspense cache so the
  // page paints without the cold use() scheduling delay (mirrors the Electron
  // main.tsx prefetch of open tabs).
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const openTask = useCallback((id: string) => {
    if (!id) return
    taskDetailCache.prefetch('taskDetail', id)
    setOpenTaskId(id)
  }, [])
  const closeTask = useCallback(() => setOpenTaskId(null), [])

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
  const attentionCount = useMemo(
    () => data.tasks.filter((t) => t.needs_attention).length,
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

  const headerActions = (
    <>
      <AgentStatusButton
        active={agentStatusState.isLocked}
        count={attentionCount}
        onClick={() => setAgentStatusState({ isLocked: !agentStatusState.isLocked })}
        size="sm"
      />
      <GlobalAgentPanelButton
        active={globalAgentPanelState.isOpen}
        disabled={!selectedProjectId}
        onClick={() => setGlobalAgentPanelState({ isOpen: !globalAgentPanelState.isOpen })}
        size="sm"
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
        onSelectProject={(id) => setPicked(id)}
        // Store-driven orchestration: sidebar buttons flip useDialogStore /
        // useTabStore state; AppDialogs + OverlayViewRouter (below) render the
        // target. Settings/project-settings dialogs aren't ported into the fork
        // yet, so openSettings/openProjectSettings flip state + no-op gracefully
        // until their leaf dialog registers in AppDialogs.
        onProjectSettings={(project) => useDialogStore.getState().openProjectSettings(project)}
        onSettings={() => useDialogStore.getState().openSettings()}
        onUsageAnalytics={() => useTabStore.getState().setActiveView('usage-analytics')}
        onLeaderboard={() => useTabStore.getState().setActiveView('leaderboard')}
        onboardingChecklist={FORK_CHECKLIST}
        onSetWindowButtonVisibility={NOOP}
        convexConfigured={false}
        feedbackSlot={null}
        keyRecorder={NOOP_KEY_RECORDER}
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
        <TabBarPlaceholder actions={headerActions} />
        {/* `relative` so OverlayViewRouter's `absolute inset-0` plane covers the
            content (which stays mounted underneath, preserving its state). */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {openTaskId ? (
            <TaskDetailView
              data={data}
              taskId={openTaskId}
              onClose={closeTask}
              onNavigateToTask={openTask}
            />
          ) : (
            <HomeContainer
              data={data}
              selectedProjectId={selectedProjectId}
              isActive
              onTaskClick={(task) => openTask(task.id)}
            />
          )}
          <OverlayViewRouter />
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

      {/* Store-driven dialog registry + toast surface (mounted once at root). */}
      <AppDialogs />
    </SidebarProvider>
  )
}
