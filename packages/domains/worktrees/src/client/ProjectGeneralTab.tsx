import { useState, useEffect, useCallback, useRef } from 'react'
import { GitBranch, ChevronDown, Check, Loader2, Plus, GitCommitHorizontal, Copy, FolderGit2 } from 'lucide-react'
import { Button, Input, Popover, PopoverContent, PopoverTrigger, cn, toast } from '@slayzone/ui'
import type { CommitInfo, StatusSummary } from '../shared/types'

interface ProjectGeneralTabProps {
  projectPath: string | null
  visible: boolean
  onSwitchToDiff: () => void
}

export function ProjectGeneralTab({ projectPath, visible, onSwitchToDiff }: ProjectGeneralTabProps) {
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null)
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [statusSummary, setStatusSummary] = useState<StatusSummary | null>(null)
  const [recentCommits, setRecentCommits] = useState<CommitInfo[]>([])
  const [copiedHash, setCopiedHash] = useState<string | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const [initializing, setInitializing] = useState(false)

  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [switching, setSwitching] = useState(false)
  const [branchError, setBranchError] = useState<string | null>(null)

  const fetchGitData = useCallback(async () => {
    if (!projectPath) return
    try {
      const isRepo = await window.api.git.isGitRepo(projectPath)
      setIsGitRepo(isRepo)
      if (!isRepo) return
      const [branch, status, commits] = await Promise.all([
        window.api.git.getCurrentBranch(projectPath),
        window.api.git.getStatusSummary(projectPath),
        window.api.git.getRecentCommits(projectPath, 20)
      ])
      setCurrentBranch(branch)
      setStatusSummary(status)
      setRecentCommits(commits)
    } catch { /* polling error */ }
  }, [projectPath])

  useEffect(() => {
    if (!visible || !projectPath) return
    fetchGitData()
    const timer = setInterval(fetchGitData, 5000)
    return () => clearInterval(timer)
  }, [visible, projectPath, fetchGitData])

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

  const handleCopyHash = useCallback((hash: string) => {
    navigator.clipboard.writeText(hash)
    setCopiedHash(hash)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopiedHash(null), 1500)
    toast('Commit hash copied to clipboard')
  }, [])

  if (!projectPath) {
    return <div className="p-4 text-xs text-muted-foreground">Set a project path to use Git features</div>
  }

  if (isGitRepo === null) {
    return <div className="p-4 text-xs text-muted-foreground">Checking...</div>
  }

  if (isGitRepo === false) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="rounded-full bg-muted p-4">
          <FolderGit2 className="size-8 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">Not a git repository</p>
        <Button variant="default" size="sm" onClick={handleInitGit} disabled={initializing} className="gap-2">
          {initializing ? <><Loader2 className="size-3.5 animate-spin" />Initializing...</> : 'Initialize Git'}
        </Button>
      </div>
    )
  }

  const totalChanges = statusSummary ? statusSummary.staged + statusSummary.unstaged + statusSummary.untracked : 0

  return (
    <div className="p-4 space-y-6">
      <Section label="Branch">
        <Popover open={branchPopoverOpen} onOpenChange={handleBranchPopoverChange}>
          <PopoverTrigger asChild>
            <button className="flex items-center gap-2 text-sm hover:bg-muted/50 rounded-lg px-3 py-2 transition-colors w-full text-left border bg-muted/30">
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
      </Section>

      {statusSummary && totalChanges > 0 && (
        <Section label="Current Changes">
          <div className="flex items-center gap-2 flex-wrap px-3 py-2.5 rounded-lg border bg-muted/30">
            {statusSummary.staged > 0 && (
              <StatusChip label={`${statusSummary.staged} staged`} className="text-green-400 bg-green-500/10" onClick={onSwitchToDiff} />
            )}
            {statusSummary.unstaged > 0 && (
              <StatusChip label={`${statusSummary.unstaged} modified`} className="text-yellow-400 bg-yellow-500/10" onClick={onSwitchToDiff} />
            )}
            {statusSummary.untracked > 0 && (
              <StatusChip label={`${statusSummary.untracked} untracked`} className="text-muted-foreground bg-muted" onClick={onSwitchToDiff} />
            )}
          </div>
        </Section>
      )}

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
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
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
