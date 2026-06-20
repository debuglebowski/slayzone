import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref
} from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import { useUndo } from '@slayzone/ui'
import type { Task } from '@slayzone/task/shared'
import { resolveRepoPath, type Project } from '@slayzone/projects/shared'
import { useProjectRepos } from '@slayzone/worktrees/hooks'
import {
  useTasksData,
  useFilterState,
  useUndoableTaskActions,
  applyFilters,
  getViewConfig
} from '@slayzone/tasks/client'
import { useGlobalPanelSizes } from '@slayzone/task/client/usePanelSizes'
import { usePanelConfig } from '@slayzone/task/client/usePanelConfig'
import { useHomePanel } from './useHomePanel'
import { HomeDetail, type HomeDetailProps } from './HomeDetail'

type ProjectSettingsTab = string

/**
 * Imperative handle exposed by HomeContainer so a parent (the fork's HomeView)
 * can open a file in the Home file-editor panel — used to wire the command
 * palette's file-open into the Home editor, mirroring the canonical app's
 * `homePanel.homeEditorRef` access. HomeContainer owns `homePanel` internally,
 * so this is the seam that surfaces its `openFile` upward.
 */
export interface HomeContainerHandle {
  openFile: (filePath: string) => void
}

export interface HomeContainerProps {
  /** Project whose board + panels are shown. Empty string = no project. */
  selectedProjectId: string
  /** Home tab is the active/visible view (drives git-panel visibility etc.). */
  isActive: boolean
  // --- App-chrome (optional; the Electron app supplies these, the fork omits) ---
  durationLocked?: boolean
  testsPanelEnabled?: boolean
  testGroupBy?: HomeDetailProps['testGroupBy']
  agentPanelState?: { isOpen: boolean }
  agentStatusState?: { isLocked: boolean }
  /** Open a task (Electron: task tab). Omitted in the fork until TaskDetails lands. */
  onTaskClick?: (task: Task) => void
  onOpenProjectSettings?: (project: Project, options?: { initialTab?: ProjectSettingsTab }) => void
  panelGitShortcut?: string | null
  panelEditorShortcut?: string | null
  panelProcessesShortcut?: string | null
  panelTestsShortcut?: string | null
  panelAutomationsShortcut?: string | null
  /** Project path validation (Electron supplies via useProjectPathGuard). */
  projectPathMissing?: boolean
  onFixProjectPath?: () => void
  /**
   * Lifted board data. When provided (the Chromium fork passes ONE shared
   * `useTasksData()` to both the sidebar and Home), this container skips its
   * own `useTasksData()` call so the two consumers share a single instance.
   * Omitted in the Electron app → self-wiring path.
   */
  data?: ReturnType<typeof useTasksData>
  /**
   * When provided, HomeContainer surfaces an imperative `openFile` handle for
   * the Home file-editor panel (see HomeContainerHandle). The fork's HomeView
   * uses it to build the command palette's file-open context.
   */
  editorHandleRef?: Ref<HomeContainerHandle>
}

type HomeContainerImplProps = HomeContainerProps & { data: ReturnType<typeof useTasksData> }

/**
 * Self-wiring Home shell shared by the Electron app and the Chromium fork.
 * Owns the data/filter/panel/repo hooks so consumers pass ~10 props instead of
 * HomeDetail's 60. Renders the presentational HomeDetail. Single source of truth
 * for the Home experience across both renderers.
 */
export function HomeContainer({ data, ...rest }: HomeContainerProps): React.JSX.Element {
  return data ? (
    <HomeContainerImpl data={data} {...rest} />
  ) : (
    <HomeContainerSelfWiring {...rest} />
  )
}

/** Electron-app path: owns its own board data. */
function HomeContainerSelfWiring(props: HomeContainerProps): React.JSX.Element {
  const data = useTasksData()
  return <HomeContainerImpl data={data} {...props} />
}

