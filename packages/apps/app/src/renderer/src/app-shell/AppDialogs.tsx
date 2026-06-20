import React, { Suspense, type ComponentProps, type Dispatch, type SetStateAction } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC, useTRPCClient } from '@slayzone/transport/client'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Toaster,
  toast,
  UpdateToast
} from '@slayzone/ui'
import { useTabStore, useDialogStore } from '@slayzone/settings'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
import { type GlobalAgentPanelState } from '@slayzone/agent-panels'
import {
  CreateTaskDialog,
  EditTaskDialog,
  DeleteTaskDialog,
  CreateProjectDialog,
  ProjectSettingsDialog,
  DeleteProjectDialog,
  GroupSettingsDialog,
  UserSettingsDialog,
  SearchDialog,
  OnboardingDialog,
  CliInstallDialog,
  TutorialAnimationModal,
  ChangelogDialog,
  TemplatesSettingsTab,
  TerminalStatusDialog
} from './lazy'
import type {
  ProjectIntegrationOnboardingProvider,
  ContextManagerSection
} from './constants'

type CreateTaskProps = ComponentProps<typeof CreateTaskDialog>
type EditTaskProps = ComponentProps<typeof EditTaskDialog>
type DeleteTaskProps = ComponentProps<typeof DeleteTaskDialog>
type CreateProjectProps = ComponentProps<typeof CreateProjectDialog>
type ProjectSettingsProps = ComponentProps<typeof ProjectSettingsDialog>
type DeleteProjectProps = ComponentProps<typeof DeleteProjectDialog>
type GroupSettingsProps = ComponentProps<typeof GroupSettingsDialog>
type SearchDialogProps = ComponentProps<typeof SearchDialog>
type ChangelogProps = ComponentProps<typeof ChangelogDialog>

interface AppDialogsProps {
  shouldMount: (key: string, open: boolean) => boolean
  // Create / edit / delete task
  createTaskOpen: boolean
  handleTaskCreated: CreateTaskProps['onCreated']
  handleTaskCreatedAndOpen: CreateTaskProps['onCreatedAndOpen']
  createTaskDialogDraft: CreateTaskProps['draft']
  projectTags: Tag[]
  setTags: Dispatch<SetStateAction<Tag[]>>
  editingTask: EditTaskProps['task']
  handleTaskUpdated: EditTaskProps['onUpdated']
  deletingTask: DeleteTaskProps['task']
  handleTaskDeleted: DeleteTaskProps['onDeleted']
  // Project dialogs
  createProjectOpen: boolean
  handleProjectCreated: CreateProjectProps['onCreated']
  editingProject: ProjectSettingsProps['project']
  closeProjectSettings: () => void
  projectSettingsInitialTab: ProjectSettingsProps['initialTab']
  testGroupBy: 'none' | 'path' | 'label'
  setTestGroupBy: Dispatch<SetStateAction<'none' | 'path' | 'label'>>
  projectSettingsOnboardingProvider: ProjectIntegrationOnboardingProvider | null
  setProjectSettingsOnboardingProvider: Dispatch<
    SetStateAction<ProjectIntegrationOnboardingProvider | null>
  >
  handleProjectUpdated: ProjectSettingsProps['onUpdated']
  handleProjectChanged: ProjectSettingsProps['onChanged']
  deletingProject: DeleteProjectProps['project']
  handleProjectDeleted: DeleteProjectProps['onDeleted']
  groupSettingsTarget: GroupSettingsProps['group'] | null
  renameProjectGroup: (id: string, name: string) => void
  deleteProjectGroup: (id: string) => void
  // User settings
  settingsOpen: boolean
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  setSettingsRevision: Dispatch<SetStateAction<number>>
  settingsInitialTab: string
  setSettingsInitialTab: Dispatch<SetStateAction<string>>
  settingsInitialAiConfigSection: ContextManagerSection | null
  setSettingsInitialAiConfigSection: Dispatch<SetStateAction<ContextManagerSection | null>>
  // Search
  searchOpen: boolean
  tasks: Task[]
  projects: Project[]
  closedTabs: SearchDialogProps['closedTabs']
  openTaskTabs: SearchDialogProps['openTaskTabs']
  activeTaskId: SearchDialogProps['activeTaskId']
  openTask: (taskId: string) => void
  setSelectedProjectId: (id: string) => void
  setActiveTabIndex: (index: number) => void
  handleCreateScratchTerminal: () => void | Promise<void>
  selectedProjectId: string
  globalAgentPanelState: GlobalAgentPanelState
  setGlobalAgentPanelState: (updates: Partial<GlobalAgentPanelState>) => void
  handleOpenSettings: () => void
  // Onboarding / tutorial / changelog
  shouldMountOnboarding: boolean
  onboardingOpen: boolean
  markSetupGuideCompleted: () => void
  startTour: () => void
  showAnimatedTour: boolean
  changelogOpen: boolean
  autoChangelogOpen: boolean
  dismissAutoChangelog: () => void
  lastSeenVersion: ChangelogProps['lastSeenVersion']
  // Complete-task + update toast + terminal status
  completeTaskDialogOpen: boolean
  handleCompleteTaskConfirm: () => void | Promise<void>
  updateToastDismissed: boolean
  updateVersion: string | null
  setUpdateToastDismissed: Dispatch<SetStateAction<boolean>>
}

export function AppDialogs({
  shouldMount,
  createTaskOpen,
  handleTaskCreated,
  handleTaskCreatedAndOpen,
  createTaskDialogDraft,
  projectTags,
  setTags,
  editingTask,
  handleTaskUpdated,
  deletingTask,
  handleTaskDeleted,
  createProjectOpen,
  handleProjectCreated,
  editingProject,
  closeProjectSettings,
  projectSettingsInitialTab,
  testGroupBy,
  setTestGroupBy,
  projectSettingsOnboardingProvider,
  setProjectSettingsOnboardingProvider,
  handleProjectUpdated,
  handleProjectChanged,
  deletingProject,
  handleProjectDeleted,
  groupSettingsTarget,
  renameProjectGroup,
  deleteProjectGroup,
  settingsOpen,
  setSettingsOpen,
  setSettingsRevision,
  settingsInitialTab,
  setSettingsInitialTab,
  settingsInitialAiConfigSection,
  setSettingsInitialAiConfigSection,
  searchOpen,
  tasks,
  projects,
  closedTabs,
  openTaskTabs,
  activeTaskId,
  openTask,
  setSelectedProjectId,
  setActiveTabIndex,
  handleCreateScratchTerminal,
  selectedProjectId,
  globalAgentPanelState,
  setGlobalAgentPanelState,
  handleOpenSettings,
  shouldMountOnboarding,
  onboardingOpen,
  markSetupGuideCompleted,
  startTour,
  showAnimatedTour,
  changelogOpen,
  autoChangelogOpen,
  dismissAutoChangelog,
  lastSeenVersion,
  completeTaskDialogOpen,
  handleCompleteTaskConfirm,
  updateToastDismissed,
  updateVersion,
  setUpdateToastDismissed
}: AppDialogsProps): React.JSX.Element {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const restartForUpdate = useMutation(trpc.app.meta.restartForUpdate.mutationOptions())
  return (
    <>
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
            openTaskTabs={openTaskTabs}
            activeTaskId={activeTaskId}
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
        onRestart={() => restartForUpdate.mutate()}
        onDismiss={() => setUpdateToastDismissed(true)}
      />
      <Suspense fallback={null}>
        <TerminalStatusDialog tasks={tasks} onTaskClick={openTask} />
      </Suspense>
      <Toaster position="bottom-right" theme="dark" closeButton />
    </>
  )
}
