import React, {
  Suspense,
  type ComponentProps,
  type Dispatch,
  type SetStateAction,
  type RefObject,
  type KeyboardEventHandler
} from 'react'
import { Kanban, GitBranch, FileCode, Cpu, FlaskConical, Zap, Lock, AlertTriangle } from 'lucide-react'
import { useTRPCClient } from '@slayzone/transport/client'
import { Button, PanelToggle, cn } from '@slayzone/ui'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'
import type { Tag } from '@slayzone/tags/shared'
import { resolveRepoPath } from '@slayzone/projects/shared'
import {
  ProjectLockPopover,
  ProjectLockScreen,
  hasActiveLockOverride,
  clearLockOverrides
} from '@slayzone/projects'
import { ResizeHandle } from '@slayzone/task/client/ResizeHandle'
import {
  useGlobalPanelSizes,
  applyBoundaryResize,
  effectiveLayout
} from '@slayzone/task/client/usePanelSizes'
import { usePanelConfig } from '@slayzone/task/client/usePanelConfig'
import { getViewConfig } from '@slayzone/tasks/hooks'
import { useHomePanel, HOME_PANEL_SIZE_KEY } from '@/hooks/useHomePanel'
import { type AgentStatusState } from '@/components/agent-status'
import { type GlobalAgentPanelState } from '@/components/global-agent-panel'
import {
  FilterBar,
  KanbanBoard,
  KanbanListView,
  UnifiedGitPanel,
  FileEditorView,
  ProcessesPanel,
  TestPanel,
  AutomationsPanel
} from './lazy'
import type { ProjectSettingsTab } from './constants'

type KanbanProps = ComponentProps<typeof KanbanBoard>
type FilterBarProps = ComponentProps<typeof FilterBar>
type GitPanelProps = ComponentProps<typeof UnifiedGitPanel>
type PanelSizesApi = ReturnType<typeof useGlobalPanelSizes>
type PanelConfigApi = ReturnType<typeof usePanelConfig>
type HomePanelApi = ReturnType<typeof useHomePanel>

interface HomeDetailProps {
  durationLocked: boolean
  selectedProject: Project | null
  selectedProjectId: string
  projects: Project[]
  updateProject: (project: Project) => void
  updateTask: (task: Task) => void
  projectNameInputRef: RefObject<HTMLTextAreaElement | null>
  projectNameValue: string
  setProjectNameValue: Dispatch<SetStateAction<string>>
  handleProjectNameSave: () => void | Promise<void>
  handleProjectNameKeyDown: KeyboardEventHandler<HTMLTextAreaElement>
  projectPathMissing: boolean
  handleFixProjectPath: () => void
  filter: FilterBarProps['filter']
  setFilter: FilterBarProps['onChange']
  projectTags: Tag[]
  homePanel: HomePanelApi
  homePanelConfig: PanelConfigApi['config']
  isHomePanelEnabled: PanelConfigApi['isBuiltinEnabled']
  panelSizes: PanelSizesApi[0]
  updatePanelSizes: PanelSizesApi[1]
  resetPanelSize: PanelSizesApi[2]
  testsPanelEnabled: boolean
  testGroupBy: ComponentProps<typeof TestPanel>['groupBy']
  homeResolvedRepo: ReturnType<typeof resolveRepoPath>
  homeDetectedRepos: GitPanelProps['detectedRepos']
  homeSelectedProject: Project | undefined
  handleHomeRepoChange: GitPanelProps['onRepoChange']
  isViewActive: boolean
  isHomeTabActive: boolean
  tasks: Task[]
  displayTasks: KanbanProps['tasks']
  taskTags: KanbanProps['taskTags']
  blockedTaskIds: KanbanProps['blockedTaskIds']
  handleTaskMove: KanbanProps['onTaskMove']
  handleTaskBulkMove: KanbanProps['onTaskBulkMove']
  reorderTasks: KanbanProps['onTaskReorder']
  handleTaskClick: (task: Task) => void
  handleTaskTagsChange: KanbanProps['onTaskTagsChange']
  contextMenuUpdate: KanbanProps['onUpdateTask']
  bulkContextMenuUpdate: KanbanProps['onBulkUpdateTasks']
  clearBlockers: KanbanProps['onClearBlockers']
  archiveTask: KanbanProps['onArchiveTask']
  deleteTask: KanbanProps['onDeleteTask']
  bulkDelete: KanbanProps['onBulkDeleteTasks']
  archiveTasks: KanbanProps['onArchiveAllTasks']
  activeAgentTaskIds: KanbanProps['activeAgentTaskIds']
  shutdownAgentForTask: KanbanProps['onShutdownAgent']
  globalAgentPanelState: GlobalAgentPanelState
  agentStatusState: AgentStatusState
  openProjectSettings: (
    project: Project,
    options?: { initialTab?: ProjectSettingsTab }
  ) => void
  panelGitShortcut: string | null
  panelEditorShortcut: string | null
  panelProcessesShortcut: string | null
  panelTestsShortcut: string | null
  panelAutomationsShortcut: string | null
}

