import { useState, useEffect, useCallback } from 'react'
import { GitBranch, ChevronDown, Check, Loader2, Plus, Copy, FolderGit2 } from 'lucide-react'
import { Button, IconButton, Input, Popover, PopoverContent, PopoverTrigger, cn, toast } from '@slayzone/ui'
import type { StatusSummary, AheadBehind } from '../shared/types'
import { RemoteSection } from './RemoteSection'
import { useBranchGraph, BranchGraphToolbar, BranchGraphCard } from './BranchesTab'

interface ProjectGeneralTabProps {
  projectPath: string | null
  visible: boolean
  onSwitchToDiff: () => void
}

export function ProjectGeneralTab({ projectPath, visible, onSwitchToDiff }: ProjectGeneralTabProps) {
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null)
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [statusSummary, setStatusSummary] = useState<StatusSummary | null>(null)

  const [initializing, setInitializing] = useState(false)

  const [remoteUrl, setRemoteUrl] = useState<string | null>(null)
  const [upstreamAB, setUpstreamAB] = useState<AheadBehind | null>(null)

  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [switching, setSwitching] = useState(false)
  const [branchError, setBranchError] = useState<string | null>(null)

  const branchGraph = useBranchGraph(projectPath, visible && isGitRepo === true)

  const fetchGitData = useCallback(async () => {
    if (!projectPath) return
    try {
      const isRepo = await window.api.git.isGitRepo(projectPath)
      setIsGitRepo(isRepo)
      if (!isRepo) return
      const [branch, status, remote] = await Promise.all([
        window.api.git.getCurrentBranch(projectPath),
        window.api.git.getStatusSummary(projectPath),
        window.api.git.getRemoteUrl(projectPath)
      ])
      setCurrentBranch(branch)
      setStatusSummary(status)
      setRemoteUrl(remote)
      if (branch) {
        const uab = await window.api.git.getAheadBehindUpstream(projectPath, branch)
        setUpstreamAB(uab)
      } else {
        setUpstreamAB(null)
      }
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
    <div className="h-full flex flex-col">
      <div className="shrink-0 p-4 pb-0 space-y-6">
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
              <IconButton type="submit" aria-label="Create branch" variant="ghost" className="h-7 w-7 shrink-0" disabled={!newBranchName.trim() || switching}>
                <Plus className="h-3.5 w-3.5" />
              </IconButton>
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

      <Section
        label="Status"
        right={remoteUrl && (
          <button
            onClick={() => { navigator.clipboard.writeText(remoteUrl); toast('Remote URL copied') }}
            className="flex items-center gap-1 group"
            title="Click to copy"
          >
            <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[200px]">
              {remoteUrl.replace(/^https?:\/\//, '').replace(/\.git$/, '')}
            </span>
            <Copy className="h-2.5 w-2.5 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
          </button>
        )}
      >
        <div className="flex items-center gap-2 flex-wrap px-3 py-2.5 rounded-lg border bg-muted/30">
          {statusSummary && totalChanges > 0 ? (
            <>
              {statusSummary.staged > 0 && (
                <StatusChip label={`${statusSummary.staged} staged`} className="text-green-400 bg-green-500/10" onClick={onSwitchToDiff} />
              )}
              {statusSummary.unstaged > 0 && (
                <StatusChip label={`${statusSummary.unstaged} modified`} className="text-yellow-400 bg-yellow-500/10" onClick={onSwitchToDiff} />
              )}
              {statusSummary.untracked > 0 && (
                <StatusChip label={`${statusSummary.untracked} untracked`} className="text-muted-foreground bg-muted" onClick={onSwitchToDiff} />
              )}
            </>
          ) : (
            <span className="text-xs text-muted-foreground">No changes</span>
          )}
          {remoteUrl && (
            <div className="ml-auto">
              <RemoteSection
                remoteUrl={remoteUrl}
                upstreamAB={upstreamAB}
                targetPath={projectPath}
                branch={currentBranch}
                onSyncDone={fetchGitData}
              />
            </div>
          )}
        </div>
      </Section>

      </div>

      {/* Branch graph */}
      <div className="flex-1 min-h-[200px] flex flex-col p-4 pt-6">
        <div className="shrink-0 flex items-end gap-2 mb-2">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Commits & Branches</div>
          <div className="flex-1" />
          <BranchGraphToolbar state={branchGraph} />
        </div>
        <div className="flex-1 min-h-0">
          <BranchGraphCard state={branchGraph} />
        </div>
      </div>
    </div>
  )
}

function Section({ label, right, children }: { label: string; right?: React.ReactNode; children: React.ReactNode }) {
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
