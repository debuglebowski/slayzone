import { useState, useEffect, useCallback, useRef } from 'react'
import { GitBranch, GitMerge, Plus, Trash2, ChevronDown, Check, Loader2, ArrowUp, ArrowDown, GitCommitHorizontal, AlertTriangle, Copy, Link, Settings2 } from 'lucide-react'
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
  toast
} from '@slayzone/ui'
import type { Task, UpdateTaskInput } from '@slayzone/task/shared'
import type { MergeResult, CommitInfo, AheadBehind, StatusSummary, WorktreeCopyEntry } from '../shared/types'
import { copyEntriesKey, legacyCopyEntriesKey, parseCopyEntries } from '../shared/copy-entry-schema'
import {
  DEFAULT_WORKTREE_BASE_PATH_TEMPLATE,
  joinWorktreePath,
  resolveWorktreeBasePathTemplate,
  slugify
} from './utils'

interface GeneralTabContentProps {
  task: Task
  projectPath: string | null
  /** When set, new worktrees are created from this branch; when empty, use current branch. */
  worktreeSourceBranch?: string | null
  visible: boolean
  pollIntervalMs?: number
  onUpdateTask: (data: UpdateTaskInput) => Promise<Task>
  onTaskUpdated: (task: Task) => void
  onSwitchTab: (tab: 'changes' | 'conflicts') => void
}

