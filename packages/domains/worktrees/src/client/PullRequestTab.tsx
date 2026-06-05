import { GitPullRequest, Link2, Plus, Unlink, AlertTriangle } from 'lucide-react'
import { Button, PulseGrid } from '@slayzone/ui'
import type { Task, UpdateTaskInput } from '@slayzone/task/shared'
import { LinkedPrView } from './LinkedPrView'
import { CreatePrDialog, LinkPrDialog } from './pr-dialogs'
import { usePullRequestTab } from './usePullRequestTab'

export { CreatePrDialog, LinkPrDialog } from './pr-dialogs'

interface PullRequestTabProps {
  task: Task
  projectPath: string | null
  visible: boolean
  onUpdateTask: (data: UpdateTaskInput) => Promise<Task>
  onTaskUpdated: (task: Task) => void
}

export function PullRequestTab({
  task,
  projectPath,
  visible,
  onUpdateTask,
  onTaskUpdated
}: PullRequestTabProps) {
  const {
    ghInstalled,
    pr,
    loading,
    createOpen,
    setCreateOpen,
    linkOpen,
    setLinkOpen,
    error,
    refreshPr,
    handleUnlink,
    handleLinkPr,
    handleCreated
  } = usePullRequestTab({ task, projectPath, visible, onUpdateTask, onTaskUpdated })

  if (!projectPath) {
    return <EmptyMessage>Set a project path to use PR features</EmptyMessage>
  }

  if (loading) {
    return <PulseGrid />
  }

  if (ghInstalled === false) {
    return (
      <div className="p-6 space-y-3">
        <div className="flex items-center gap-2 text-yellow-500">
          <AlertTriangle className="h-4 w-4" />
          <span className="text-sm font-medium">GitHub CLI not found</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Install the GitHub CLI to create and manage pull requests:
        </p>
        <code className="block text-xs bg-muted px-3 py-2 rounded-md">
          brew install gh && gh auth login
        </code>
      </div>
    )
  }

  // PR is linked — show status
  if (task.pr_url && pr) {
    const onRefreshPrVoid = async (): Promise<void> => {
      await refreshPr()
    }
    return (
      <LinkedPrView
        pr={pr}
        projectPath={projectPath!}
        visible={visible}
        onUnlink={handleUnlink}
        onRefreshPr={onRefreshPrVoid}
      />
    )
  }
  if (task.pr_url && !pr) {
    return (
      <div className="p-6 space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <GitPullRequest className="h-4 w-4 text-muted-foreground" />
          <a
            className="text-primary hover:underline truncate"
            href="#"
            onClick={(e) => {
              e.preventDefault()
              window.api.shell.openExternal(task.pr_url!)
            }}
          >
            {task.pr_url}
          </a>
        </div>
        <Button variant="outline" size="sm" onClick={handleUnlink} className="gap-2">
          <Unlink className="h-3.5 w-3.5" /> Unlink
        </Button>
      </div>
    )
  }

  // No PR linked
  return (
    <div className="h-full flex items-center justify-center">
      <div className="space-y-3 text-center">
        <GitPullRequest className="h-8 w-8 text-muted-foreground mx-auto" />
        <p className="text-sm text-muted-foreground">No pull request linked</p>
        <div className="flex gap-2 justify-center">
          <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)} className="gap-2">
            <Plus className="h-3.5 w-3.5" /> Create PR
          </Button>
          <Button variant="outline" size="sm" onClick={() => setLinkOpen(true)} className="gap-2">
            <Link2 className="h-3.5 w-3.5" /> Link Existing
          </Button>
        </div>
      </div>
      <CreatePrDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        task={task}
        projectPath={projectPath}
        onCreated={handleCreated}
      />
      <LinkPrDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        projectPath={projectPath}
        onLink={handleLinkPr}
        error={error}
      />
    </div>
  )
}

function EmptyMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center">
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  )
}
