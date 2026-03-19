import { useState, useEffect } from 'react'
import { GitBranch, GitMerge, GitPullRequest, FolderTree, Link2, Loader2, AlertTriangle, ChevronDown, Trash2 } from 'lucide-react'
import {
  Button, Tooltip, TooltipContent, TooltipTrigger,
  Popover, PopoverContent, PopoverTrigger,
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  Input
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

export function StatusChips({ data, onSwitchTab }: { data: ConsolidatedGeneralData; onSwitchTab: (tab: 'changes' | 'conflicts') => void }) {
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
  const [linkDialog, setLinkDialog] = useState(false)
  const [branchDialog, setBranchDialog] = useState(false)

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
          <button
            onClick={() => { setMenuOpen(false); setLinkDialog(true) }}
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs hover:bg-muted rounded transition-colors text-left"
          >
            <Link2 className="h-3 w-3 shrink-0 text-muted-foreground" />
            Link existing worktree
          </button>
          <button
            onClick={() => { setMenuOpen(false); setBranchDialog(true) }}
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs hover:bg-muted rounded transition-colors text-left"
          >
            <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
            Use existing branch
          </button>
        </PopoverContent>
      </Popover>

      <LinkWorktreeDialog
        open={linkDialog}
        onOpenChange={setLinkDialog}
        worktrees={data.detectedWorktrees}
        onSelect={(wt) => data.handleLinkWorktree(wt.path, wt.branch)}
      />
      <BranchPickerDialog
        open={branchDialog}
        onOpenChange={setBranchDialog}
        projectPath={data.targetPath}
        onSelect={(branch) => data.handleAddWorktreeFromBranch(branch)}
      />
    </div>
  )
}

