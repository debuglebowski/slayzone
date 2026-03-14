import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { RefreshCw, Search, Loader2, SlidersHorizontal, Info, List, Layers } from 'lucide-react'
import {
  IconButton, Input, Switch, cn, toast,
  Popover, PopoverTrigger, PopoverContent,
  Label,
} from '@slayzone/ui'
import type { CommitGraphConfig, ResolvedGraph } from '../shared/types'
import { CommitGraph } from './CommitGraph'

const FETCH_LIMIT = 2000   // fetch more for accurate branch topology
const RENDER_LIMIT = 500   // cap DOM nodes for performance

const DEFAULT_CONFIG: CommitGraphConfig = {
  baseBranch: '',  // resolved at runtime
  collapsed: false,
  includeChildBranches: true,
  includeMergedBranches: false,
  includeTags: true,
}

// --- Shared hook: all branch graph state + data fetching ---

export interface BranchGraphState {
  dagGraph: ResolvedGraph | null
  loading: boolean
  filter: string
  setFilter: (v: string) => void
  config: CommitGraphConfig
  setConfig: React.Dispatch<React.SetStateAction<CommitGraphConfig>>
  effectiveBaseBranch: string
  fetching: boolean
  handleFetch: () => Promise<void>
}

export function useBranchGraph(
  projectPath: string | null,
  visible: boolean,
  defaultBaseBranch?: string,
): BranchGraphState {
  const [dagGraph, setDagGraph] = useState<ResolvedGraph | null>(null)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(false)
  const initialLoad = useRef(false)

  const [currentBranch, setCurrentBranch] = useState<string>('')
  const [config, setConfig] = useState<CommitGraphConfig>(DEFAULT_CONFIG)

  const effectiveBaseBranch = useMemo(
    () => config.baseBranch || defaultBaseBranch || currentBranch || 'main',
    [config.baseBranch, defaultBaseBranch, currentBranch]
  )

  const fetchData = useCallback(async () => {
    if (!projectPath) return
    try {
      const branch = await window.api.git.getCurrentBranch(projectPath)
      if (branch) setCurrentBranch(branch)

      const baseBranch = config.baseBranch || defaultBaseBranch || branch || 'main'

      const branchSet = new Set<string>([baseBranch])

      if (config.includeChildBranches || config.includeMergedBranches) {
        const result = await window.api.git.resolveChildBranches(projectPath, baseBranch)
        if (config.includeChildBranches) {
          for (const child of result.children) branchSet.add(child)
        }
        if (config.includeMergedBranches) {
          for (const merged of result.merged) branchSet.add(merged)
        }
      }

      const graph = await window.api.git.getResolvedCommitDag(
        projectPath, FETCH_LIMIT, [...branchSet], baseBranch
      )
      setDagGraph(graph)
    } catch { /* polling error */ }
  }, [projectPath, config, defaultBaseBranch])

  useEffect(() => {
    initialLoad.current = false
    setConfig(DEFAULT_CONFIG)
  }, [projectPath])

  useEffect(() => {
    if (!visible || !projectPath) return
    if (!initialLoad.current) {
      setLoading(true)
      fetchData().finally(() => { setLoading(false); initialLoad.current = true })
    } else {
      fetchData()
    }
    const timer = setInterval(fetchData, 10000)
    return () => clearInterval(timer)
  }, [visible, projectPath, fetchData])

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

  return { dagGraph, loading, filter, setFilter, config, setConfig, effectiveBaseBranch, fetching, handleFetch }
}

// --- Toolbar buttons (display, info, fetch) ---

export function BranchGraphToolbar({ state }: { state: BranchGraphState }) {
  return (
    <>
      <DisplayPopover config={state.config} effectiveBaseBranch={state.effectiveBaseBranch} onChange={state.setConfig} />
      <GraphInfoPopover />
      <IconButton
        aria-label="Fetch"
        variant="ghost"
        className="h-7 w-7"
        title="Fetch from remote"
        onClick={state.handleFetch}
        disabled={state.fetching}
      >
        <RefreshCw className={cn('h-3.5 w-3.5', state.fetching && 'animate-spin')} />
      </IconButton>
    </>
  )
}

