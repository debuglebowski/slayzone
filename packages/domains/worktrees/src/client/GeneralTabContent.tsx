/**
 * Task General tab: header, status chips, commit graph (BranchesTab DAG)
 */
import { useState, useCallback } from 'react'
import { GitBranch, FolderOpen, ArrowLeft, Cloud, CloudOff } from 'lucide-react'
import { Button, toast } from '@slayzone/ui'
import type { Task, UpdateTaskInput } from '@slayzone/task/shared'
import { useConsolidatedGeneralData } from './useConsolidatedGeneralData'
import { useBranchGraph, BranchGraphToolbar, BranchGraphCard } from './BranchesTab'
import { RemoteSection } from './RemoteSection'
import { CopyFilesDialog } from './CopyFilesDialog'
import { CreatePrDialog, LinkPrDialog } from './PullRequestTab'
import {
  NoProjectFallback,
  CheckingFallback,
  NotGitRepoFallback,
  MergeBanner,
  StatusChips,
  WorktreeButton,
  WorktreeRemoveButton,
  PrStatusChip,
  PrButtons,
  RebaseMergeButtons,
  Section,
} from './general-tab-shared'

interface GeneralTabContentProps {
  task: Task
  projectPath: string | null
  visible: boolean
  pollIntervalMs?: number
  hasGithubRemote?: boolean
  onUpdateTask: (data: UpdateTaskInput) => Promise<Task>
  onTaskUpdated: (task: Task) => void
  onSwitchTab: (tab: 'changes' | 'conflicts' | 'pr') => void
}