export function GeneralTabContent({
  task,
  projectPath,
  worktreeSourceBranch,
  visible,
  pollIntervalMs = 5000,
  onUpdateTask,
  onTaskUpdated,
  onSwitchTab
}: GeneralTabContentProps) {
  const targetPath = task.worktree_path ?? projectPath
  const hasWorktree = !!task.worktree_path

  // Git status
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null)
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [worktreeBranch, setWorktreeBranch] = useState<string | null>(null)
  const [statusSummary, setStatusSummary] = useState<StatusSummary | null>(null)
  const [aheadBehind, setAheadBehind] = useState<AheadBehind | null>(null)
  const [recentCommits, setRecentCommits] = useState<CommitInfo[]>([])
  const [copiedHash, setCopiedHash] = useState<string | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [initializing, setInitializing] = useState(false)

  // Branch popover
  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [switching, setSwitching] = useState(false)
  const [branchError, setBranchError] = useState<string | null>(null)

  // Copy files config (per-project)
  const [copyFiles, setCopyFiles] = useState<WorktreeCopyEntry[]>([])
  const [copyFilesExpanded, setCopyFilesExpanded] = useState(false)
  const [newCopyPath, setNewCopyPath] = useState('')
  const [newCopyMode, setNewCopyMode] = useState<'copy' | 'symlink'>('copy')

  useEffect(() => {
    if (!projectPath) return
    const projectId = task.project_id
    ;(async () => {
      try {
        // Try new project-id key first (stable)
        let raw = await window.api.settings.get(copyEntriesKey(projectId))
        if (!raw) {
          // Fallback: legacy path-based key — migrate forward if found
          const legacyRaw = await window.api.settings.get(legacyCopyEntriesKey(projectPath))
          if (legacyRaw) {
            window.api.settings.set(copyEntriesKey(projectId), legacyRaw)
            raw = legacyRaw
          } else {
            // Global fallback
            raw = await window.api.settings.get('worktree_copy_files')
          }
        }
        const { entries, skipped } = parseCopyEntries(raw)
        if (skipped.length > 0) {
          toast(`${skipped.length} copy ${skipped.length === 1 ? 'entry' : 'entries'} skipped (invalid)`)
        }
        setCopyFiles(entries)
      } catch { setCopyFiles([]) }
    })()
  }, [projectPath, task.project_id])

  const saveCopyFiles = (entries: WorktreeCopyEntry[]) => {
    if (!projectPath) return
    setCopyFiles(entries)
    window.api.settings.set(copyEntriesKey(task.project_id), JSON.stringify(entries))
  }

  // Worktree
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false)
  const [merging, setMerging] = useState(false)
  const [mergeResult, setMergeResult] = useState<MergeResult | null>(null)

  // Poll for git data
  const fetchGitData = useCallback(async () => {
    if (!projectPath) return
    try {
      const isRepo = await window.api.git.isGitRepo(projectPath)
      setIsGitRepo(isRepo)
      if (!isRepo) return

      const branch = await window.api.git.getCurrentBranch(projectPath)
      setCurrentBranch(branch)

      if (targetPath) {
        const [status, commits] = await Promise.all([
          window.api.git.getStatusSummary(targetPath),
          window.api.git.getRecentCommits(targetPath, 20)
        ])
        setStatusSummary(status)
        setRecentCommits(commits)

        // Ahead/behind only for worktrees with parent branch
        if (hasWorktree && task.worktree_parent_branch && worktreeBranch) {
          const ab = await window.api.git.getAheadBehind(
            projectPath,
            worktreeBranch,
            task.worktree_parent_branch
          )
          setAheadBehind(ab)
        } else {
          setAheadBehind(null)
        }
      }
    } catch { /* polling error */ }
  }, [projectPath, targetPath, hasWorktree, task.worktree_parent_branch, worktreeBranch])

  useEffect(() => {
    if (!visible || !projectPath) return
    fetchGitData()
    const timer = setInterval(fetchGitData, pollIntervalMs)
    return () => clearInterval(timer)
  }, [visible, projectPath, pollIntervalMs, fetchGitData])

  // Fetch worktree branch
  useEffect(() => {
    if (!task.worktree_path) { setWorktreeBranch(null); return }
    window.api.git.getCurrentBranch(task.worktree_path).then(setWorktreeBranch).catch(() => setWorktreeBranch(null))
  }, [task.worktree_path])

  // Branch popover handlers
  const handleBranchPopoverChange = (open: boolean) => {
    setBranchPopoverOpen(open)
    if (open && projectPath) {
      setLoadingBranches(true)
      setBranchError(null)
      window.api.git.listBranches(projectPath).then(setBranches).catch(() => setBranches([])).finally(() => setLoadingBranches(false))
    }
    if (!open) { setNewBranchName(''); setBranchError(null) }
  }

  const handleCheckoutBranch = async (branch: string) => {
    if (!projectPath || branch === currentBranch) return
    setSwitching(true)
    setBranchError(null)
    try {
      const hasChanges = await window.api.git.hasUncommittedChanges(projectPath)
      if (hasChanges) { setBranchError('Uncommitted changes — commit or stash first'); return }
      await window.api.git.checkoutBranch(projectPath, branch)
      setCurrentBranch(branch)
      setBranchPopoverOpen(false)
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : String(err))
    } finally {
      setSwitching(false)
    }
  }

  const handleCreateBranch = async () => {
    if (!projectPath || !newBranchName.trim()) return
    setSwitching(true)
    setBranchError(null)
    try {
      await window.api.git.createBranch(projectPath, newBranchName.trim())
      setCurrentBranch(newBranchName.trim())
      setNewBranchName('')
      setBranchPopoverOpen(false)
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : String(err))
    } finally {
      setSwitching(false)
    }
  }

  const handleInitGit = async () => {
    if (!projectPath) return
    setInitializing(true)
    try {
      await window.api.git.init(projectPath)
      setIsGitRepo(true)
      const branch = await window.api.git.getCurrentBranch(projectPath)
      setCurrentBranch(branch)
    } catch { /* ignore */ }
    finally { setInitializing(false) }
  }

  // Worktree handlers
  const handleAddWorktree = async () => {
    if (!projectPath) return
    setCreating(true)
    setError(null)
    try {
      const projectId = task.project_id
      const [basePathTemplate, projectCopyRaw, legacyCopyRaw, globalCopyRaw] = await Promise.all([
        window.api.settings.get('worktree_base_path'),
        window.api.settings.get(copyEntriesKey(projectId)),
        window.api.settings.get(legacyCopyEntriesKey(projectPath)),
        window.api.settings.get('worktree_copy_files')
      ])
      // Migrate legacy key forward if new key is empty
      let raw = projectCopyRaw
      if (!raw && legacyCopyRaw) {
        window.api.settings.set(copyEntriesKey(projectId), legacyCopyRaw)
        raw = legacyCopyRaw
      }
      if (!raw) raw = globalCopyRaw

      const basePath = resolveWorktreeBasePathTemplate(basePathTemplate || DEFAULT_WORKTREE_BASE_PATH_TEMPLATE, projectPath)
      const branch = slugify(task.title) || `task-${task.id.slice(0, 8)}`
      const worktreePath = joinWorktreePath(basePath, branch)
      const { entries: copyEntries, skipped } = parseCopyEntries(raw)
      if (skipped.length > 0) {
        toast(`${skipped.length} copy ${skipped.length === 1 ? 'entry' : 'entries'} skipped (invalid)`)
      }
      const sourceBranch = worktreeSourceBranch?.trim() || currentBranch
      await window.api.git.createWorktree(projectPath, worktreePath, branch, copyEntries.length > 0 ? copyEntries : undefined, sourceBranch || undefined)
      await onUpdateTask({ id: task.id, worktreePath, worktreeParentBranch: sourceBranch || currentBranch })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  const handleDeleteWorktree = async () => {
    if (!task.worktree_path || !projectPath) return
    setDeleting(true)
    try {
      await window.api.git.removeWorktree(projectPath, task.worktree_path)
      await onUpdateTask({ id: task.id, worktreePath: null })
    } catch { /* ignore */ }
    finally { setDeleting(false) }
  }

  const handleCopyHash = useCallback((hash: string) => {
    navigator.clipboard.writeText(hash)
    setCopiedHash(hash)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopiedHash(null), 1500)
    toast('Commit hash copied to clipboard')
  }, [])

  const handleMergeConfirm = async () => {
    if (!task.worktree_path || !task.worktree_parent_branch || !projectPath) return
    setMergeConfirmOpen(false)
    setMerging(true)
    setMergeResult(null)
    try {
      const sourceBranch = await window.api.git.getCurrentBranch(task.worktree_path)
      if (!sourceBranch) {
        setMergeResult({ success: false, merged: false, conflicted: false, error: 'Cannot merge: detached HEAD' })
        return
      }
      const hasChanges = await window.api.git.hasUncommittedChanges(task.worktree_path)
      if (hasChanges) {
        const ctx = { type: 'merge' as const, sourceBranch, targetBranch: task.worktree_parent_branch }
        const updated = await onUpdateTask({ id: task.id, mergeState: 'uncommitted', mergeContext: ctx })
        onTaskUpdated(updated)
        return
      }
      const result = await window.api.git.mergeWithAI(projectPath, task.worktree_path, task.worktree_parent_branch, sourceBranch)
      if (result.success) {
        const updated = await onUpdateTask({ id: task.id, status: 'done' })
        onTaskUpdated(updated)
        await window.api.pty.kill(task.id)
        setMergeResult({ success: true, merged: true, conflicted: false })
      } else if (result.resolving) {
        const ctx = await window.api.git.getMergeContext(projectPath)
        const updated = await onUpdateTask({
          id: task.id,
          mergeState: 'conflicts',
          mergeContext: ctx ?? { type: 'merge', sourceBranch, targetBranch: task.worktree_parent_branch }
        })
        onTaskUpdated(updated)
      } else if (result.error) {
        setMergeResult({ success: false, merged: false, conflicted: false, error: result.error })
      }
    } catch (err) {
      setMergeResult({ success: false, merged: false, conflicted: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setMerging(false)
    }
  }

  // Early returns
  if (!projectPath) {
    return <div className="p-4 text-xs text-muted-foreground">Set a project path to use Git features</div>
  }

  if (isGitRepo === null) {
    return <div className="p-4 text-xs text-muted-foreground">Checking...</div>
  }

  if (isGitRepo === false) {
    return (
      <div className="p-4 space-y-2">
        <p className="text-xs text-muted-foreground">Not a git repository</p>
        <Button variant="outline" size="sm" onClick={handleInitGit} disabled={initializing} className="gap-2">
          {initializing ? 'Initializing...' : 'Initialize Git'}
        </Button>
      </div>
    )
  }

  const worktreeName = task.worktree_path?.split('/').pop() || 'Worktree'
  const totalChanges = statusSummary ? statusSummary.staged + statusSummary.unstaged + statusSummary.untracked : 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 space-y-6">
        {/* Merge/rebase banner */}
        {task.merge_state && (
          <button
            onClick={() => onSwitchTab(task.merge_state === 'uncommitted' ? 'changes' : 'conflicts')}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 hover:bg-purple-500/15 transition-colors text-left"
          >
            <AlertTriangle className="h-4 w-4 text-purple-400 shrink-0" />
            <span className="text-xs font-medium text-purple-300">
              {task.merge_state === 'uncommitted' ? 'Merge — reviewing changes'
                : task.merge_state === 'rebase-conflicts' ? 'Rebase — resolving conflicts'
                : 'Merge — resolving conflicts'}
            </span>
          </button>
        )}

        {/* Branch */}
        <Section label="Branch">
          {hasWorktree ? (
            <div className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg border bg-muted/30">
              <GitBranch className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="truncate">{worktreeBranch || currentBranch || 'detached HEAD'}</span>
            </div>
          ) : (
            <Popover open={branchPopoverOpen} onOpenChange={handleBranchPopoverChange}>
              <PopoverTrigger asChild>
                <button data-testid="branch-trigger" className="flex items-center gap-2 text-sm hover:bg-muted/50 rounded-lg px-3 py-2 transition-colors w-full text-left border bg-muted/30">
                  <GitBranch className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="truncate flex-1">{currentBranch || 'detached HEAD'}</span>
                  <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64 p-0">
                <form onSubmit={(e) => { e.preventDefault(); handleCreateBranch() }} className="flex gap-1 p-2 border-b">
                  <Input
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    placeholder="New branch..."
                    className="h-7 text-xs"
                    disabled={switching}
                  />
                  <Button type="submit" variant="ghost" size="icon" className="h-7 w-7 shrink-0" disabled={!newBranchName.trim() || switching} aria-label="Create branch">
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </form>
                {branchError && <div className="px-2 py-1.5 text-xs text-destructive border-b">{branchError}</div>}
                <div className="max-h-48 overflow-y-auto py-1">
                  {loadingBranches ? (
                    <div className="flex items-center justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
                  ) : branches.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-2 py-2">No branches</p>
                  ) : branches.map((branch) => (
                    <button
                      key={branch}
                      onClick={() => handleCheckoutBranch(branch)}
                      disabled={switching}
                      className="flex items-center gap-2 w-full px-2 py-1.5 text-xs hover:bg-muted transition-colors text-left"
                    >
                      {branch === currentBranch ? <Check className="h-3 w-3 text-primary shrink-0" /> : <span className="w-3 shrink-0" />}
                      <span className="truncate">{branch}</span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </Section>

        {/* Worktree */}
        <Section label="Worktree">
          {hasWorktree ? (
            <div className="p-3 rounded-lg border bg-muted/30 space-y-3">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{worktreeName}</div>
                  {task.worktree_parent_branch && (
                    <div className="text-xs text-muted-foreground">from {task.worktree_parent_branch}</div>
                  )}
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={handleDeleteWorktree}
                      disabled={deleting}
                      className="shrink-0 h-8 w-8 text-muted-foreground hover:text-destructive"
                      aria-label="Remove worktree"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Remove worktree</TooltipContent>
                </Tooltip>
              </div>

              {/* Ahead/behind */}
              {aheadBehind && (aheadBehind.ahead > 0 || aheadBehind.behind > 0) && (
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  {aheadBehind.ahead > 0 && (
                    <span className="flex items-center gap-1">
                      <ArrowUp className="h-3 w-3" /> {aheadBehind.ahead} ahead
                    </span>
                  )}
                  {aheadBehind.behind > 0 && (
                    <span className="flex items-center gap-1">
                      <ArrowDown className="h-3 w-3" /> {aheadBehind.behind} behind
                    </span>
                  )}
                </div>
              )}

              {/* Merge button */}
              {task.worktree_parent_branch && !task.merge_state && (
                <>
                  {mergeResult?.success ? (
                    <p className="text-xs text-green-500">Merged successfully</p>
                  ) : (
                    <>
                      {mergeResult?.error && <p className="text-xs text-destructive">{mergeResult.error}</p>}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { setMergeResult(null); setMergeConfirmOpen(true) }}
                        disabled={merging}
                        className="gap-2 w-full justify-start"
                      >
                        <GitMerge className="h-4 w-4" />
                        {merging ? 'Merging...' : `Merge into ${task.worktree_parent_branch}`}
                      </Button>
                    </>
                  )}
                </>
              )}
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" onClick={handleAddWorktree} disabled={creating} className="gap-2 w-full justify-start">
                  <Plus className="h-4 w-4" />
                  {creating ? 'Creating...' : 'Add Worktree'}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Create branch "{slugify(task.title) || `task-${task.id.slice(0, 8)}`}"
              </TooltipContent>
            </Tooltip>
          )}
          {error && <p className="text-xs text-destructive mt-1">{error}</p>}
        </Section>

        {/* Copy files to worktrees */}
        {!hasWorktree && (
          <Section label={
            <button
              className="flex items-center gap-1.5 uppercase tracking-wide text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setCopyFilesExpanded(v => !v)}
            >
              <Settings2 className="h-3 w-3" />
              Copy files
              <ChevronDown className={cn('h-3 w-3 transition-transform', copyFilesExpanded && 'rotate-180')} />
              {copyFiles.length > 0 && (
                <span className="ml-1 text-[10px] bg-muted px-1.5 py-0.5 rounded-full">{copyFiles.length}</span>
              )}
            </button>
          }>
            {copyFilesExpanded && (
              <div className="space-y-2 mt-1">
                <p className="text-xs text-muted-foreground">
                  Files and directories to copy or symlink from this repo into each new worktree. Paths are relative to the repo root.
                </p>
                <div className="space-y-1">
                  {copyFiles.map((entry, i) => (
                    <div key={i} className="flex items-center gap-2 rounded border bg-muted/30 px-2.5 py-1.5">
                      {entry.mode === 'symlink'
                        ? <Link className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        : <Copy className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                      <span className="flex-1 font-mono text-xs truncate">{entry.path}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0">{entry.mode}</span>
                      <button
                        className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                        onClick={() => saveCopyFiles(copyFiles.filter((_, j) => j !== i))}
                        aria-label="Remove copy file entry"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <form
                  className="flex gap-1.5 items-center"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const trimmed = newCopyPath.trim()
                    if (!trimmed) return
                    saveCopyFiles([...copyFiles, { path: trimmed, mode: newCopyMode }])
                    setNewCopyPath('')
                  }}
                >
                  <Input
                    className="flex-1 h-7 text-xs font-mono"
                    placeholder=".env"
                    value={newCopyPath}
                    onChange={(e) => setNewCopyPath(e.target.value)}
                  />
                  <Select value={newCopyMode} onValueChange={(v) => setNewCopyMode(v as 'copy' | 'symlink')}>
                    <SelectTrigger className="h-7 w-24 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="copy">Copy</SelectItem>
                      <SelectItem value="symlink">Symlink</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button type="submit" size="icon" variant="outline" className="h-7 w-7 shrink-0" disabled={!newCopyPath.trim()} aria-label="Add copy path">
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </form>
              </div>
            )}
          </Section>
        )}

        {/* Status summary */}
        {statusSummary && totalChanges > 0 && (
          <Section label="Current Changes">
            <div className="flex items-center gap-2 flex-wrap px-3 py-2.5 rounded-lg border bg-muted/30">
              {statusSummary.staged > 0 && (
                <StatusChip
                  label={`${statusSummary.staged} staged`}
                  className="text-green-400 bg-green-500/10"
                  onClick={() => onSwitchTab('changes')}
                />
              )}
              {statusSummary.unstaged > 0 && (
                <StatusChip
                  label={`${statusSummary.unstaged} modified`}
                  className="text-yellow-400 bg-yellow-500/10"
                  onClick={() => onSwitchTab('changes')}
                />
              )}
              {statusSummary.untracked > 0 && (
                <StatusChip
                  label={`${statusSummary.untracked} untracked`}
                  className="text-muted-foreground bg-muted"
                  onClick={() => onSwitchTab('changes')}
                />
              )}
            </div>
          </Section>
        )}

        {/* Recent commits */}
        {recentCommits.length > 0 && (
          <Section label="Recent Commits">
            <div className="space-y-0.5 px-3 py-2.5 rounded-lg border bg-muted/30">
              {recentCommits.map((commit) => (
                <div
                  key={commit.hash}
                  className="flex items-start gap-2 py-1 px-1.5 -mx-1.5 rounded cursor-pointer hover:bg-accent/50 group"
                  onClick={() => handleCopyHash(commit.shortHash)}
                  title="Click to copy hash"
                >
                  <GitCommitHorizontal className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate">{commit.message}</div>
                    <div className="text-[10px] text-muted-foreground">
                      <span className="font-mono">{commit.shortHash}</span> · {commit.relativeDate}
                    </div>
                  </div>
                  {copiedHash === commit.shortHash ? (
                    <Check className="h-3 w-3 text-green-500 shrink-0 mt-0.5" />
                  ) : (
                    <Copy className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                  )}
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>

      {/* Merge confirmation dialog */}
      <AlertDialog open={mergeConfirmOpen} onOpenChange={setMergeConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge Worktree</AlertDialogTitle>
            <AlertDialogDescription>
              This will merge {worktreeBranch || 'the worktree branch'} into {task.worktree_parent_branch}.
              If there are conflicts, you'll review and resolve them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleMergeConfirm}>Start Merge</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function Section({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{label}</div>
      {children}
    </div>
  )
}

function StatusChip({ label, className, onClick }: { label: string; className: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn('px-2 py-0.5 rounded text-xs font-medium transition-opacity hover:opacity-80', className)}
    >
      {label}
    </button>
  )
}
