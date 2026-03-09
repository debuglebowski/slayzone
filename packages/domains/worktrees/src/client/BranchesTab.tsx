import { useState, useEffect, useCallback, useRef } from 'react'
import { GitBranch, Trash2, RefreshCw, Search, ChevronRight, ChevronDown, ArrowUp, ArrowDown, Loader2 } from 'lucide-react'
import { IconButton, Input, cn, toast } from '@slayzone/ui'
import type { BranchDetail, CommitInfo } from '../shared/types'
import { BranchGraph, type GraphNode } from './BranchGraph'

interface BranchesTabProps {
  projectPath: string | null
  visible: boolean
}

export function BranchesTab({ projectPath, visible }: BranchesTabProps) {
  const [branches, setBranches] = useState<BranchDetail[]>([])
  const [remoteBranches, setRemoteBranches] = useState<string[]>([])
  const [defaultBranch, setDefaultBranch] = useState<string>('main')
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [expandedBranch, setExpandedBranch] = useState<string | null>(null)
  const [expandedCommits, setExpandedCommits] = useState<CommitInfo[]>([])
  const [loadingCommits, setLoadingCommits] = useState(false)
  const [pruning, setPruning] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null)
  const [showRemote, setShowRemote] = useState(false)
  const initialLoad = useRef(false)

  const fetchData = useCallback(async () => {
    if (!projectPath) return
    try {
      const result = await window.api.git.listBranchesDetailed(projectPath)
      setBranches(result.branches)
      setDefaultBranch(result.defaultBranch)
    } catch { /* polling error */ }
  }, [projectPath])

  // Reset on project change
  useEffect(() => { initialLoad.current = false }, [projectPath])

  useEffect(() => {
    if (!visible || !projectPath) return
    if (!initialLoad.current) {
      setLoading(true)
      fetchData().finally(() => { setLoading(false); initialLoad.current = true })
    } else {
      fetchData()
    }
    const timer = setInterval(fetchData, 5000)
    return () => clearInterval(timer)
  }, [visible, projectPath, fetchData])

  const handleExpandBranch = useCallback(async (branchName: string) => {
    if (expandedBranch === branchName) {
      setExpandedBranch(null)
      setExpandedCommits([])
      return
    }
    if (!projectPath) return
    setExpandedBranch(branchName)
    setLoadingCommits(true)
    try {
      const mergeBase = await window.api.git.getMergeBase(projectPath, branchName, defaultBranch)
      if (mergeBase) {
        const commits = await window.api.git.getCommitsSince(projectPath, mergeBase, branchName)
        setExpandedCommits(commits)
      } else {
        setExpandedCommits([])
      }
    } catch {
      setExpandedCommits([])
    } finally {
      setLoadingCommits(false)
    }
  }, [projectPath, defaultBranch, expandedBranch])

  const handleDelete = useCallback(async (branch: string, force?: boolean) => {
    if (!projectPath) return
    setDeletingBranch(branch)
    try {
      const result = await window.api.git.deleteBranch(projectPath, branch, force)
      if (result.success) {
        setBranches(prev => prev.filter(b => b.name !== branch))
        toast(`Deleted branch ${branch}`)
        if (expandedBranch === branch) {
          setExpandedBranch(null)
          setExpandedCommits([])
        }
      } else if (result.error?.includes('not fully merged') && !force) {
        toast(`${branch} not fully merged — click delete again to force`, { action: { label: 'Force delete', onClick: () => handleDelete(branch, true) } })
      } else {
        toast(result.error ?? 'Failed to delete branch')
      }
    } finally {
      setDeletingBranch(null)
    }
  }, [projectPath, expandedBranch])

  const handleFetch = useCallback(async () => {
    if (!projectPath) return
    setFetching(true)
    try {
      await window.api.git.fetch(projectPath)
      await fetchData()
      toast('Fetched from remote')
    } catch {
      toast('Fetch failed')
    } finally {
      setFetching(false)
    }
  }, [projectPath, fetchData])

  const handlePrune = useCallback(async () => {
    if (!projectPath) return
    setPruning(true)
    try {
      const result = await window.api.git.pruneRemote(projectPath)
      if (result.pruned.length > 0) {
        toast(`Pruned ${result.pruned.length} stale remote branch${result.pruned.length > 1 ? 'es' : ''}`)
        // Refresh remote branches
        const remotes = await window.api.git.listRemoteBranches(projectPath)
        setRemoteBranches(remotes)
      } else {
        toast('Nothing to prune')
      }
    } catch {
      toast('Prune failed')
    } finally {
      setPruning(false)
    }
  }, [projectPath])

  const handleShowRemote = useCallback(async () => {
    if (showRemote) {
      setShowRemote(false)
      return
    }
    if (!projectPath) return
    setShowRemote(true)
    try {
      const remotes = await window.api.git.listRemoteBranches(projectPath)
      setRemoteBranches(remotes)
    } catch {
      setRemoteBranches([])
    }
  }, [projectPath, showRemote])

  if (!projectPath) {
    return <div className="p-4 text-xs text-muted-foreground">Set a project path to use Git features</div>
  }

  if (loading) {
    return <div className="h-full flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }

  const filtered = filter
    ? branches.filter(b => b.name.toLowerCase().includes(filter.toLowerCase()))
    : branches

  // Build graph: default branch trunk + branch tips
  const graphNodes: GraphNode[] = []
  const defaultBranchData = branches.find(b => b.isDefault)

  if (defaultBranchData) {
    graphNodes.push({
      commit: defaultBranchData.lastCommit,
      column: 0,
      type: 'branch-tip',
      branchName: defaultBranchData.name,
      branchLabel: defaultBranchData.name + (defaultBranchData.isCurrent ? ' (HEAD)' : '')
    })
  }

  // Add non-default branches as branch tips at column 1
  const nonDefault = filtered.filter(b => !b.isDefault).slice(0, 15)
  for (const b of nonDefault) {
    graphNodes.push({
      commit: b.lastCommit,
      column: 1,
      type: 'branch-tip',
      branchName: b.name,
      branchLabel: b.name + (b.isCurrent ? ' (HEAD)' : '')
    })
  }

  return (
    <div className="h-full flex flex-col">
      {/* Filter + actions */}
      <div className="shrink-0 p-3 pb-0 space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter branches..."
              className="h-7 text-xs pl-8"
            />
          </div>
          <IconButton
            aria-label="Fetch"
            variant="ghost"
            className="h-7 w-7"
            title="Fetch from remote"
            onClick={handleFetch}
            disabled={fetching}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', fetching && 'animate-spin')} />
          </IconButton>
        </div>
      </div>

      {/* Graph overview */}
      {graphNodes.length > 0 && !filter && (
        <div className="shrink-0 px-3 pt-3">
          <div className="rounded-lg border bg-muted/30 p-2 overflow-x-auto">
            <BranchGraph nodes={graphNodes} maxColumns={nonDefault.length > 0 ? 2 : 1} />
          </div>
        </div>
      )}

      {/* Branch list */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
          Local ({filtered.length})
        </div>
        {filtered.map((branch) => (
          <div key={branch.name}>
            <div
              className={cn(
                'flex items-center gap-2 px-2.5 py-2 rounded-md text-xs transition-colors cursor-pointer',
                expandedBranch === branch.name ? 'bg-accent' : 'hover:bg-accent/50'
              )}
              onClick={() => !branch.isDefault && handleExpandBranch(branch.name)}
            >
              {!branch.isDefault ? (
                expandedBranch === branch.name
                  ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                  : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
              ) : (
                <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={cn('truncate', branch.isCurrent && 'font-semibold')}>
                    {branch.name}
                  </span>
                  {branch.isCurrent && (
                    <span className="text-[10px] text-primary font-medium">HEAD</span>
                  )}
                  {branch.isDefault && (
                    <span className="text-[10px] text-muted-foreground">default</span>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {branch.lastCommit.shortHash} · {branch.lastCommit.message}
                  {' · '}{branch.lastCommit.relativeDate}
                </div>
              </div>
              {/* Ahead/behind badges */}
              <div className="flex items-center gap-1.5 shrink-0">
                {branch.aheadBehindDefault && !branch.isDefault && (
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    {branch.aheadBehindDefault.ahead > 0 && (
                      <span className="flex items-center gap-0.5">
                        <ArrowUp className="h-2.5 w-2.5" />{branch.aheadBehindDefault.ahead}
                      </span>
                    )}
                    {branch.aheadBehindDefault.behind > 0 && (
                      <span className="flex items-center gap-0.5">
                        <ArrowDown className="h-2.5 w-2.5" />{branch.aheadBehindDefault.behind}
                      </span>
                    )}
                    {branch.aheadBehindDefault.ahead === 0 && branch.aheadBehindDefault.behind === 0 && (
                      <span className="text-green-500">✓</span>
                    )}
                  </div>
                )}
                {!branch.isDefault && !branch.isCurrent && (
                  <IconButton
                    aria-label={`Delete ${branch.name}`}
                    variant="ghost"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 hover:!opacity-100 hover:text-destructive"
                    onClick={(e) => { e.stopPropagation(); handleDelete(branch.name) }}
                    disabled={deletingBranch === branch.name}
                  >
                    <Trash2 className="h-3 w-3" />
                  </IconButton>
                )}
              </div>
            </div>

            {/* Expanded commits */}
            {expandedBranch === branch.name && (
              <div className="ml-6 mt-1 mb-2 pl-3 border-l-2 border-border space-y-0.5">
                {loadingCommits ? (
                  <div className="py-2 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading commits...
                  </div>
                ) : expandedCommits.length === 0 ? (
                  <div className="py-1 text-[10px] text-muted-foreground">No unique commits (up to date with {defaultBranch})</div>
                ) : (
                  expandedCommits.map(c => (
                    <div key={c.hash} className="py-0.5 text-[10px]">
                      <span className="font-mono text-muted-foreground">{c.shortHash}</span>
                      {' '}<span>{c.message}</span>
                      <span className="text-muted-foreground"> · {c.relativeDate}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="text-xs text-muted-foreground py-4 text-center">
            {filter ? 'No branches match filter' : 'No branches'}
          </div>
        )}

        {/* Remote branches */}
        <div className="pt-4">
          <button
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 hover:text-foreground transition-colors"
            onClick={handleShowRemote}
          >
            {showRemote ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Remote (origin)
            <div className="flex-1" />
            <span
              className="text-[10px] normal-case font-normal hover:underline"
              onClick={(e) => { e.stopPropagation(); handlePrune() }}
            >
              {pruning ? 'Pruning...' : 'Prune'}
            </span>
          </button>
          {showRemote && (
            <div className="space-y-0.5 ml-1">
              {remoteBranches.length === 0 ? (
                <div className="text-[10px] text-muted-foreground py-1">No remote branches</div>
              ) : remoteBranches.map(rb => (
                <div key={rb} className="text-[10px] text-muted-foreground py-0.5 px-2.5 truncate">
                  {rb}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
