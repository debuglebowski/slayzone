import { forwardRef, useCallback, useMemo, useRef, useState } from 'react'
import { useTaskWorktreePaths } from '@slayzone/task/client/useTaskPath'
import { cn } from '@slayzone/ui'
import { WorkspaceTargetProvider } from '@slayzone/file-editor/client/workspace-target'
import type { Task, UpdateTaskInput, GitTabId } from '@slayzone/task-contracts'
import type { FilterState } from '@slayzone/tasks'
import type { Project, DetectedRepo } from '@slayzone/projects-contracts'
import { GitDiffPanel, type GitDiffPanelHandle } from './GitDiffPanel'
import { GeneralTabContent } from './GeneralTabContent'
import { ProjectGeneralTab } from './ProjectGeneralTab'
import { WorktreesTab, type WorktreesTabHandle } from './WorktreesTab'
import { PullRequestTab } from './PullRequestTab'
import { ProjectPrTab } from './ProjectPrTab'
import { StashTab, type StashTabHandle } from './StashTab'
import { GitPanelContext } from './git-panel-context'
import { useGitPanelTabs } from './useGitPanelTabs'
import { useGitMergeActions } from './useGitMergeActions'
import { GitPanelTabBar } from './git-panel-tabs'
import { GitPanelToolbar } from './git-panel-toolbar'
import { ConflictPhaseContent } from './ConflictPhaseContent'
import type { ConflictToolbarData, UnifiedGitPanelHandle } from './UnifiedGitPanel.types'

export type { GitTabId } from '@slayzone/task-contracts'
export type { UnifiedGitPanelHandle } from './UnifiedGitPanel.types'

type UnifiedGitPanelProps = {
  task?: Task | null
  projectId: string
  projectPath: string | null
  completedStatus?: string
  visible: boolean
  pollIntervalMs?: number
  defaultTab?: GitTabId
  onTabChange?: (tab: GitTabId) => void
  tasks?: Task[]
  filter?: FilterState
  projects?: Project[]
  onTaskClick?: (task: Task) => void
  onUpdateTask?: (data: UpdateTaskInput) => Promise<Task>
  onTaskUpdated?: (task: Task) => void
  detectedRepos?: DetectedRepo[]
  selectedRepoName?: string | null
  isRepoStale?: boolean
  onRepoChange?: (repoName: string) => void
}

/**
 * The git panel, scoped (§9 Phase 7b): every `worktrees.*` call inside it names the
 * panel's task — or, with none, its project — as the PATH SCOPE the hub authorizes
 * and the computer confines its paths to.
 */
export const UnifiedGitPanel = forwardRef<UnifiedGitPanelHandle, UnifiedGitPanelProps>(
  function UnifiedGitPanel(props, ref) {
    const taskId = props.task?.id
    return (
      <WorkspaceTargetProvider
        target={taskId ? { taskId } : { projectId: props.projectId || undefined }}
      >
        <UnifiedGitPanelInner {...props} ref={ref} />
      </WorkspaceTargetProvider>
    )
  }
)

