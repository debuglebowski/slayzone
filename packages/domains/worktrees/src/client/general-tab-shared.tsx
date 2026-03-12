import { useState } from 'react'
import { GitBranch, GitMerge, GitPullRequest, FolderTree, Link2, Loader2, AlertTriangle, ChevronDown, Trash2 } from 'lucide-react'
import {
  Button, Tooltip, TooltipContent, TooltipTrigger,
  Popover, PopoverContent, PopoverTrigger,
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@slayzone/ui'
import type { ConsolidatedGeneralData } from './useConsolidatedGeneralData'
import type { GhPullRequest } from '../shared/types'

// --- Not a git repo / no project fallbacks ---

export function NoProjectFallback() {
  return <div className="p-4 text-xs text-muted-foreground">Set a project path to use Git features</div>
}

export function CheckingFallback() {
  return <div className="p-4 text-xs text-muted-foreground">Checking...</div>
}

export function NotGitRepoFallback({ onInit, initializing }: { onInit: () => void; initializing: boolean }) {
  return (
    <div className="p-4 space-y-2">
      <p className="text-xs text-muted-foreground">Not a git repository</p>
      <Button variant="outline" size="sm" onClick={onInit} disabled={initializing} className="gap-2">
        {initializing ? 'Initializing...' : 'Initialize Git'}
      </Button>
    </div>
  )
}

// --- Merge/rebase banner ---

export function MergeBanner({ mergeState, onSwitchTab }: { mergeState: string; onSwitchTab: (tab: 'changes' | 'conflicts') => void }) {
  return (
    <button
      onClick={() => onSwitchTab(mergeState === 'uncommitted' ? 'changes' : 'conflicts')}
      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 hover:bg-purple-500/15 transition-colors text-left"
    >
      <AlertTriangle className="h-4 w-4 text-purple-400 shrink-0" />
      <span className="text-xs font-medium text-purple-300">
        {mergeState === 'uncommitted' ? 'Merge — reviewing changes'
          : mergeState === 'rebase-conflicts' ? 'Rebase — resolving conflicts'
          : 'Merge — resolving conflicts'}
      </span>
    </button>
  )
}

// --- Status chips ---

export function StatusChips({ data, onSwitchTab }: { data: ConsolidatedGeneralData; onSwitchTab: (tab: 'changes' | 'conflicts' | 'branches') => void }) {
  const { statusSummary, totalChanges } = data
  if (!statusSummary || totalChanges === 0) {
    return <span className="text-xs text-muted-foreground">No changes</span>
  }
  return (
    <>
      {statusSummary.staged > 0 && (
        <button onClick={() => onSwitchTab('changes')} className="px-2 py-0.5 rounded text-xs font-medium text-green-400 bg-green-500/10 hover:opacity-80 transition-opacity">
          {statusSummary.staged} staged
        </button>
      )}
      {statusSummary.unstaged > 0 && (
        <button onClick={() => onSwitchTab('changes')} className="px-2 py-0.5 rounded text-xs font-medium text-yellow-400 bg-yellow-500/10 hover:opacity-80 transition-opacity">
          {statusSummary.unstaged} modified
        </button>
      )}
      {statusSummary.untracked > 0 && (
        <button onClick={() => onSwitchTab('changes')} className="px-2 py-0.5 rounded text-xs font-medium text-muted-foreground bg-muted hover:opacity-80 transition-opacity">
          {statusSummary.untracked} untracked
        </button>
      )}
    </>
  )
}

// --- Worktree button (create new + link existing dropdown) ---

export function WorktreeButton({ data }: { data: ConsolidatedGeneralData }) {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div className="flex">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={data.handleAddWorktree} disabled={data.creating} className="gap-2 rounded-r-none border-r-0">
            <FolderTree className="h-3.5 w-3.5 shrink-0" />
            {data.creating ? 'Creating...' : 'Branch to worktree'}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Create branch "{data.sluggedBranch}"</TooltipContent>
      </Tooltip>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" disabled={data.creating} className="px-1.5 rounded-l-none">
            <ChevronDown className="h-3 w-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 p-1">
          {data.detectedWorktrees.length > 0 ? (
            <>
              <div className="px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase">Link existing worktree</div>
              {data.detectedWorktrees.map(wt => (
                <button
                  key={wt.path}
                  onClick={() => { setMenuOpen(false); data.handleLinkWorktree(wt.path, wt.branch) }}
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs hover:bg-muted rounded transition-colors text-left"
                >
                  <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{wt.branch ?? wt.path}</span>
                </button>
              ))}
            </>
          ) : (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No other worktrees found</div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}

// --- Worktree remove button ---

export function WorktreeRemoveButton({ data }: { data: ConsolidatedGeneralData }) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmOpen(true)}
            disabled={data.removing}
            className="gap-1.5 text-destructive hover:text-destructive"
          >
            {data.removing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            Delete worktree
          </Button>
        </TooltipTrigger>
        <TooltipContent>Delete worktree directory from disk. Branch is kept, but uncommitted changes will be lost.</TooltipContent>
      </Tooltip>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete worktree</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>This will permanently delete the worktree directory from disk and unlink it from this task.</p>
                <p className="font-mono text-[11px] bg-muted px-2 py-1 rounded break-all">{data.metadata?.path ?? data.targetPath}</p>
                <ul className="text-xs space-y-1 list-disc pl-4">
                  <li>The branch <span className="font-mono font-medium">{data.worktreeBranch ?? data.taskBranch}</span> will be kept in the repository</li>
                  <li className="text-destructive font-medium">Any uncommitted changes in the worktree will be permanently lost</li>
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => data.handleRemoveWorktree()}>Delete worktree</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// --- PR status chip (shown when PR is linked) ---

export function PrStatusChip({ pr, onClick }: { pr: GhPullRequest; onClick: () => void }) {
  const stateLabel = pr.state === 'MERGED' ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : pr.isDraft ? 'Draft' : 'Open'
  const stateClass = pr.state === 'MERGED' ? 'bg-purple-500/20 text-purple-600 dark:text-purple-400'
    : pr.state === 'CLOSED' ? 'bg-red-500/20 text-red-600 dark:text-red-400'
    : pr.isDraft ? 'bg-muted text-muted-foreground'
    : 'bg-green-500/20 text-green-600 dark:text-green-400'

  return (
    <Button variant="outline" size="sm" onClick={onClick} className="gap-4">
      View PR
      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${stateClass}`}>
        #{pr.number} · {stateLabel}
      </span>
    </Button>
  )
}

// --- PR buttons ---

export function PrButtons({ onCreatePr, onLinkPr }: { onCreatePr: () => void; onLinkPr: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div className="flex">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={onCreatePr} className="gap-2 rounded-r-none border-r-0">
            <GitPullRequest className="h-3.5 w-3.5 shrink-0" /> Create PR
          </Button>
        </TooltipTrigger>
        <TooltipContent>Create a pull request via GitHub CLI (gh)</TooltipContent>
      </Tooltip>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="px-1.5 rounded-l-none">
            <ChevronDown className="h-3 w-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-44 p-1">
          <button
            onClick={() => { setMenuOpen(false); onLinkPr() }}
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs hover:bg-muted rounded transition-colors text-left"
          >
            <Link2 className="h-3 w-3 shrink-0 text-muted-foreground" />
            Link existing PR
          </button>
        </PopoverContent>
      </Popover>
    </div>
  )
}

// --- Stale nudge ---

export function StaleNudge({ data }: { data: ConsolidatedGeneralData }) {
  if (data.baseCount < 5) return null
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-yellow-500/30 bg-yellow-500/10 text-[11px] text-yellow-600 dark:text-yellow-400">
      <AlertTriangle className="h-3 w-3 shrink-0" />
      <span>{data.baseCount} behind {data.parentBranch}</span>
    </div>
  )
}

// --- Rebase/Merge buttons (shown inline in status section for worktree tasks) ---

export function RebaseMergeButtons({ data }: { data: ConsolidatedGeneralData }) {
  const { actionLoading, handleConfirmedAction, parentBranch, baseCount } = data
  const hasBehind = baseCount > 0

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 h-7 px-2"
            onClick={() => handleConfirmedAction('rebase', `Rebase onto ${parentBranch}`)}
            disabled={actionLoading !== null || !hasBehind}
          >
            {actionLoading === 'rebase' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5" />}
            Rebase
          </Button>
        </TooltipTrigger>
        <TooltipContent>{hasBehind ? `Rebase onto ${parentBranch}` : `Already up to date with ${parentBranch}`}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 h-7 px-2"
            onClick={() => handleConfirmedAction('merge', `Merge ${parentBranch} in`)}
            disabled={actionLoading !== null || !hasBehind}
          >
            {actionLoading === 'merge' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5 rotate-180" />}
            Merge
          </Button>
        </TooltipTrigger>
        <TooltipContent>{hasBehind ? `Merge ${parentBranch} into branch` : `Already up to date with ${parentBranch}`}</TooltipContent>
      </Tooltip>
    </>
  )
}


// --- Section helper ---

export function Section({ label, right, children }: { label: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</div>
        {right && <div className="flex-1 min-w-0 flex justify-end">{right}</div>}
      </div>
      {children}
    </div>
  )
}