export function GeneralTabContent({
  task, projectPath, visible, pollIntervalMs = 5000,
  hasGithubRemote, onUpdateTask, onTaskUpdated, onSwitchTab
}: GeneralTabContentProps) {
  const data = useConsolidatedGeneralData(task, projectPath, visible, pollIntervalMs, onUpdateTask)
  const branchGraph = useBranchGraph(data.targetPath, visible, data.parentBranch ?? undefined)
  const [createPrOpen, setCreatePrOpen] = useState(false)
  const [linkPrOpen, setLinkPrOpen] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)

  const handlePrCreated = useCallback(async (url: string) => {
    const updated = await onUpdateTask({ id: task.id, prUrl: url })
    onTaskUpdated?.(updated)
    setCreatePrOpen(false)
  }, [task.id, onUpdateTask, onTaskUpdated])

  const handlePrLinked = useCallback(async (url: string) => {
    setLinkError(null)
    try {
      const updated = await onUpdateTask({ id: task.id, prUrl: url })
      onTaskUpdated?.(updated)
      setLinkPrOpen(false)
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : String(err))
    }
  }, [task.id, onUpdateTask, onTaskUpdated])

  if (!projectPath) return <NoProjectFallback />
  if (data.isGitRepo === null) return <CheckingFallback />
  if (data.isGitRepo === false) return <NotGitRepoFallback onInit={data.handleInitGit} initializing={data.initializing} />

  const activeBranch = data.hasWorktree ? data.worktreeBranch : data.currentBranch

  return (
    <div className="h-full flex flex-col">
      {/* Merge banner */}
      {task.merge_state && (
        <div className="shrink-0 p-3 pb-0">
          <MergeBanner mergeState={task.merge_state} onSwitchTab={onSwitchTab} />
        </div>
      )}

      {/* Header: branch + actions */}
      <div className={`shrink-0 mx-3 mt-3 rounded-lg border ${data.hasWorktree ? 'border-blue-500/20 bg-blue-500/5' : 'border bg-muted/30'}`}>
        <div className="flex items-center gap-2 px-3 py-2">
          <GitBranch className={`h-3.5 w-3.5 shrink-0 ${data.hasWorktree ? 'text-blue-500' : 'text-muted-foreground'}`} />
          <span className="text-[10px] font-mono font-medium px-1.5 py-0.5 rounded-full bg-muted border truncate">
            {activeBranch || 'detached HEAD'}
          </span>
          {data.hasWorktree && data.parentBranch && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <ArrowLeft className="h-3 w-3" />
              <span className="font-mono">{data.parentBranch}</span>
            </span>
          )}
          {data.upstreamAB ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted border flex items-center gap-1 text-muted-foreground">
              <Cloud className="h-3 w-3" />
              tracked
            </span>
          ) : data.remoteUrl ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/10 border border-yellow-500/20 flex items-center gap-1 text-yellow-600 dark:text-yellow-400">
              <CloudOff className="h-3 w-3" />
              no upstream
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {hasGithubRemote && (
              data.pr ? (
                <PrStatusChip pr={data.pr} onClick={() => onSwitchTab('pr')} />
              ) : (
                <PrButtons onCreatePr={() => setCreatePrOpen(true)} onLinkPr={() => setLinkPrOpen(true)} />
              )
            )}
            {data.hasWorktree ? (
              <WorktreeRemoveButton data={data} />
            ) : (
              <WorktreeButton data={data} />
            )}
          </div>
        </div>
        {data.targetPath && (
          <div className={`border-t px-3 py-1.5 flex items-center gap-1.5 ${data.hasWorktree ? 'border-blue-500/10' : 'border-border/50'}`}>
            <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
            <button
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors truncate font-mono"
              onClick={() => {
                navigator.clipboard.writeText(data.targetPath!)
                toast('Path copied')
              }}
              title={data.targetPath}
            >
              {data.targetPath}
            </button>
          </div>
        )}
        {data.createError && <p className="text-xs text-destructive px-3 pb-2">{data.createError}</p>}
      </div>

      {/* Status + remote + git actions */}
      <div className="shrink-0 p-4 pb-0 space-y-4">
        <Section label="Branch">
          <div className="flex items-center gap-2 flex-wrap px-3 py-2.5 rounded-lg border bg-muted/30">
            <StatusChips data={data} onSwitchTab={onSwitchTab} />
            <div className="ml-auto flex items-center gap-1.5">
              {data.hasWorktree && data.parentBranch && <RebaseMergeButtons data={data} />}
              <Button variant="outline" size="sm" onClick={() => onSwitchTab('changes')} className="gap-1 h-7 px-2">
                View diff
              </Button>
              {data.targetPath && (
                <RemoteSection
                  remoteUrl={data.remoteUrl ?? undefined}
                  upstreamAB={data.upstreamAB}
                  targetPath={data.targetPath}
                  branch={activeBranch}
                  onSyncDone={data.fetchGitData}
                />
              )}
            </div>
          </div>
        </Section>
      </div>

      {/* Commit graph */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="shrink-0 px-4 pt-4 mb-0.5 flex items-end">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Commits & Branches</div>
          <div className="flex-1" />
          <div className="flex items-center gap-0.5">
            <BranchGraphToolbar state={branchGraph} />
          </div>
        </div>
        <div className="flex-1 min-h-0 px-3 pb-3">
          <BranchGraphCard state={branchGraph} />
        </div>
      </div>

      <CopyFilesDialog
        open={data.copyFilesDialog.open}
        onOpenChange={(open) => { if (!open) data.handleCopyFilesCancel() }}
        repoPath={data.copyFilesDialog.repoPath}
        projectId={task.project_id}
        onConfirm={data.handleCopyFilesConfirm}
      />

      {projectPath && (
        <>
          <CreatePrDialog
            open={createPrOpen}
            onOpenChange={setCreatePrOpen}
            task={task}
            projectPath={projectPath}
            onCreated={handlePrCreated}
          />
          <LinkPrDialog
            open={linkPrOpen}
            onOpenChange={setLinkPrOpen}
            projectPath={projectPath}
            onLink={handlePrLinked}
            error={linkError}
          />
        </>
      )}
    </div>
  )
}
