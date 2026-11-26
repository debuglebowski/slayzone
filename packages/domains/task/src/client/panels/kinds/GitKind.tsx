import { getTaskPanels } from '../registry'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import type { PanelKindProps } from './types'

/** The git panel (`diff`); the panel itself is injected by the app. */
export function GitKind({ panelId }: PanelKindProps): React.JSX.Element {
  const { task, handleTaskUpdate, updateTaskAndNotify, panels, git } = useTaskPageContext()
  const {
    gitPanelRef,
    resolvedGitViewPath,
    completedStatus,
    gitDefaultTab,
    handleGitTabChange,
    viewableRepos,
    handleRepoChange
  } = git
  const { UnifiedGitPanel } = getTaskPanels()
  return (
    <PanelFrame
      kind="git"
      panelId={panelId}
      testId="task-git-panel"
      className="overflow-hidden flex flex-col"
    >
      <UnifiedGitPanel
        ref={gitPanelRef}
        task={task}
        projectId={task.project_id}
        projectPath={resolvedGitViewPath}
        completedStatus={completedStatus}
        visible={panels.panelVisibility.diff}
        defaultTab={gitDefaultTab}
        onTabChange={handleGitTabChange}
        pollIntervalMs={5000}
        onUpdateTask={updateTaskAndNotify}
        onTaskUpdated={handleTaskUpdate}
        detectedRepos={viewableRepos.map((r) => ({
          name: r.name,
          path: r.path,
          kind: r.kind
        }))}
        selectedRepoName={viewableRepos.find((r) => r.path === resolvedGitViewPath)?.name ?? null}
        isRepoStale={false}
        onRepoChange={handleRepoChange}
      />
    </PanelFrame>
  )
}
