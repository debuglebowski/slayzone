import { RefreshCw, Loader2 } from 'lucide-react'
import { IconButton, cn } from '@slayzone/ui'
import { CommitGraph } from './CommitGraph'
import { RENDER_LIMIT } from './branches-tab.constants'
import type { BranchGraphState } from './branches-tab.types'
import { DisplayPopover } from './DisplayPopover'
import { GraphInfoPopover } from './GraphInfoPopover'

// Public surface preserved: siblings import these from `./BranchesTab`.
export { useBranchGraph } from './useBranchGraph'
export type { CommitGraphPersistence, BranchGraphState } from './branches-tab.types'

// --- Toolbar buttons (display, info, fetch) ---

export function BranchGraphToolbar({ state }: { state: BranchGraphState }) {
  return (
    <>
      <DisplayPopover
        config={state.config}
        effectiveBaseBranch={state.effectiveBaseBranch}
        onChange={state.setConfig}
        onReset={state.resetConfig}
      />
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

export function BranchGraphCard({
  state,
  className
}: {
  state: BranchGraphState
  className?: string
}) {
  if (state.loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const graphContent =
    state.dagGraph && state.dagGraph.commits.length > 0 ? (
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
