// Chromium-fork Home — the real AppSidebar (left) + the shared @slayzone/home
// shell (right), both fed by ONE lifted useTasksData() instance.
//
// useTasksData() is called once here and passed to both the sidebar (projects/
// tasks + CRUD/reorder mutations) and HomeContainer (via its `data` prop), so
// the two consumers share a single board-data instance instead of each minting
// their own. Sidebar selection drives HomeContainer's selectedProjectId.
import { useEffect, useState } from 'react'
import { SidebarProvider } from '@slayzone/ui'
import { useTasksData } from '@slayzone/tasks/client'
import { HomeContainer } from '@slayzone/home/client'
import {
  AppSidebar,
  type OnboardingChecklistState,
  type KeyRecorderComponent
} from '@slayzone/sidebar'

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
function TabBarPlaceholder(): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-3 py-1.5">
      <div className="rounded-md bg-tab-active px-3 py-1 text-xs font-medium text-foreground">
        Home
      </div>
      <span className="text-[11px] text-muted-foreground">Task tabs arrive with the task view</span>
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

  const [picked, setPicked] = useState('')
  const selectedProjectId = picked || projects[0]?.id || ''

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

  return (
    <SidebarProvider defaultOpen className="h-svh min-h-0 bg-background text-foreground">
      <AppSidebar
        projects={projects}
        projectGroups={data.projectGroups}
        tasks={data.tasks}
        selectedProjectId={selectedProjectId}
        onSelectProject={(id) => setPicked(id)}
        onProjectSettings={NOOP}
        onSettings={NOOP}
        onUsageAnalytics={NOOP}
        onLeaderboard={NOOP}
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
        <TabBarPlaceholder />
        <div className="min-h-0 flex-1 overflow-hidden">
          <HomeContainer data={data} selectedProjectId={selectedProjectId} isActive />
        </div>
      </div>
    </SidebarProvider>
  )
}
