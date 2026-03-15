import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { RefreshCw, Loader2, SlidersHorizontal, Info, List, Layers } from 'lucide-react'
import {
  IconButton, Switch, cn, toast,
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
  showBranches: true,
  breakOnTags: true,
  breakOnMerges: true,
}

// --- Shared hook: all branch graph state + data fetching ---

export interface BranchGraphState {
  dagGraph: ResolvedGraph | null
  loading: boolean
  filter: string
  setFilter: (v: string) => void
  config: CommitGraphConfig
  setConfig: React.Dispatch<React.SetStateAction<CommitGraphConfig>>
  resetConfig: () => void
  effectiveBaseBranch: string
  fetching: boolean
  handleFetch: () => Promise<void>
  refresh: () => Promise<void>
}

export function useBranchGraph(
  projectPath: string | null,
  visible: boolean,
  defaultBaseBranch?: string,
  /** Unique key for persisting this instance's display config (e.g. 'task:123', 'project:/path') */
  configKey?: string,
): BranchGraphState {
  const [dagGraph, setDagGraph] = useState<ResolvedGraph | null>(null)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(false)
  const initialLoad = useRef(false)

  const [currentBranch, setCurrentBranch] = useState<string>('')
  const [config, setConfig] = useState<CommitGraphConfig>(DEFAULT_CONFIG)

  // Load per-instance config (if saved), otherwise global defaults
  useEffect(() => {
    const load = async () => {
      const instanceJson = configKey ? await window.api.settings.get(`commit_graph:${configKey}`) : null
      if (instanceJson) {
        setConfig({ ...JSON.parse(instanceJson), baseBranch: '' })
        return
      }
      const globalJson = await window.api.settings.get('commit_graph_config')
      if (globalJson) {
        setConfig({ ...DEFAULT_CONFIG, ...JSON.parse(globalJson), baseBranch: '' })
      } else {
        setConfig(DEFAULT_CONFIG)
      }
    }
    load()
  }, [configKey])

  // Save full config to this instance
  const updateConfig = useCallback((updater: React.SetStateAction<CommitGraphConfig>) => {
    setConfig(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      if (configKey) {
        const { baseBranch: _, ...persisted } = next
        window.api.settings.set(`commit_graph:${configKey}`, JSON.stringify(persisted))
      }
      return next
    })
  }, [configKey])

  // Reset to global defaults (clear per-instance config)
  const resetConfig = useCallback(async () => {
    if (configKey) {
      await window.api.settings.set(`commit_graph:${configKey}`, '')
    }
    const globalJson = await window.api.settings.get('commit_graph_config')
    if (globalJson) {
      setConfig({ ...DEFAULT_CONFIG, ...JSON.parse(globalJson), baseBranch: '' })
    } else {
      setConfig(DEFAULT_CONFIG)
    }
  }, [configKey])

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

      if (config.showBranches) {
        const result = await window.api.git.resolveChildBranches(projectPath, baseBranch)
        for (const child of result.children) branchSet.add(child)
        for (const merged of result.merged) branchSet.add(merged)
      }

      const graph = await window.api.git.getResolvedCommitDag(
        projectPath, FETCH_LIMIT, [...branchSet], baseBranch
      )
      setDagGraph(graph)
    } catch { /* polling error */ }
  }, [projectPath, config, defaultBaseBranch])

  useEffect(() => {
    initialLoad.current = false
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

  return { dagGraph, loading, filter, setFilter, config, setConfig: updateConfig, resetConfig, effectiveBaseBranch, fetching, handleFetch, refresh: fetchData }
}

// --- Toolbar buttons (display, info, fetch) ---

export function BranchGraphToolbar({ state }: { state: BranchGraphState }) {
  return (
    <>
      <DisplayPopover config={state.config} effectiveBaseBranch={state.effectiveBaseBranch} onChange={state.setConfig} onReset={state.resetConfig} />
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
      includeTags={state.config.breakOnTags}
            breakOnMerges={state.config.breakOnMerges}
      renderLimit={RENDER_LIMIT}
    />
  ) : (
    <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">
      No branches
    </div>
  )

  return (
    <div className={cn('rounded-lg border bg-muted/30 pt-4 pr-4 pb-4 pl-2 h-full', className)}>
      {graphContent}
    </div>
  )
}

// --- Display popover (matches kanban pattern) ---

function DisplayPopover({ config, effectiveBaseBranch, onChange, onReset }: {
  config: CommitGraphConfig
  effectiveBaseBranch: string
  onChange: React.Dispatch<React.SetStateAction<CommitGraphConfig>>
  onReset?: () => void
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
        <div className="space-y-8">
          {/* Base branch */}
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Base branch</Label>
            <span className="text-xs font-mono text-muted-foreground">
              {effectiveBaseBranch}
            </span>
          </div>

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

          {/* Settings section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Settings</span>
              {onReset && (
                <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground transition-colors" onClick={onReset}>
                  Reset defaults
                </button>
              )}
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="display-branches" className="text-sm cursor-pointer">Show branches</Label>
              <Switch id="display-branches" checked={config.showBranches} onCheckedChange={(v) => onChange(c => ({ ...c, showBranches: v }))} />
            </div>
            {config.collapsed && (<>
              <div className="flex items-center justify-between">
                <Label htmlFor="break-on-tags" className="text-sm cursor-pointer">Break on tags</Label>
                <Switch id="break-on-tags" checked={config.breakOnTags} onCheckedChange={(v) => onChange(c => ({ ...c, breakOnTags: v }))} />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="break-on-merges" className="text-sm cursor-pointer">Break on merges</Label>
                <Switch id="break-on-merges" checked={config.breakOnMerges} onCheckedChange={(v) => onChange(c => ({ ...c, breakOnMerges: v }))} />
              </div>
            </>)}
          </div>
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
          <svg width="28" height="28" className="shrink-0">
            <line x1="10" y1="0" x2="10" y2="28" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" />
            <circle cx="10" cy="10" r="3" fill="#e2e2e2" />
            <path d={`M20,20 C10,20 13,10 10,10`} stroke="#a78bfa" strokeWidth="2" fill="none" opacity="0.35" />
            <circle cx="20" cy="20" r="3" fill="#a78bfa" />
          </svg>
          <div><span className="font-medium">Merged branch</span><p className="text-muted-foreground mt-0.5">A branch that was merged and deleted. The colored dot shows which branch it came from.</p></div>
        </div>

        <div className="flex items-start gap-2">
          <svg width="28" height="28" className="shrink-0">
            <line x1="10" y1="0" x2="10" y2="28" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" />
            <circle cx="10" cy="18" r="3" fill="#e2e2e2" />
            <path d={`M20,8 C10,8 13,18 10,18`} stroke="#10b981" strokeWidth="2" fill="none" opacity="0.35" />
            <circle cx="20" cy="8" r="3" fill="#10b981" />
          </svg>
          <div><span className="font-medium">Empty branch</span><p className="text-muted-foreground mt-0.5">A branch with no unique commits — its tip is already on main.</p></div>
        </div>

        <div className="flex items-start gap-2">
          <svg width="28" height="28" className="shrink-0">
            <line x1="14" y1="0" x2="14" y2="10" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" />
            <line x1="10" y1="13" x2="18" y2="13" stroke="#e2e2e2" strokeWidth="1.5" strokeLinecap="round" opacity="0.25" />
            <line x1="10" y1="16" x2="18" y2="16" stroke="#e2e2e2" strokeWidth="1.5" strokeLinecap="round" opacity="0.25" />
            <line x1="14" y1="19" x2="14" y2="28" stroke="#e2e2e2" strokeWidth="2" opacity="0.35" />
          </svg>
          <div><span className="font-medium">Collapsed commits</span><p className="text-muted-foreground mt-0.5">Multiple commits hidden in collapsed view. Hover to see the count.</p></div>
        </div>

        <div className="flex items-start gap-2">
          <div className="shrink-0 w-[28px] flex items-center justify-center h-[28px]">
            <span className="px-1.5 py-0 rounded text-[9px] font-medium" style={{ backgroundColor: '#a78bfa20', color: '#a78bfa' }}>main</span>
          </div>
          <div><span className="font-medium">Branch label</span><p className="text-muted-foreground mt-0.5">A branch ref pointing at this commit.</p></div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