const UnifiedGitPanelInner = forwardRef<UnifiedGitPanelHandle, UnifiedGitPanelProps>(
  function UnifiedGitPanelInner(
    {
      task,
      projectId,
      projectPath,
      completedStatus = 'done',
      visible,
      pollIntervalMs,
      defaultTab = 'general',
      onTabChange,
      onUpdateTask,
      onTaskUpdated,
      tasks = [],
      filter,
      projects = [],
      onTaskClick,
      detectedRepos = [],
      selectedRepoName,
      isRepoStale,
      onRepoChange
    },
    ref
  ) {
    const {
      activeTab,
      setActiveTab,
      isTabVisible,
      tabOrder,
      hasConflicts,
      isRebase,
      hasGithubRemote,
      taskPrNumber
    } = useGitPanelTabs(ref, { task, defaultTab, onTabChange, projectPath, visible })

    const { handleCommitAndContinueMerge, handleAbortMerge } = useGitMergeActions({
      task,
      projectPath,
      completedStatus,
      onUpdateTask,
      onTaskUpdated
    })

    // Worktree paths live on the tasks' computers (§9 Phase 7d): one batched read.
    const pathTasks = useMemo(
      () => (task && !tasks.some((t) => t.id === task.id) ? [task, ...tasks] : tasks),
      [task, tasks]
    )
    const worktreePaths = useTaskWorktreePaths(pathTasks)
    const worktreeOf = useCallback(
      (t: Task) => (t.has_worktree ? worktreePaths.get(t.id) : undefined),
      [worktreePaths]
    )

    const diffRef = useRef<GitDiffPanelHandle>(null)
    const worktreesRef = useRef<WorktreesTabHandle>(null)
    const stashRef = useRef<StashTabHandle>(null)
    const [stashShowAll, setStashShowAll] = useState(false)
    const [conflictToolbar, setConflictToolbar] = useState<ConflictToolbarData | null>(null)

    return (
      <GitPanelContext.Provider
        value={{
          tasks,
          filter,
          projects,
          activeTask: task,
          projectPath,
          onTaskClick,
          onUpdateTask,
          onTaskUpdated,
          worktreeOf
        }}
      >
        <div className="h-full flex flex-col">
          {/* Unified header: tabs left, actions right */}
          <div className="shrink-0 h-10 px-2 border-b border-border bg-surface-1 flex items-center gap-1">
            <GitPanelTabBar
              tabOrder={tabOrder}
              activeTab={activeTab}
              isTabVisible={isTabVisible}
              setActiveTab={setActiveTab}
              task={task}
              taskPrNumber={taskPrNumber}
            />

            {/* Right-aligned actions */}
            <div className="flex-1" />
            <GitPanelToolbar
              activeTab={activeTab}
              detectedRepos={detectedRepos}
              selectedRepoName={selectedRepoName}
              isRepoStale={isRepoStale}
              onRepoChange={onRepoChange}
              diffRef={diffRef}
              worktreesRef={worktreesRef}
              stashRef={stashRef}
              stashShowAll={stashShowAll}
              setStashShowAll={setStashShowAll}
              conflictToolbar={conflictToolbar}
            />
          </div>

          {/* Tab content */}
          <div className="flex-1 min-h-0 relative">
            <div className={cn('absolute inset-0', activeTab !== 'general' && 'hidden')}>
              {task ? (
                <GeneralTabContent
                  task={task}
                  projectPath={projectPath}
                  visible={visible && activeTab === 'general'}
                  pollIntervalMs={pollIntervalMs}
                  hasGithubRemote={hasGithubRemote}
                  onUpdateTask={onUpdateTask!}
                  onTaskUpdated={onTaskUpdated!}
                  onSwitchTab={setActiveTab}
                />
              ) : (
                <ProjectGeneralTab
                  projectId={projectId}
                  projectPath={projectPath}
                  visible={visible && activeTab === 'general'}
                  onSwitchToDiff={() => setActiveTab('changes')}
                />
              )}
            </div>
            <div className={cn('absolute inset-0', activeTab !== 'changes' && 'hidden')}>
              <GitDiffPanel
                ref={diffRef}
                task={task ?? null}
                projectPath={projectPath}
                visible={visible && activeTab === 'changes'}
                pollIntervalMs={pollIntervalMs}
                mergeState={task?.merge_state}
                onCommitAndContinueMerge={task ? handleCommitAndContinueMerge : undefined}
                onAbortMerge={task ? handleAbortMerge : undefined}
              />
            </div>
            <div className={cn('absolute inset-0', activeTab !== 'worktrees' && 'hidden')}>
              <WorktreesTab ref={worktreesRef} visible={visible && activeTab === 'worktrees'} />
            </div>
            <div className={cn('absolute inset-0', activeTab !== 'stash' && 'hidden')}>
              <StashTab
                ref={stashRef}
                visible={visible && activeTab === 'stash'}
                pollIntervalMs={pollIntervalMs}
                showAll={stashShowAll}
              />
            </div>
            {hasConflicts && task && (
              <div className={cn('absolute inset-0', activeTab !== 'conflicts' && 'hidden')}>
                <ConflictPhaseContent
                  task={task}
                  projectPath={projectPath!}
                  completedStatus={completedStatus}
                  isRebase={isRebase}
                  onUpdateTask={onUpdateTask!}
                  onTaskUpdated={onTaskUpdated!}
                  onToolbarChange={setConflictToolbar}
                />
              </div>
            )}
            {hasGithubRemote && (
              <div className={cn('absolute inset-0', activeTab !== 'pr' && 'hidden')}>
                {task ? (
                  <PullRequestTab
                    task={task}
                    projectPath={projectPath}
                    visible={visible && activeTab === 'pr'}
                    onUpdateTask={onUpdateTask!}
                    onTaskUpdated={onTaskUpdated!}
                  />
                ) : (
                  <ProjectPrTab
                    projectPath={projectPath}
                    visible={visible && activeTab === 'pr'}
                    tasks={tasks}
                    onTaskClick={onTaskClick}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </GitPanelContext.Provider>
    )
  }
)
