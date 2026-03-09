import { useState, useEffect, useCallback, useRef } from 'react'
import { ArrowUp, ArrowDown, Loader2, GitBranch, Check, AlertTriangle, GitMerge, Copy, FolderOpen, ExternalLink, FileText } from 'lucide-react'
import { IconButton, cn, toast } from '@slayzone/ui'
import type { Task } from '@slayzone/task/shared'
import type { CommitInfo, DiffStatsSummary, WorktreeMetadata, GhPullRequest } from '../shared/types'
import { BranchGraph, type GraphNode } from './BranchGraph'

interface BranchTabProps {
  task: Task
  projectPath: string | null
  visible: boolean
  pollIntervalMs?: number
}

const STALE_THRESHOLD = 5

export function BranchTab({ task, projectPath, visible, pollIntervalMs = 5000 }: BranchTabProps) {
  const [branchCommits, setBranchCommits] = useState<CommitInfo[]>([])
  const [incomingCommits, setIncomingCommits] = useState<CommitInfo[]>([])
  const [preForkCommits, setPreForkCommits] = useState<CommitInfo[]>([])
  const [forkPoint, setForkPoint] = useState<string | null>(null)
  const [taskBranch, setTaskBranch] = useState<string | null>(null)
  const [diffStats, setDiffStats] = useState<DiffStatsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const initialLoad = useRef(false)

  // One-time state
  const [pr, setPr] = useState<GhPullRequest | null>(null)
  const [metadata, setMetadata] = useState<WorktreeMetadata | null>(null)
  const onetimeFetched = useRef(false)

  // Action state
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const parentBranch = task.worktree_parent_branch
  const targetPath = task.worktree_path || projectPath

  const fetchData = useCallback(async () => {
    if (!targetPath || !parentBranch) return
    try {
      const branch = await window.api.git.getCurrentBranch(targetPath)
      setTaskBranch(branch)
      if (!branch) return

      const mergeBase = await window.api.git.getMergeBase(
        projectPath || targetPath,
        branch,
        parentBranch
      )
      setForkPoint(mergeBase)

      if (mergeBase) {
        const repoPath = projectPath || targetPath
        const [yours, incoming, preFork, stats] = await Promise.all([
          window.api.git.getCommitsSince(targetPath, mergeBase, branch),
          window.api.git.getCommitsSince(repoPath, mergeBase, parentBranch),
          window.api.git.getCommitsBeforeRef(repoPath, mergeBase, 3),
          window.api.git.getDiffStats(targetPath, parentBranch)
        ])
        setBranchCommits(yours)
        setIncomingCommits(incoming)
        setPreForkCommits(preFork)
        setDiffStats(stats)
      } else {
        setBranchCommits([])
        setIncomingCommits([])
        setPreForkCommits([])
        setDiffStats(null)
      }
    } catch { /* polling error */ }
  }, [targetPath, projectPath, parentBranch])

  // One-time fetch for PR + metadata (after initial data load)
  useEffect(() => {
    if (!initialLoad.current || onetimeFetched.current || !taskBranch) return
    onetimeFetched.current = true

    const repoPath = projectPath || targetPath
    if (!repoPath) return

    Promise.all([
      window.api.git.listOpenPrs(repoPath)
        .then(prs => prs.find(p => p.headRefName === taskBranch) ?? null)
        .catch(() => null),
      task.worktree_path
        ? window.api.git.getWorktreeMetadata(task.worktree_path).catch(() => null)
        : Promise.resolve(null)
    ]).then(([foundPr, meta]) => {
      setPr(foundPr)
      setMetadata(meta)
    })
  }, [taskBranch, projectPath, targetPath, task.worktree_path])

  // Reset on task/path change
  useEffect(() => {
    initialLoad.current = false
    onetimeFetched.current = false
  }, [targetPath])

  useEffect(() => {
    if (!visible || !targetPath || !parentBranch) return
    if (!initialLoad.current) {
      setLoading(true)
      fetchData().finally(() => { setLoading(false); initialLoad.current = true })
    } else {
      fetchData()
    }
    const timer = setInterval(fetchData, pollIntervalMs)
    return () => clearInterval(timer)
  }, [visible, targetPath, parentBranch, fetchData, pollIntervalMs])

  // Quick actions
  const handleAction = useCallback(async (action: string) => {
    if (!targetPath || !parentBranch || !taskBranch) return
    setActionLoading(action)
    try {
      if (action === 'rebase') {
        const result = await window.api.git.rebaseOnto(targetPath, parentBranch)
        if (result.success) {
          toast('Rebase complete')
          fetchData()
        } else if (result.conflicted) {
          toast(result.error ?? 'Rebase has conflicts')
        } else {
          toast(result.error ?? 'Rebase failed')
        }
      } else if (action === 'merge') {
        const result = await window.api.git.mergeFrom(targetPath, parentBranch)
        if (result.success) {
          toast(`Merged ${parentBranch}`)
          fetchData()
        } else if (result.conflicted) {
          toast(result.error ?? 'Merge has conflicts')
        } else {
          toast(result.error ?? 'Merge failed')
        }
      } else if (action === 'push') {
        const result = await window.api.git.push(targetPath, taskBranch)
        toast(result.success ? 'Pushed' : (result.error ?? 'Push failed'))
      } else if (action === 'pull') {
        const result = await window.api.git.pull(targetPath)
        if (result.success) {
          toast('Pulled')
          fetchData()
        } else {
          toast(result.error ?? 'Pull failed')
        }
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setActionLoading(null)
    }
  }, [targetPath, parentBranch, taskBranch, fetchData])

  const handleConfirmedAction = useCallback((action: string, label: string) => {
    toast(`${label}?`, {
      action: { label: 'Confirm', onClick: () => handleAction(action) }
    })
  }, [handleAction])

  if (!parentBranch) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <p className="text-xs text-muted-foreground">No parent branch set for this worktree</p>
      </div>
    )
  }

  if (loading) {
    return <div className="h-full flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }

  // Build graph
  const graphNodes: GraphNode[] = []

  for (let i = 0; i < branchCommits.length; i++) {
    graphNodes.push({
      commit: branchCommits[i],
      column: 0,
      type: i === 0 ? 'branch-tip' : 'commit',
      branchName: taskBranch ?? undefined,
      branchLabel: i === 0 ? (taskBranch ?? 'HEAD') : undefined
    })
  }

  for (let i = 0; i < incomingCommits.length; i++) {
    graphNodes.push({
      commit: incomingCommits[i],
      column: 1,
      type: i === 0 ? 'branch-tip' : 'commit',
      branchName: parentBranch,
      branchLabel: i === 0 ? parentBranch : undefined
    })
  }

  if (forkPoint) {
    graphNodes.push({
      commit: {
        hash: forkPoint,
        shortHash: forkPoint.slice(0, 7),
        message: 'fork point',
        author: '',
        relativeDate: ''
      },
      column: 0,
      type: 'fork-point'
    })
  }

  for (const c of preForkCommits) {
    graphNodes.push({ commit: c, column: 0, type: 'commit' })
  }

  const hasColumns = incomingCommits.length > 0 ? 2 : 1

  return (
    <div className="h-full flex flex-col">
      {/* Header: branch names + ahead/behind + diff stats */}
      <div className="shrink-0 p-3 pb-0">
        <div className="px-3 py-2.5 rounded-lg border bg-muted/30">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <GitBranch className="h-4 w-4 text-primary shrink-0" />
              <span className="text-sm font-medium truncate">{taskBranch ?? '...'}</span>
              <span className="text-xs text-muted-foreground shrink-0">vs</span>
              <span className="text-xs text-muted-foreground truncate">{parentBranch}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0 text-xs">
              {branchCommits.length > 0 && (
                <span className="flex items-center gap-0.5 text-green-500">
                  <ArrowUp className="h-3 w-3" />{branchCommits.length}
                </span>
              )}
              {incomingCommits.length > 0 && (
                <span className="flex items-center gap-0.5 text-yellow-500">
                  <ArrowDown className="h-3 w-3" />{incomingCommits.length}
                </span>
              )}
              {branchCommits.length === 0 && incomingCommits.length === 0 && (
                <span className="text-green-500 flex items-center gap-1">
                  <Check className="h-3 w-3" /> Up to date
                </span>
              )}
            </div>
          </div>
          {diffStats && diffStats.filesChanged > 0 && (
            <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted-foreground">
              <FileText className="h-3 w-3" />
              {diffStats.filesChanged} file{diffStats.filesChanged !== 1 ? 's' : ''} changed
              {diffStats.insertions > 0 && <span className="text-green-500">+{diffStats.insertions}</span>}
              {diffStats.deletions > 0 && <span className="text-red-500">-{diffStats.deletions}</span>}
            </div>
          )}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {/* Actions + stale nudge */}
        <div className="space-y-1.5">
          {incomingCommits.length >= STALE_THRESHOLD && (
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-yellow-500/30 bg-yellow-500/10 text-[11px] text-yellow-600 dark:text-yellow-400">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span>{incomingCommits.length} behind {parentBranch}</span>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            <button
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs hover:bg-accent transition-colors disabled:opacity-50"
              onClick={() => handleConfirmedAction('rebase', `Rebase onto ${parentBranch}`)}
              disabled={actionLoading !== null}
            >
              {actionLoading === 'rebase' ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitMerge className="h-3 w-3" />}
              Rebase
            </button>
            <button
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs hover:bg-accent transition-colors disabled:opacity-50"
              onClick={() => handleConfirmedAction('merge', `Merge ${parentBranch} in`)}
              disabled={actionLoading !== null}
            >
              {actionLoading === 'merge' ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitMerge className="h-3 w-3 rotate-180" />}
              Merge
            </button>
            <button
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs hover:bg-accent transition-colors disabled:opacity-50"
              onClick={() => handleAction('push')}
              disabled={actionLoading !== null}
            >
              {actionLoading === 'push' ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUp className="h-3 w-3" />}
              Push
            </button>
            <button
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs hover:bg-accent transition-colors disabled:opacity-50"
              onClick={() => handleAction('pull')}
              disabled={actionLoading !== null}
            >
              {actionLoading === 'pull' ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowDown className="h-3 w-3" />}
              Pull
            </button>
          </div>
        </div>

        {/* Graph */}
        {graphNodes.length > 0 ? (
          <div className="rounded-lg border bg-muted/30 p-2">
            <BranchGraph nodes={graphNodes} maxColumns={hasColumns} />
          </div>
        ) : (
          <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">
            No divergence — branches are identical
          </div>
        )}

        {/* PR status */}
        {pr && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-muted/30 text-xs">
            <span className="font-medium">#{pr.number}</span>
            <span className="truncate flex-1">{pr.title}</span>
            {pr.isDraft && (
              <span className="px-1.5 py-0.5 rounded bg-muted text-[10px]">Draft</span>
            )}
            <span className={cn(
              'px-1.5 py-0.5 rounded text-[10px] font-medium',
              pr.statusCheckRollup === 'SUCCESS' && 'bg-green-500/20 text-green-600 dark:text-green-400',
              pr.statusCheckRollup === 'FAILURE' && 'bg-red-500/20 text-red-600 dark:text-red-400',
              pr.statusCheckRollup === 'PENDING' && 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400',
              !pr.statusCheckRollup && 'bg-muted'
            )}>
              {pr.statusCheckRollup === 'SUCCESS' ? 'CI passed' :
               pr.statusCheckRollup === 'FAILURE' ? 'CI failed' :
               pr.statusCheckRollup === 'PENDING' ? 'CI pending' : 'No CI'}
            </span>
            <span className={cn(
              'px-1.5 py-0.5 rounded text-[10px] font-medium',
              pr.reviewDecision === 'APPROVED' && 'bg-green-500/20 text-green-600 dark:text-green-400',
              pr.reviewDecision === 'CHANGES_REQUESTED' && 'bg-red-500/20 text-red-600 dark:text-red-400',
              pr.reviewDecision === 'REVIEW_REQUIRED' && 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400',
              !pr.reviewDecision && 'bg-muted'
            )}>
              {pr.reviewDecision === 'APPROVED' ? 'Approved' :
               pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes requested' :
               pr.reviewDecision === 'REVIEW_REQUIRED' ? 'Review needed' : 'No reviews'}
            </span>
            <IconButton
              aria-label="Open PR"
              variant="ghost"
              className="h-5 w-5"
              onClick={() => window.api.shell.openExternal(pr.url)}
            >
              <ExternalLink className="h-3 w-3" />
            </IconButton>
          </div>
        )}

        {/* Worktree metadata */}
        {metadata && (
          <div className="rounded-lg border bg-muted/30 px-3 py-2 space-y-1">
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Worktree</div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground truncate flex-1 font-mono text-[10px]">{metadata.path}</span>
              <IconButton
                aria-label="Copy path"
                variant="ghost"
                className="h-5 w-5"
                onClick={() => { navigator.clipboard.writeText(metadata.path); toast('Copied path') }}
              >
                <Copy className="h-3 w-3" />
              </IconButton>
              <IconButton
                aria-label="Reveal in Finder"
                variant="ghost"
                className="h-5 w-5"
                onClick={() => window.api.git.revealInFinder(metadata.path)}
              >
                <FolderOpen className="h-3 w-3" />
              </IconButton>
            </div>
            <div className="flex gap-4 text-[10px] text-muted-foreground">
              <span>Disk: {metadata.diskSize}</span>
              {metadata.createdAt && <span>First commit: {new Date(metadata.createdAt).toLocaleDateString()}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
