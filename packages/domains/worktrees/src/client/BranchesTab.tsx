import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { RefreshCw, Search, Loader2, Settings2, X } from 'lucide-react'
import {
  IconButton, Input, Switch, cn, toast,
  Popover, PopoverTrigger, PopoverContent,
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
  Label
} from '@slayzone/ui'
import type { CommitGraphConfig, ResolvedGraph } from '../shared/types'
import { CommitGraph } from './CommitGraph'

const FETCH_LIMIT = 2000   // fetch more for accurate branch topology
const RENDER_LIMIT = 500   // cap DOM nodes for performance

const DEFAULT_CONFIG: CommitGraphConfig = {
  baseBranch: '',  // resolved at runtime to current branch
  forcedBranches: [],
  includeChildrenOf: [],
  showMergedBranches: false,
  collapsed: false
}

interface BranchesTabProps {
  projectPath: string | null
  visible: boolean
}

export function BranchesTab({ projectPath, visible }: BranchesTabProps) {
  const [dagGraph, setDagGraph] = useState<ResolvedGraph | null>(null)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(false)
  const initialLoad = useRef(false)

  // Branch metadata
  const [currentBranch, setCurrentBranch] = useState<string>('')
  const [allBranches, setAllBranches] = useState<string[]>([])

  // Graph config
  const [config, setConfig] = useState<CommitGraphConfig>(DEFAULT_CONFIG)

  // Resolve effective config (fill in runtime defaults)
  const effectiveConfig = useMemo((): CommitGraphConfig => ({
    ...config,
    baseBranch: config.baseBranch || currentBranch || 'main',
    includeChildrenOf: config.includeChildrenOf.length > 0
      ? config.includeChildrenOf
      : [config.baseBranch || currentBranch || 'main']
  }), [config, currentBranch])

  const fetchData = useCallback(async () => {
    if (!projectPath) return
    try {
      const [branch, branches] = await Promise.all([
        window.api.git.getCurrentBranch(projectPath),
        window.api.git.listBranches(projectPath)
      ])
      if (branch) setCurrentBranch(branch)
      setAllBranches(branches)

      // Resolve effective base
      const baseBranch = config.baseBranch || branch || 'main'
      const includeChildren = config.includeChildrenOf.length > 0
        ? config.includeChildrenOf
        : [baseBranch]

      // Resolve child branches via backend
      const childResults = await Promise.all(
        includeChildren.map(b => window.api.git.resolveChildBranches(projectPath, b))
      )

      // Build the set of branches to show
      const branchSet = new Set<string>([baseBranch, ...config.forcedBranches])
      for (const result of childResults) {
        for (const child of result.children) branchSet.add(child)
        if (config.showMergedBranches) {
          for (const merged of result.merged) branchSet.add(merged)
        }
      }

      // Fetch resolved DAG for only the resolved branches
      const graph = await window.api.git.getResolvedCommitDag(
        projectPath, FETCH_LIMIT, [...branchSet], baseBranch
      )
      setDagGraph(graph)
    } catch { /* polling error */ }
  }, [projectPath, config])

  // Reset on project change
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

  if (!projectPath) {
    return <div className="p-4 text-xs text-muted-foreground">Set a project path to use Git features</div>
  }

  if (loading) {
    return <div className="h-full flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="shrink-0 p-3 pb-0">
        <div className="flex items-center gap-2">
          {/* Show all commits toggle */}
          <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer select-none">
            <Switch
              checked={!config.collapsed}
              onCheckedChange={(v) => setConfig(c => ({ ...c, collapsed: !v }))}
              className="scale-75"
            />
            All commits
          </label>

          {/* Filter */}
          <div className="flex-1 relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter..."
              className="h-7 text-xs pl-8"
            />
          </div>

          {/* Graph config */}
          <GraphConfigPopover
            config={config}
            effectiveConfig={effectiveConfig}
            currentBranch={currentBranch}
            allBranches={allBranches}
            onChange={setConfig}
          />

          {/* Fetch */}
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

      {/* Graph */}
      <div className="flex-1 min-h-0 p-3">
        {dagGraph && dagGraph.commits.length > 0 ? (
          <div className="rounded-lg border bg-muted/30 p-2 h-full overflow-y-auto">
            <CommitGraph
              graph={dagGraph}
              filterQuery={filter || undefined}
              tipsOnly={config.collapsed}
              renderLimit={RENDER_LIMIT}
            />
          </div>
        ) : (
          <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">
            {filter ? 'No matches' : 'No branches'}
          </div>
        )}
      </div>
    </div>
  )
}

// --- Graph config popover ---

function GraphConfigPopover({ config, effectiveConfig, currentBranch, allBranches, onChange }: {
  config: CommitGraphConfig
  effectiveConfig: CommitGraphConfig
  currentBranch: string
  allBranches: string[]
  onChange: (config: CommitGraphConfig) => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton
          aria-label="Graph settings"
          variant="ghost"
          className="h-7 w-7"
          title="Graph settings"
        >
          <Settings2 className="h-3.5 w-3.5" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3 space-y-3" align="end">
        <div className="text-xs font-medium">Graph settings</div>

        {/* Base branch */}
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">Base branch</Label>
          <Select
            value={config.baseBranch || '__current__'}
            onValueChange={(v) => onChange({ ...config, baseBranch: v === '__current__' ? '' : v })}
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__current__">
                Current ({currentBranch || 'none'})
              </SelectItem>
              {allBranches.map(b => (
                <SelectItem key={b} value={b}>{b}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Include children */}
        <div className="space-y-1">
          <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer select-none">
            <Switch
              checked={effectiveConfig.includeChildrenOf.length > 0}
              onCheckedChange={(v) => onChange({
                ...config,
                includeChildrenOf: v ? [effectiveConfig.baseBranch] : []
              })}
              className="scale-75"
            />
            Show child branches
          </label>
        </div>

        {/* Show merged */}
        <div className="space-y-1">
          <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer select-none">
            <Switch
              checked={config.showMergedBranches}
              onCheckedChange={(v) => onChange({ ...config, showMergedBranches: v })}
              className="scale-75"
            />
            Show merged branches
          </label>
        </div>

        {/* Forced branches */}
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground">Always show</Label>
          <div className="flex flex-wrap gap-1">
            {config.forcedBranches.map(b => (
              <span key={b} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-muted border">
                {b}
                <button
                  className="hover:text-destructive"
                  onClick={() => onChange({ ...config, forcedBranches: config.forcedBranches.filter(x => x !== b) })}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
          <Select
            value=""
            onValueChange={(v) => {
              if (v && !config.forcedBranches.includes(v)) {
                onChange({ ...config, forcedBranches: [...config.forcedBranches, v] })
              }
            }}
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue placeholder="Add branch..." />
            </SelectTrigger>
            <SelectContent>
              {allBranches
                .filter(b => !config.forcedBranches.includes(b))
                .map(b => (
                  <SelectItem key={b} value={b}>{b}</SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </PopoverContent>
    </Popover>
  )
}