function LinkWorktreeDialog({ open, onOpenChange, worktrees, onSelect }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  worktrees: ConsolidatedGeneralData['detectedWorktrees']
  onSelect: (wt: ConsolidatedGeneralData['detectedWorktrees'][number]) => void
}) {
  const [search, setSearch] = useState('')
  const filtered = worktrees.filter(wt =>
    (wt.branch ?? wt.path).toLowerCase().includes(search.toLowerCase())
  )

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setSearch('') }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Link existing worktree</DialogTitle>
        </DialogHeader>
        {worktrees.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No other worktrees found</p>
        ) : (
          <>
            <Input
              placeholder="Search worktrees..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 text-xs"
              autoFocus
            />
            <div className="max-h-[250px] overflow-y-auto space-y-0.5">
              {filtered.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">No matching worktrees</p>
              ) : filtered.map(wt => (
                <button
                  key={wt.path}
                  onClick={() => { onOpenChange(false); setSearch(''); onSelect(wt) }}
                  className="flex items-center gap-2 w-full px-2 py-2 text-xs hover:bg-muted rounded transition-colors text-left"
                >
                  <FolderTree className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="font-medium truncate">{wt.branch ?? 'detached HEAD'}</div>
                    <div className="text-[10px] text-muted-foreground font-mono truncate">{wt.path}</div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function BranchPickerDialog({ open, onOpenChange, projectPath, onSelect }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectPath: string | null
  onSelect: (branch: string) => void
}) {
  const [branches, setBranches] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !projectPath) return
    setLoading(true)
    window.api.git.listBranches(projectPath)
      .then(setBranches)
      .catch(() => setBranches([]))
      .finally(() => setLoading(false))
  }, [open, projectPath])

  const filtered = branches.filter(b =>
    b.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setSearch('') }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Use existing branch</DialogTitle>
        </DialogHeader>
        <Input
          placeholder="Search branches..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 text-xs"
          autoFocus
        />
        <div className="max-h-[250px] overflow-y-auto space-y-0.5">
          {loading ? (
            <div className="py-4 text-center text-xs text-muted-foreground">Loading branches...</div>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">No branches found</p>
          ) : filtered.map(b => (
            <button
              key={b}
              onClick={() => { onOpenChange(false); setSearch(''); onSelect(b) }}
              className="flex items-center gap-2 w-full px-2 py-2 text-xs hover:bg-muted rounded transition-colors text-left"
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{b}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
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
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete worktree</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4 pt-1">
                <p>This will permanently delete the worktree directory from disk and unlink it from this task.</p>
                <p className="font-mono text-[11px] bg-muted px-3 py-2 rounded break-all">{data.metadata?.path ?? data.targetPath}</p>
                <p className="text-xs text-destructive font-medium">Any uncommitted changes in the worktree will be permanently lost.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex justify-between sm:justify-between mt-4">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <div className="flex gap-2">
              <AlertDialogAction
                className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
                onClick={() => data.handleRemoveWorktree()}
              >
                Delete worktree
              </AlertDialogAction>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                disabled={!(data.worktreeBranch ?? data.taskBranch)}
                onClick={() => data.handleRemoveWorktree(data.worktreeBranch ?? data.taskBranch ?? undefined)}
              >
                Delete worktree & branch
              </AlertDialogAction>
            </div>
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

// --- Sync dropdown (rebase or merge parent into branch) ---

export function RebaseMergeButtons({ data }: { data: ConsolidatedGeneralData }) {
  const { actionLoading, handleConfirmedAction, parentBranch, baseCount } = data
  const hasBehind = baseCount > 0
  const busy = actionLoading !== null

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-1 h-7 px-2"
                disabled={busy || !hasBehind}
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Sync
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{hasBehind ? `${baseCount} commit${baseCount === 1 ? '' : 's'} behind ${parentBranch}` : `Already up to date with ${parentBranch}`}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => handleConfirmedAction('rebase', `Rebase onto ${parentBranch}`)}>
          <GitMerge className="h-3.5 w-3.5" />
          Rebase onto parent
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleConfirmedAction('merge', `Merge ${parentBranch} in`)}>
          <GitMerge className="h-3.5 w-3.5 rotate-180" />
          Merge parent into branch
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// --- Merge to parent split button + confirmation dialog ---

export function MergeToParentButton({ data }: { data: ConsolidatedGeneralData }) {
  const { actionLoading, handleMergeToParent, confirmMergeToParent, cancelMergeToParent, mergeToParentDialog, parentBranch, featureCount, totalChanges } = data
  const [menuOpen, setMenuOpen] = useState(false)
  const canMerge = featureCount > 0 && totalChanges === 0
  const busy = actionLoading !== null
  const disabled = busy || !canMerge
  const disabledReason = featureCount === 0 ? `No commits ahead of ${parentBranch}` : 'Uncommitted changes — commit or stash first'

  return (
    <>
      <div className="flex">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleMergeToParent(true)}
                disabled={disabled}
                className="gap-1.5 rounded-r-none border-r-0"
              >
                {actionLoading === 'mergeToParent' ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitMerge className="h-3 w-3" />}
                Merge to {parentBranch}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{canMerge ? `Merge and delete worktree` : disabledReason}</TooltipContent>
        </Tooltip>
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" disabled={disabled} className="px-1.5 rounded-l-none">
              <ChevronDown className="h-3 w-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-fit p-1">
            <button
              onClick={() => { setMenuOpen(false); handleMergeToParent(false) }}
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs hover:bg-muted rounded transition-colors text-left"
            >
              <GitMerge className="h-3 w-3 shrink-0 text-muted-foreground" />
              Merge without deleting worktree
            </button>
          </PopoverContent>
        </Popover>
      </div>
      <AlertDialog open={mergeToParentDialog.open} onOpenChange={(open) => !open && cancelMergeToParent()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge branch into {parentBranch}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>This will check out <span className="font-mono font-medium">{parentBranch}</span> in the main repository and merge the worktree branch into it.</p>
                {mergeToParentDialog.deleteWorktree && (
                  <p>The worktree directory will be deleted after merging.</p>
                )}
                {mergeToParentDialog.hasMainChanges && (
                  <p className="text-destructive font-medium">The main repository has uncommitted changes that may be affected by this checkout.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmMergeToParent}>
              {mergeToParentDialog.deleteWorktree ? 'Merge & delete' : 'Merge'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