export function HomeDetail({
  durationLocked,
  selectedProject,
  selectedProjectId,
  projects,
  updateProject,
  updateTask,
  projectNameInputRef,
  projectNameValue,
  setProjectNameValue,
  handleProjectNameSave,
  handleProjectNameKeyDown,
  projectPathMissing,
  handleFixProjectPath,
  filter,
  setFilter,
  projectTags,
  homePanel,
  homePanelConfig,
  isHomePanelEnabled,
  panelSizes,
  updatePanelSizes,
  resetPanelSize,
  testsPanelEnabled,
  testGroupBy,
  homeResolvedRepo,
  homeDetectedRepos,
  homeSelectedProject,
  handleHomeRepoChange,
  isViewActive,
  isHomeTabActive,
  tasks,
  displayTasks,
  taskTags,
  blockedTaskIds,
  handleTaskMove,
  handleTaskBulkMove,
  reorderTasks,
  handleTaskClick,
  handleTaskTagsChange,
  contextMenuUpdate,
  bulkContextMenuUpdate,
  clearBlockers,
  archiveTask,
  deleteTask,
  bulkDelete,
  archiveTasks,
  activeAgentTaskIds,
  shutdownAgentForTask,
  globalAgentPanelState,
  agentStatusState,
  openProjectSettings,
  panelGitShortcut,
  panelEditorShortcut,
  panelProcessesShortcut,
  panelTestsShortcut,
  panelAutomationsShortcut
}: HomeDetailProps): React.JSX.Element {
  const trpcClient = useTRPCClient()
  return (
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
                  value={selectedProject ? projectNameValue : 'No project selected'}
                  readOnly={!selectedProject}
                  tabIndex={selectedProject ? undefined : -1}
                  onChange={
                    selectedProject ? (e) => setProjectNameValue(e.target.value) : undefined
                  }
                  onBlur={selectedProject ? handleProjectNameSave : undefined}
                  onKeyDown={selectedProject ? handleProjectNameKeyDown : undefined}
                  className={cn(
                    'text-2xl font-bold bg-transparent border-none outline-none resize-none p-0',
                    selectedProject ? 'cursor-text' : 'cursor-default select-none'
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
              {projects.length > 0 && !(projectPathMissing && selectedProjectId) && (
                <div className="ml-auto flex items-center gap-1">
                  {selectedProject && hasActiveLockOverride(selectedProject) && (
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
                    <ProjectLockPopover project={selectedProject} onUpdated={updateProject} />
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
                    .filter((p) => p.id === 'kanban' || isHomePanelEnabled(p.id, 'home'))
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
                <p className="text-lg font-medium">Project path not found</p>
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
                  projects.find((p) => p.id === selectedProjectId)?.path ??
                  null
                const sizeKey = HOME_PANEL_SIZE_KEY[id]
                const w = homePanel.homeResolvedWidths[sizeKey] ?? 400
                // Cluster boundary (left→right anchor): the leftover gap sits
                // just before the boundary handle (or the left edge if no
                // left cluster).
                const isClusterBoundary =
                  j === homePanel.homeLeftCount && homePanel.homeResolved.rightKeys.length > 0
                // A handle renders before every panel except the very first —
                // including the boundary (last-left ↔ first-right).
                const leftId = j > 0 ? homePanel.homeRenderOrder[j - 1] : undefined
                const leftL = leftId
                  ? effectiveLayout(HOME_PANEL_SIZE_KEY[leftId], homePanelConfig, panelSizes)
                  : undefined
                const rightL = effectiveLayout(sizeKey, homePanelConfig, panelSizes)
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
                          homePanel.homeResolvedWidths[HOME_PANEL_SIZE_KEY[leftId]] ?? 400
                        }
                        rightWidth={w}
                        leftMinWidth={
                          homePanel.homeResolved.minPx[HOME_PANEL_SIZE_KEY[leftId]] ?? 200
                        }
                        rightMinWidth={homePanel.homeResolved.minPx[sizeKey] ?? 200}
                        leftMaxWidth={homePanel.homeResolved.maxPx[HOME_PANEL_SIZE_KEY[leftId]]}
                        rightMaxWidth={homePanel.homeResolved.maxPx[sizeKey]}
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
                            Object.values(homePanel.homePanelVisibility).filter(Boolean).length <=
                              1 &&
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
                            isActive={isHomeTabActive}
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
                              trpcClient.task.update.mutate(data).then((t) => {
                                updateTask(t)
                                return t
                              })
                            }
                            detectedRepos={homeDetectedRepos}
                            selectedRepoName={homeSelectedProject?.selected_repo}
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
                          <AutomationsPanel projectId={selectedProjectId} />
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
  )
}