// --- Full standalone BranchesTab ---

interface BranchesTabProps {
  projectPath: string | null
  visible: boolean
  defaultBaseBranch?: string
  /** Standalone (false/undefined): toolbar above card. Embedded (true): toolbar inside card. */
  embedded?: boolean
}

export function BranchesTab({ projectPath, visible, defaultBaseBranch, embedded }: BranchesTabProps) {
  const state = useBranchGraph(projectPath, visible, defaultBaseBranch)

  if (!projectPath) {
    return <div className="p-4 text-xs text-muted-foreground">Set a project path to use Git features</div>
  }

  if (state.loading) {
    return <div className="h-full flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }

  const toolbar = (
    <div className="flex items-center gap-2">
      <div className="relative max-w-48">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={state.filter}
          onChange={(e) => state.setFilter(e.target.value)}
          placeholder="Filter..."
          className="h-7 text-xs pl-8"
        />
      </div>
      <div className="flex-1" />
      <BranchGraphToolbar state={state} />
    </div>
  )

  const graphContent = state.dagGraph && state.dagGraph.commits.length > 0 ? (
    <CommitGraph
      graph={state.dagGraph}
      filterQuery={state.filter || undefined}
      tipsOnly={state.config.collapsed}
      includeTags={state.config.includeTags}
      renderLimit={RENDER_LIMIT}
    />
  ) : (
    <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">
      {state.filter ? 'No matches' : 'No branches'}
    </div>
  )

  if (embedded) {
    return (
      <div className="h-full flex flex-col p-3">
        <div className="flex-1 min-h-0 rounded-lg border bg-muted/30 p-2 flex flex-col">
          <div className="shrink-0 pb-2">{toolbar}</div>
          <div className="flex-1 min-h-0 overflow-y-auto">{graphContent}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 p-3 pb-0">{toolbar}</div>
      <div className="flex-1 min-h-0 p-3">
        <div className="rounded-lg border bg-muted/30 p-2 h-full overflow-y-auto">
          {graphContent}
        </div>
      </div>
    </div>
  )
}

// --- Headless graph card (for external toolbar placement) ---

export function BranchGraphCard({ state, className }: { state: BranchGraphState; className?: string }) {
  if (state.loading) {
    return <div className="h-full flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }

  const graphContent = state.dagGraph && state.dagGraph.commits.length > 0 ? (
    <CommitGraph
      graph={state.dagGraph}
      filterQuery={state.filter || undefined}
      tipsOnly={state.config.collapsed}
      includeTags={state.config.includeTags}
      renderLimit={RENDER_LIMIT}
    />
  ) : (
    <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">
      No branches
    </div>
  )

  return (
    <div className={cn('rounded-lg border bg-muted/30 p-2 h-full overflow-y-auto', className)}>
      {graphContent}
    </div>
  )
}

// --- Display popover (matches kanban pattern) ---

function DisplayPopover({ config, effectiveBaseBranch, onChange }: {
  config: CommitGraphConfig
  effectiveBaseBranch: string
  onChange: React.Dispatch<React.SetStateAction<CommitGraphConfig>>
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton
          aria-label="Display settings"
          variant="ghost"
          className="h-7 w-7"
          title="Display settings"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="end">
        <div className="space-y-3">
          {/* View mode toggle */}
          <div className="grid grid-cols-2 rounded-md border border-border/50 p-0.5 gap-0.5">
            {([
              { value: false, icon: List, label: 'All commits' },
              { value: true, icon: Layers, label: 'Collapsed' }
            ] as const).map(({ value, icon: Icon, label }) => {
              const isActive = config.collapsed === value
              return (
                <button
                  key={label}
                  className={`flex flex-col items-center justify-center gap-1 py-3 text-[10px] font-medium rounded transition-colors ${
                    isActive
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                  onClick={() => onChange(c => ({ ...c, collapsed: value }))}
                >
                  <Icon className="size-5" />
                  {label}
                </button>
              )
            })}
          </div>

          {/* Base branch (read-only) */}
          <div className="flex items-center justify-between">
            <Label className="text-sm">Base branch</Label>
            <span className="text-xs font-mono text-muted-foreground px-1.5 py-0.5 rounded bg-muted border">
              {effectiveBaseBranch}
            </span>
          </div>

          <div className="h-px bg-border" />

          {/* Toggle switches */}
          <div className="flex items-center justify-between">
            <Label htmlFor="display-child-branches" className="text-sm cursor-pointer">Include child branches</Label>
            <Switch id="display-child-branches" checked={config.includeChildBranches} onCheckedChange={(v) => onChange(c => ({ ...c, includeChildBranches: v }))} />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="display-merged-branches" className="text-sm cursor-pointer">Include merged branches</Label>
            <Switch id="display-merged-branches" checked={config.includeMergedBranches} onCheckedChange={(v) => onChange(c => ({ ...c, includeMergedBranches: v }))} />
          </div>
          {config.collapsed && (
            <div className="flex items-center justify-between">
              <Label htmlFor="display-tags" className="text-sm cursor-pointer">Include tags</Label>
              <Switch id="display-tags" checked={config.includeTags} onCheckedChange={(v) => onChange(c => ({ ...c, includeTags: v }))} />
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// --- Graph info popover ---

function GraphInfoPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton aria-label="Graph info" variant="ghost" className="h-7 w-7" title="Graph legend">
          <Info className="h-3.5 w-3.5" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent className="w-72 text-xs space-y-3" side="bottom" align="end">
        <p className="font-medium text-[11px]">Graph legend</p>

        <div className="flex items-start gap-2">
          <svg width="28" height="28" className="shrink-0"><line x1="14" y1="0" x2="14" y2="11" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" /><circle cx="14" cy="14" r="3" fill="#e2e2e2" /><line x1="14" y1="17" x2="14" y2="28" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" /></svg>
          <div><span className="font-medium">Commit</span><p className="text-muted-foreground mt-0.5">A regular commit on a branch.</p></div>
        </div>

        <div className="flex items-start gap-2">
          <svg width="28" height="28" className="shrink-0"><line x1="14" y1="0" x2="14" y2="9" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" /><circle cx="14" cy="14" r="5" fill="none" stroke="#e2e2e2" strokeWidth="2" /><line x1="14" y1="19" x2="14" y2="28" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" /></svg>
          <div><span className="font-medium">Merge commit</span><p className="text-muted-foreground mt-0.5">A commit where two branches were joined together.</p></div>
        </div>

        <div className="flex items-start gap-2">
          <svg width="28" height="28" className="shrink-0"><line x1="14" y1="0" x2="14" y2="28" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" /></svg>
          <div><span className="font-medium">Solid line</span><p className="text-muted-foreground mt-0.5">Commits that have been pushed to the remote.</p></div>
        </div>

        <div className="flex items-start gap-2">
          <svg width="28" height="28" className="shrink-0"><line x1="14" y1="0" x2="14" y2="28" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" strokeDasharray="4 3" /></svg>
          <div><span className="font-medium">Dashed line</span><p className="text-muted-foreground mt-0.5">Local commits not yet pushed. The dashed section ends at the <code className="text-[10px] bg-muted px-0.5 rounded">origin/</code> ref.</p></div>
        </div>

        <div className="flex items-start gap-2">
          <svg width="28" height="28" className="shrink-0"><circle cx="7" cy="14" r="3.5" fill="#e2e2e2" /><line x1="19" y1="14" x2="11" y2="14" stroke="#a78bfa" strokeWidth="2" opacity="0.35" /><circle cx="21" cy="14" r="2.5" fill="#a78bfa" /></svg>
          <div><span className="font-medium">Merged branch</span><p className="text-muted-foreground mt-0.5">A PR branch that was merged and deleted. The colored dot shows which branch the commit came from.</p></div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
