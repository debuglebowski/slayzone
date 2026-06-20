// Chromium-fork dialog orchestrator — the store-driven registry every leaf
// dialog plugs into. Mirrors the canonical app-shell/AppDialogs.tsx
// (packages/apps/app/src/renderer/src/app-shell/AppDialogs.tsx): it watches
// useDialogStore (@slayzone/settings) and lazy-mounts whichever dialog has its
// open-flag set.
//
// Open-state is store-driven: each dialog reads its own slice straight from
// useDialogStore, so an entry point opens a dialog by flipping store state
// (openCreateTask / openEditTask / openDeleteTask / openCreateProject /
// openDeleteProject / openGroupSettings / openProjectSettings) with no prop
// threading — the sidebar "+", board "add", and context menus already do this.
// Dialogs that mutate the SHARED board (task + project CRUD, group rename/delete)
// additionally receive the ONE lifted useTasksData instance + selection +
// open-task nav from HomeView, so their optimistic patches land on the same board
// state the sidebar renders — minting a second useTasksData() here would fork the
// board. Pure store-driven dialogs (Settings) take nothing.
//
// Register a leaf dialog by mirroring an existing block: read its open-flag from
// the store, gate the <Suspense> with shouldMount(key, open), and route
// onOpenChange(false) → the store's close action.
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps
} from 'react'
import {
  Toaster,
  toast,
  useUndo,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@slayzone/ui'
import { useDialogStore, useTabStore, type Tab } from '@slayzone/settings'
import { useTRPCClient } from '@slayzone/transport/client'
import { useChangelogAutoOpen } from '@slayzone/onboarding'
import { useGlobalAgentPanelState } from '@slayzone/agent-panels'
import { getDoneStatus } from '@slayzone/projects/shared'
import type { useTasksData } from '@slayzone/tasks/client'
import type { Project } from '@slayzone/projects/shared'
import type { Task } from '@slayzone/task/shared'

// Lazy chunks so the heavy settings/project-settings tab code (CodeMirror, MCP/
// AI-provider editors, integration + test panels) stays out of the initial
// bundle and loads only on first open. Barrel exports named components → adapt
// to a default export for React.lazy.
const UserSettingsDialog = lazy(() =>
  import('@slayzone/settings').then((m) => ({ default: m.UserSettingsDialog }))
)
const CreateProjectDialog = lazy(() =>
  import('@slayzone/projects/client').then((m) => ({ default: m.CreateProjectDialog }))
)
const ProjectSettingsDialog = lazy(() =>
  import('@slayzone/projects/client').then((m) => ({ default: m.ProjectSettingsDialog }))
)
const DeleteProjectDialog = lazy(() =>
  import('@slayzone/projects/client').then((m) => ({ default: m.DeleteProjectDialog }))
)
const GroupSettingsDialog = lazy(() =>
  import('@slayzone/projects/client').then((m) => ({ default: m.GroupSettingsDialog }))
)
const CreateTaskDialog = lazy(() =>
  import('@slayzone/task/client').then((m) => ({ default: m.CreateTaskDialog }))
)
const EditTaskDialog = lazy(() =>
  import('@slayzone/task/client').then((m) => ({ default: m.EditTaskDialog }))
)
const DeleteTaskDialog = lazy(() =>
  import('@slayzone/task/client').then((m) => ({ default: m.DeleteTaskDialog }))
)
// Cmd+K command palette — extracted to its own package (@slayzone/search) and
// shared with the Electron renderer. fzf/cmdk stay out of the initial bundle.
const SearchDialog = lazy(() =>
  import('@slayzone/search').then((m) => ({ default: m.SearchDialog }))
)
// First-run / informational dialogs — extracted to packages, shared with the
// Electron renderer. Static `useChangelogAutoOpen` import above only reaches the
// hook's module graph (changelog-data + settings store), so these heavy component
// chunks (framer-motion, scenes) still split out of the initial bundle.
const OnboardingDialog = lazy(() =>
  import('@slayzone/onboarding').then((m) => ({ default: m.OnboardingDialog }))
)
const ChangelogDialog = lazy(() =>
  import('@slayzone/onboarding').then((m) => ({ default: m.ChangelogDialog }))
)
const TutorialAnimationModal = lazy(() =>
  import('@slayzone/onboarding').then((m) => ({ default: m.TutorialAnimationModal }))
)
const CliInstallDialog = lazy(() =>
  import('@slayzone/settings').then((m) => ({ default: m.CliInstallDialog }))
)
// Active-terminals dialog — shared with the Electron renderer. Rendered once at
// root, controlled by useDialogStore.terminalsOpen (opened by the header's
// TerminalStatusButton in HomeView). Lazy so its PTY-list polling splits out.
const TerminalStatusDialog = lazy(() =>
  import('@slayzone/terminal').then((m) => ({ default: m.TerminalStatusDialog }))
)

type CreateProjectProps = ComponentProps<typeof CreateProjectDialog>
type ProjectSettingsProps = ComponentProps<typeof ProjectSettingsDialog>

interface AppDialogsProps {
  // The ONE lifted board-data instance from HomeView (NOT a fresh useTasksData()).
  // Project CRUD + group dialogs patch its optimistic state so the sidebar updates.
  data: ReturnType<typeof useTasksData>
  selectedProjectId: string
  onSelectProject: (id: string) => void
  /** Open a task in the fork's selected-task router (HomeView). */
  onOpenTask: (taskId: string) => void
  /**
   * Onboarding close-flow handlers from HomeView's useOnboardingChecklist (the
   * checklist hook lives there to feed the sidebar). Finishing onboarding marks
   * the setup-guide step done + offers the tour. Store-driven dialogs take
   * nothing; only onboarding needs these two.
   */
  startTour: () => void
  markSetupGuideCompleted: () => void
}

// Lazy-mount gate — ported verbatim from app-shell/useLazyMounted.ts. The first
// time a dialog's open-flag is true we mount its chunk and KEEP it mounted, so
// close/reopen animations work. Leaf dialogs gate their <Suspense> block with
// `shouldMount(key, open)`.
export function useLazyMounted(): (key: string, open: boolean) => boolean {
  const set = useRef(new Set<string>())
  return (key: string, open: boolean) => {
    if (open) set.current.add(key)
    return set.current.has(key)
  }
}

export function AppDialogs({
  data,
  selectedProjectId,
  onSelectProject,
  onOpenTask,
  startTour,
  markSetupGuideCompleted
}: AppDialogsProps): React.JSX.Element {
  const shouldMount = useLazyMounted()
  const createTaskOpen = useDialogStore((s) => s.createTaskOpen)
  const createTaskDraft = useDialogStore((s) => s.createTaskDraft)
  const editingTask = useDialogStore((s) => s.editingTask)
  const deletingTask = useDialogStore((s) => s.deletingTask)
  const settingsOpen = useDialogStore((s) => s.settingsOpen)
  const settingsInitialTab = useDialogStore((s) => s.settingsInitialTab)
  const createProjectOpen = useDialogStore((s) => s.createProjectOpen)
  const projectSettingsTarget = useDialogStore((s) => s.projectSettingsTarget)
  const projectSettingsInitialTab = useDialogStore((s) => s.projectSettingsInitialTab)
  const projectSettingsOnboardingProvider = useDialogStore(
    (s) => s.projectSettingsOnboardingProvider
  )
  const deletingProject = useDialogStore((s) => s.deletingProject)
  const groupSettingsTarget = useDialogStore((s) => s.groupSettingsTarget)

  // ── Search palette (Cmd+K) ────────────────────────────────────────────────
  // Fully store-driven: open-flag + fileContext come from useDialogStore (the
  // HomeView Cmd+K handler primes fileContext via openSearch); tasks/projects ride
  // the lifted board `data`; tabs/closed-tabs/active-task come straight from the
  // tab store. The global-agent toggle reads the SHARED useGlobalAgentPanelState
  // store (singleton) so it flips the same state HomeView renders.
  const trpcClient = useTRPCClient()
  const [agentPanel, setAgentPanel] = useGlobalAgentPanelState()
  const searchOpen = useDialogStore((s) => s.searchOpen)
  const tabs = useTabStore((s) => s.tabs)
  const activeTabIndex = useTabStore((s) => s.activeTabIndex)
  const closedTabs = useTabStore((s) => s.closedTabs)
  const openTaskTabs = useMemo(
    () => tabs.filter((t): t is Extract<Tab, { type: 'task' }> => t.type === 'task'),
    [tabs]
  )
  const activeTaskId = useMemo(() => {
    const at = tabs[activeTabIndex]
    return at?.type === 'task' ? at.taskId : null
  }, [tabs, activeTabIndex])

  // Scratch terminal: create a temporary "Terminal N" task and open it. Status is
  // omitted → the sidecar resolves the project default. Optimistic patch lands on
  // the lifted board; openTask routes to the new tab (mirrors handleTaskCreatedAndOpen).
  const handleNewTemporaryTask = useCallback(async () => {
    if (!selectedProjectId) return
    const existing = data.tasks
      .filter((t) => t.project_id === selectedProjectId)
      .map((t) => /^Terminal (\d+)$/.exec(t.title))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => parseInt(m[1], 10))
    const nextNum = existing.length ? Math.max(...existing) + 1 : 1
    const task = await trpcClient.task.create.mutate({
      projectId: selectedProjectId,
      title: `Terminal ${nextNum}`,
      isTemporary: true
    })
    if (!task) return
    data.setTasks((prev) => [task, ...prev])
    onOpenTask(task.id)
  }, [selectedProjectId, data, trpcClient, onOpenTask])

  // ── Task dialog handlers ──────────────────────────────────────────────────
  // The dialogs run the tRPC mutation themselves (and every task mutation fires
  // notify.onTasksChanged → board self-refreshes); these callbacks add the
  // optimistic patch to the lifted board + drive the store's open/close.
  const handleTaskCreated = (task: Task): void => {
    data.setTasks((prev) => [task, ...prev])
    useDialogStore.getState().closeCreateTask()
  }
  const handleTaskCreatedAndOpen = (task: Task): void => {
    data.setTasks((prev) => [task, ...prev])
    useDialogStore.getState().closeCreateTask()
    onOpenTask(task.id)
  }
  const handleTaskUpdated = (task: Task): void => {
    data.updateTask(task)
    useDialogStore.getState().closeEditTask()
  }

  // ── Project dialog handlers ───────────────────────────────────────────────
  // Mirror the canonical App.tsx handlers, but write through the lifted
  // useTasksData instance (data.*) instead of local React state. The dialogs run
  // the tRPC mutation themselves; these callbacks patch the shared board +
  // selection + drive the store's open/close.
  const handleProjectCreated: CreateProjectProps['onCreated'] = (project, context) => {
    data.setProjects((prev) => [...prev, project])
    onSelectProject(project.id)
    const store = useDialogStore.getState()
    store.closeCreateProject()
    // "Create and continue" for an integration start mode → land on the
    // Integrations tab with the provider's onboarding primed (degrades to the
    // plain Integrations tab if the fork sidecar lacks the backend).
    if (context.startMode === 'github' || context.startMode === 'linear') {
      store.openProjectSettings(project, {
        initialTab: 'integrations',
        integrationOnboardingProvider: context.startMode
      })
    }
  }
  const handleProjectUpdated = (project: Project): void => {
    data.updateProject(project)
    useDialogStore.getState().closeProjectSettings()
  }
  // In-place update without closing — patch the board + refresh the dialog's
  // target object. Set the target directly (not openProjectSettings) so the
  // active tab + onboarding context survive the update.
  const handleProjectChanged = (project: Project): void => {
    data.updateProject(project)
    useDialogStore.setState({ projectSettingsTarget: project })
  }
  const handleProjectDeleted = (): void => {
    const store = useDialogStore.getState()
    const deleting = store.deletingProject
    if (!deleting) return
    if (store.projectSettingsTarget?.id === deleting.id) store.closeProjectSettings()
    data.deleteProject(deleting.id, selectedProjectId, onSelectProject)
    store.closeDeleteProject()
  }

  // ── First-run / informational dialogs ─────────────────────────────────────
  const onboardingOpen = useDialogStore((s) => s.onboardingOpen)
  const changelogOpen = useDialogStore((s) => s.changelogOpen)
  const showAnimatedTour = useDialogStore((s) => s.showAnimatedTour)

  // Mount onboarding on a fresh install (onboarding_completed !== 'true') or when
  // explicitly reopened from the checklist. Once mounted it stays mounted so
  // close/reopen animations work (mirrors canonical App.tsx).
  const [shouldMountOnboarding, setShouldMountOnboarding] = useState(false)
  useEffect(() => {
    if (onboardingOpen) {
      setShouldMountOnboarding(true)
      return
    }
    let cancelled = false
    void trpcClient.settings.get.query({ key: 'onboarding_completed' }).then((v) => {
      if (!cancelled && v !== 'true') setShouldMountOnboarding(true)
    })
    return () => {
      cancelled = true
    }
  }, [onboardingOpen, trpcClient])

  // Auto-open the changelog when the running version differs from last-seen.
  const [autoChangelogOpen, lastSeenVersion, dismissAutoChangelog] = useChangelogAutoOpen()

  // ── Complete-task confirm + active-terminals dialog ───────────────────────
  // Both consume useDialogStore fields the Electron app drives; rendering them
  // here keeps the fork at parity (no dead store fields). Complete marks the
  // active task's status → done, closes its tab, and offers undo — mirrors
  // canonical App.tsx handleCompleteTaskConfirm. (Its trigger is the
  // "complete active task" keyboard shortcut, which lands with the app-shortcuts
  // port; the store action is wired now so it works the moment a trigger fires.)
  const completeTaskDialogOpen = useDialogStore((s) => s.completeTaskDialogOpen)
  const { push: pushUndo, undo } = useUndo()
  const handleCompleteTaskConfirm = useCallback(async () => {
    const store = useTabStore.getState()
    const idx = store.activeTabIndex
    const at = store.tabs[idx]
    if (at?.type !== 'task') return
    const task = data.tasks.find((t) => t.id === at.taskId)
    if (!task) return
    const project = data.projects.find((p) => p.id === task.project_id)
    const doneStatus = getDoneStatus(project?.columns_config)
    const prevStatus = task.status
    await trpcClient.task.update.mutate({ id: at.taskId, status: doneStatus })
    data.updateTask({ ...task, status: doneStatus })
    store.closeTab(idx)
    useDialogStore.getState().closeCompleteTaskDialog()
    if (prevStatus === doneStatus) return
    pushUndo({
      label: `Completed "${task.title}"`,
      undo: async () => {
        await trpcClient.task.update.mutate({ id: task.id, status: prevStatus })
        data.setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: prevStatus } : t)))
      },
      redo: async () => {
        await trpcClient.task.update.mutate({ id: task.id, status: doneStatus })
        data.setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: doneStatus } : t)))
      }
    })
    toast(`Completed "${task.title}"`, { action: { label: 'Undo', onClick: () => void undo() } })
  }, [data, trpcClient, pushUndo, undo])

  return (
    <>
      {/* Create Task. Sidebar tree "+" and board column "add" → openCreateTask
          (with a column-derived draft). onCreated appends to the board; "Create +
          open" also routes to the new task tab via HomeView's onOpenTask. */}
      {shouldMount('createTask', createTaskOpen) && (
        <Suspense fallback={null}>
          <CreateTaskDialog
            open={createTaskOpen}
            onOpenChange={(open) => {
              if (!open) useDialogStore.getState().closeCreateTask()
            }}
            onCreated={handleTaskCreated}
            onCreatedAndOpen={handleTaskCreatedAndOpen}
            draft={createTaskDraft}
            tags={data.tags}
            onTagCreated={(tag) =>
              data.setTags((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]))
            }
          />
        </Suspense>
      )}

      {/* Edit Task. openEditTask(task) → editingTask. The dialog runs the update
          mutation; onUpdated patches the board + closes. */}
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

      {/* Delete Task. openDeleteTask(task) → deletingTask. onDeleteTask =
          data.deleteTask (optimistic remove + trpc.task.delete); onDeleted just
          closes so there's no double-delete. */}
      {shouldMount('deleteTask', !!deletingTask) && (
        <Suspense fallback={null}>
          <DeleteTaskDialog
            task={deletingTask}
            open={!!deletingTask}
            onOpenChange={(open) => {
              if (!open) useDialogStore.getState().closeDeleteTask()
            }}
            onDeleteTask={data.deleteTask}
            onDeleted={() => useDialogStore.getState().closeDeleteTask()}
          />
        </Suspense>
      )}

      {/* App-level (user) Settings. Store-driven: onSettings (HomeView) →
          openSettings() flips settingsOpen; closing routes back to
          closeSettings(). initialTab is null in the store → undefined so the
          dialog falls back to its own 'appearance' default. */}
      {shouldMount('settings', settingsOpen) && (
        <Suspense fallback={null}>
          <UserSettingsDialog
            open={settingsOpen}
            onOpenChange={(open) => {
              if (!open) useDialogStore.getState().closeSettings()
            }}
            initialTab={settingsInitialTab ?? undefined}
            onTabChange={(tab) => useDialogStore.getState().openSettings({ initialTab: tab })}
          />
        </Suspense>
      )}

      {/* Create Project. Sidebar's "+" → openCreateProject(). onCreated appends
          to the board + selects the new project; an integration start mode also
          deep-links into project settings. */}
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

      {/* Project Settings. Sidebar context-menu / onProjectSettings →
          openProjectSettings(project[, {initialTab}]). Templates tab is omitted
          (renderTemplatesTab unset) — the fork has no template editor yet, so the
          tab simply doesn't appear. Tabs that hit fork-absent backends degrade
          gracefully (integration-lock check is try/caught inside the dialog). */}
      {shouldMount('projectSettings', !!projectSettingsTarget) && (
        <Suspense fallback={null}>
          <ProjectSettingsDialog
            project={projectSettingsTarget}
            open={!!projectSettingsTarget}
            onOpenChange={(open) => {
              if (!open) useDialogStore.getState().closeProjectSettings()
            }}
            initialTab={(projectSettingsInitialTab ?? undefined) as ProjectSettingsProps['initialTab']}
            integrationOnboardingProvider={
              projectSettingsOnboardingProvider as ProjectSettingsProps['integrationOnboardingProvider']
            }
            onIntegrationOnboardingHandled={() =>
              useDialogStore.setState({ projectSettingsOnboardingProvider: null })
            }
            onUpdated={handleProjectUpdated}
            onChanged={handleProjectChanged}
          />
        </Suspense>
      )}

      {/* Delete Project. Sidebar context-menu → openDeleteProject(p). The dialog
          runs the delete mutation, then onDeleted removes it from the board +
          re-selects another project. */}
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

      {/* Project-group (folder) settings. Sidebar → openGroupSettings(group).
          Rename/delete write through the lifted board (optimistic group state). */}
      {groupSettingsTarget && (
        <Suspense fallback={null}>
          <GroupSettingsDialog
            group={groupSettingsTarget}
            open={!!groupSettingsTarget}
            onClose={() => useDialogStore.getState().closeGroupSettings()}
            onRename={(name) => data.renameProjectGroup(groupSettingsTarget.id, name)}
            onDelete={() => data.deleteProjectGroup(groupSettingsTarget.id)}
          />
        </Suspense>
      )}

      {/* Command palette (Cmd+K). HomeView's hotkey + sidebar entry flip
          searchOpen via openSearch (priming fileContext for file results). Actions
          route to store/board: new-task/add-project/changelog/settings flip the
          dialog store; reopen-tab/go-home hit the tab store; new-temp-task creates
          a scratch terminal; toggle-agent-panel flips the shared agent-panel store. */}
      {shouldMount('search', searchOpen) && (
        <Suspense fallback={null}>
          <SearchDialog
            open={searchOpen}
            onOpenChange={(open) => {
              if (!open) useDialogStore.getState().closeSearch()
            }}
            tasks={data.tasks}
            projects={data.projects}
            closedTabs={closedTabs}
            openTaskTabs={openTaskTabs}
            activeTaskId={activeTaskId}
            onSelectTask={onOpenTask}
            onSelectProject={onSelectProject}
            onNewTask={() => useDialogStore.getState().openCreateTask()}
            onNewTemporaryTask={() => void handleNewTemporaryTask()}
            onReopenClosedTab={() => useTabStore.getState().reopenClosedTab()}
            onAddProject={() => useDialogStore.getState().openCreateProject()}
            onGoHome={() => {
              const hi = useTabStore.getState().tabs.findIndex((t) => t.type === 'home')
              if (hi >= 0) useTabStore.getState().setActiveTabIndex(hi)
            }}
            onToggleGlobalAgentPanel={() => setAgentPanel({ isOpen: !agentPanel.isOpen })}
            onOpenChangelog={() => useDialogStore.getState().openChangelog()}
            onOpenSettings={() => useDialogStore.getState().openSettings()}
          />
        </Suspense>
      )}

      {/* Onboarding — auto-shows on a fresh install (externalOpen reflects the
          store flag; the dialog also self-opens while onboarding_completed is
          unset). On close: mark the setup-guide step done + offer the tour once
          (mirrors canonical app-shell/AppDialogs). */}
      {shouldMount('onboarding', shouldMountOnboarding) && (
        <Suspense fallback={null}>
          <OnboardingDialog
            externalOpen={onboardingOpen}
            onExternalClose={async () => {
              useDialogStore.getState().closeOnboarding()
              const [onboardingCompleted, prompted] = await Promise.all([
                trpcClient.settings.get.query({ key: 'onboarding_completed' }),
                trpcClient.settings.get.query({ key: 'tutorial_prompted' })
              ])
              if (onboardingCompleted === 'true') markSetupGuideCompleted()
              if (!prompted) {
                void trpcClient.settings.set.mutate({ key: 'tutorial_prompted', value: 'true' })
                toast('Want a quick tour?', {
                  duration: 8000,
                  action: { label: 'Take the tour', onClick: startTour }
                })
              }
            }}
          />
        </Suspense>
      )}

      {/* CLI-install — self-managed open: checks onboarding_completed +
          cli_install_dismissed + whether the slay CLI is already installed, then
          installs via trpc app.meta.installCli (routes to the sidecar). */}
      <Suspense fallback={null}>
        <CliInstallDialog />
      </Suspense>

      {/* Animated tour — opened via the checklist's "Take a tour" (startTour →
          openAnimatedTour) or the post-onboarding toast. Store-driven. */}
      {shouldMount('tutorial', showAnimatedTour) && (
        <Suspense fallback={null}>
          <TutorialAnimationModal
            open={showAnimatedTour}
            onClose={() => useDialogStore.getState().closeAnimatedTour()}
          />
        </Suspense>
      )}

      {/* Changelog — opened from the Cmd+K palette (openChangelog) or auto-opened
          on a version bump (useChangelogAutoOpen). lastSeenVersion highlights
          what's new only on the auto-open path. */}
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

      {/* Complete-task confirm — store-driven (openCompleteTaskDialog). Marks the
          active task done, closes its tab, offers undo. Mirrors canonical
          app-shell/AppDialogs. */}
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
            <AlertDialogAction autoFocus onClick={() => void handleCompleteTaskConfirm()}>
              Complete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Active-terminals dialog — store-driven (terminalsOpen), opened by the
          TerminalStatusButton in HomeView's header. Lists running PTYs with
          terminate + jump-to-task. Mirrors canonical app-shell/AppDialogs. */}
      <Suspense fallback={null}>
        <TerminalStatusDialog tasks={data.tasks} onTaskClick={onOpenTask} />
      </Suspense>

      {/* Toast surface — imported feature code calls toast(); without a mounted
          Toaster those notifications silently no-op. */}
      <Toaster position="bottom-right" theme="dark" closeButton />
    </>
  )
}