function HomeContainerImpl({
  data,
  selectedProjectId,
  isActive,
  durationLocked = false,
  testsPanelEnabled = true,
  testGroupBy = 'none',
  agentPanelState = { isOpen: false },
  agentStatusState = { isLocked: false },
  onTaskClick,
  onOpenProjectSettings,
  panelGitShortcut = null,
  panelEditorShortcut = null,
  panelProcessesShortcut = null,
  panelTestsShortcut = null,
  panelAutomationsShortcut = null,
  projectPathMissing = false,
  onFixProjectPath,
  editorHandleRef
}: HomeContainerImplProps): React.JSX.Element {
  const trpcClient = useTRPCClient()
  const {
    tasks,
    projects,
    tags,
    taskTags,
    blockedTaskIds,
    setTasks,
    setTaskTags,
    updateTask,
    updateProject,
    moveTask,
    bulkMove,
    reorderTasks,
    clearBlockers,
    archiveTask: rawArchiveTask,
    archiveTasks: rawArchiveTasks,
    deleteTask: rawDeleteTask,
    bulkDelete: rawBulkDelete,
    contextMenuUpdate: rawContextMenuUpdate,
    bulkContextMenuUpdate: rawBulkContextMenuUpdate
  } = data

  const { push: pushUndo, undo } = useUndo()
  const { contextMenuUpdate, archiveTask, archiveTasks, deleteTask, bulkContextMenuUpdate, bulkDelete } =
    useUndoableTaskActions(
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

  const [filter, setFilter] = useFilterState(selectedProjectId)
  const { config: homePanelConfig, isBuiltinEnabled, getOrderedHomeIds } = usePanelConfig()
  const orderedHomeIds = useMemo(() => getOrderedHomeIds(), [getOrderedHomeIds])
  const [panelSizes, updatePanelSizes, resetPanelSize] = useGlobalPanelSizes()
  const homePanel = useHomePanel(selectedProjectId, panelSizes, homePanelConfig, orderedHomeIds)

  // Surface an `openFile` handle to the parent (fork command palette). Mirrors
  // the canonical app's `buildHomeFileContext`: reveal the editor panel, then
  // open via the editor ref (queuing through pendingHomeEditorFileRef if the
  // editor hasn't mounted yet).
  const openHomeFile = useCallback(
    (filePath: string) => {
      if (homePanel.homeEditorRef.current) {
        if (!homePanel.homePanelVisibility.editor) {
          homePanel.setHomePanelVisibility((prev) => ({ ...prev, editor: true }))
        }
        homePanel.homeEditorRef.current.openFile(filePath)
      } else {
        homePanel.pendingHomeEditorFileRef.current = filePath
        homePanel.setHomePanelVisibility((prev) => ({ ...prev, editor: true }))
      }
    },
    [homePanel]
  )
  useImperativeHandle(editorHandleRef, () => ({ openFile: openHomeFile }), [openHomeFile])

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  )

  // Multi-repo detection for the git panel — same source as the task git panel.
  const { repos: homeViewableRepos } = useProjectRepos(selectedProject?.path ?? null, null)
  const homeDetectedRepos = useMemo(
    () => homeViewableRepos.map((r) => ({ name: r.name, path: r.path, kind: r.kind })),
    [homeViewableRepos]
  )
  const homeResolvedRepo = useMemo(
    () =>
      resolveRepoPath(
        selectedProject?.path ?? null,
        homeDetectedRepos,
        selectedProject?.selected_repo ?? null
      ),
    [selectedProject?.path, homeDetectedRepos, selectedProject?.selected_repo]
  )
  const handleHomeRepoChange = useCallback(
    (repoName: string) => {
      if (!selectedProject) return
      void trpcClient.projects.update
        .mutate({ id: selectedProject.id, selectedRepo: repoName })
        .then((updated) => updateProject(updated as Project))
    },
    [selectedProject, trpcClient, updateProject]
  )

  // Filtered board data for the selected project.
  const projectTasks = useMemo(
    () => (selectedProjectId ? tasks.filter((t) => t.project_id === selectedProjectId) : []),
    [tasks, selectedProjectId]
  )
  const projectTags = useMemo(
    () => (selectedProjectId ? tags.filter((t) => t.project_id === selectedProjectId) : tags),
    [tags, selectedProjectId]
  )
  const displayTasks = useMemo(
    () => applyFilters(projectTasks, filter, taskTags, selectedProject?.columns_config),
    [projectTasks, filter, taskTags, selectedProject?.columns_config]
  )

  // Task move/bulk-move: thread the active group-by from the view config.
  const handleTaskMove = useCallback(
    (taskId: string, newColumnId: string, targetIndex: number) =>
      moveTask(taskId, newColumnId, targetIndex, getViewConfig(filter).groupBy),
    [moveTask, filter]
  )
  const handleTaskBulkMove = useCallback(
    (taskIds: string[], newColumnId: string, targetIndex: number) =>
      bulkMove(taskIds, newColumnId, targetIndex, getViewConfig(filter).groupBy),
    [bulkMove, filter]
  )
  const handleTaskTagsChange = useCallback(
    async (taskId: string, tagIds: string[]) => {
      await trpcClient.tags.setForTask.mutate({ taskId, tagIds })
      setTaskTags((prev) => {
        const next = new Map(prev)
        next.set(taskId, tagIds)
        return next
      })
    },
    [trpcClient, setTaskTags]
  )
  const handleTaskClick = useCallback((task: Task) => onTaskClick?.(task), [onTaskClick])

  // Inline project-name editing (rename via projects.update).
  const projectNameInputRef = useRef<HTMLTextAreaElement>(null)
  const [projectNameValue, setProjectNameValue] = useState(selectedProject?.name ?? '')
  useEffect(() => {
    setProjectNameValue(selectedProject?.name ?? '')
  }, [selectedProject?.id, selectedProject?.name])
  const handleProjectNameSave = useCallback(async () => {
    const name = projectNameValue.trim()
    if (!selectedProject || !name || name === selectedProject.name) return
    updateProject({ ...selectedProject, name })
    await trpcClient.projects.update.mutate({ id: selectedProject.id, name })
  }, [selectedProject, projectNameValue, updateProject, trpcClient])
  const handleProjectNameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        projectNameInputRef.current?.blur()
      } else if (e.key === 'Escape') {
        setProjectNameValue(selectedProject?.name ?? '')
        projectNameInputRef.current?.blur()
      }
    },
    [selectedProject?.name]
  )

  const noopOpenProjectSettings = useCallback(() => {}, [])

  return (
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
      handleFixProjectPath={onFixProjectPath ?? noopOpenProjectSettings}
      filter={filter}
      setFilter={setFilter}
      projectTags={projectTags}
      homePanel={homePanel}
      homePanelConfig={homePanelConfig}
      isHomePanelEnabled={isBuiltinEnabled}
      panelSizes={panelSizes}
      updatePanelSizes={updatePanelSizes}
      resetPanelSize={resetPanelSize}
      testsPanelEnabled={testsPanelEnabled}
      testGroupBy={testGroupBy}
      homeResolvedRepo={homeResolvedRepo}
      homeDetectedRepos={homeDetectedRepos}
      homeSelectedProject={selectedProject ?? undefined}
      handleHomeRepoChange={handleHomeRepoChange}
      isViewActive={isActive}
      isHomeTabActive={isActive}
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
      activeAgentTaskIds={undefined}
      shutdownAgentForTask={undefined}
      globalAgentPanelState={agentPanelState}
      agentStatusState={agentStatusState}
      openProjectSettings={onOpenProjectSettings ?? noopOpenProjectSettings}
      panelGitShortcut={panelGitShortcut}
      panelEditorShortcut={panelEditorShortcut}
      panelProcessesShortcut={panelProcessesShortcut}
      panelTestsShortcut={panelTestsShortcut}
      panelAutomationsShortcut={panelAutomationsShortcut}
    />
  )
}
