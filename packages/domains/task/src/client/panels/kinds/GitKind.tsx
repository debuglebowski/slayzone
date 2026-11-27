import type { GitTabId } from '@slayzone/task-contracts'
import { PRIMARY_INSTANCE_IDS } from '@slayzone/task-contracts'
import { getTaskPanels } from '../registry'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import type { PanelKindProps } from './types'

/**
 * A git panel (`diff`, or another git instance); the panel itself is injected by the
 * app. The primary's tab is the task's `git_active_tab` and its repo pick the page's;
 * another instance keeps both in `panel_instance_state` — two git panels show
 * independent views (e.g. General beside Changes, or two repos).
 */
export function GitKind({ panelId }: PanelKindProps): React.JSX.Element {
  const { task, handleTaskUpdate, updateTaskAndNotify, panels, git } = useTaskPageContext()
  const {
    gitHandles,
    gitViewPathFor,
    resolvedGitViewPath,
    completedStatus,
    gitDefaultTab,
    handleGitTabChange,
    viewableRepos,
    handleRepoChange
  } = git
  const { UnifiedGitPanel } = getTaskPanels()
  const primary = panelId === PRIMARY_INSTANCE_IDS.git
  const own = panels.instanceState.get(panelId)
  const viewPath = primary
    ? resolvedGitViewPath
    : gitViewPathFor(typeof own.repoPath === 'string' ? own.repoPath : null)
  return (
    <PanelFrame
      kind="git"
      panelId={panelId}
      testId={primary ? 'task-git-panel' : undefined}
      className="overflow-hidden flex flex-col"
    >
      <UnifiedGitPanel
        ref={gitHandles.ref(panelId)}
        task={task}
        projectId={task.project_id}
        projectPath={viewPath}
        completedStatus={completedStatus}
        visible={panels.isInstanceShown(panelId)}
        defaultTab={primary ? gitDefaultTab : ((own.gitTab as GitTabId | undefined) ?? 'general')}
        onTabChange={
          primary
            ? handleGitTabChange
            : (tab) => panels.instanceState.patch(panelId, { gitTab: tab })
        }
        pollIntervalMs={5000}
        onUpdateTask={updateTaskAndNotify}
        onTaskUpdated={handleTaskUpdate}
        detectedRepos={viewableRepos.map((r) => ({
          name: r.name,
          path: r.path,
          kind: r.kind
        }))}
        selectedRepoName={viewableRepos.find((r) => r.path === viewPath)?.name ?? null}
        isRepoStale={false}
        onRepoChange={
          primary
            ? handleRepoChange
            : (repoName) => {
                const match = viewableRepos.find((r) => r.name === repoName)
                if (match) panels.instanceState.patch(panelId, { repoPath: match.path })
              }
        }
      />
    </PanelFrame>
  )
}
