import type { Dispatch, SetStateAction } from 'react'
import { ArrowLeft, ExternalLink, Plus, RefreshCw, Search, Settings2 } from 'lucide-react'
import { Button, Input, cn } from '@slayzone/ui'
import type { SkillRegistry } from '../shared'
import type { BrowseMode, View } from './useSkillMarketplace'

interface MarketplaceHeaderProps {
  browseMode: BrowseMode
  activeRegistry: SkillRegistry | null | undefined
  search: string
  setSearch: Dispatch<SetStateAction<string>>
  view: View
  setView: Dispatch<SetStateAction<View>>
  onDrillOut: () => void
  onBrowseModeChange: (mode: BrowseMode) => void
  onRefreshAll: () => void
  refreshingAll: boolean
  setShowAddDialog: Dispatch<SetStateAction<boolean>>
}

export function MarketplaceHeader({
  browseMode,
  activeRegistry,
  search,
  setSearch,
  view,
  setView,
  onDrillOut,
  onBrowseModeChange,
  onRefreshAll,
  refreshingAll,
  setShowAddDialog
}: MarketplaceHeaderProps) {
  const isDrilledIn = browseMode === 'registries' && activeRegistry != null

  return (
    <div className="shrink-0 flex items-center justify-between">
      {isDrilledIn ? (
        <>
          {/* Drill-in: back + name + link */}
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={onDrillOut}
              className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
            >
              <ArrowLeft className="size-4" />
            </button>
            <h2 className="text-lg font-semibold truncate">{activeRegistry.name}</h2>
            {activeRegistry.github_owner && (
              <a
                href={`https://github.com/${activeRegistry.github_owner}/${activeRegistry.github_repo}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-foreground transition-colors shrink-0"
              >
                <ExternalLink className="size-3" />
                {activeRegistry.github_owner}/{activeRegistry.github_repo}
              </a>
            )}
          </div>
          {/* Drill-in: search */}
          <div className="relative w-64 shrink-0">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search skills..."
              className="pl-8 h-8 text-xs"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </>
      ) : (
        <>
          {/* List: title */}
          <h2 className="text-lg font-semibold">Marketplace</h2>
          {/* List: actions */}
          <div className="flex items-center gap-2">
            <div className="flex rounded-md border border-border/50 overflow-hidden">
              <button
                className={cn(
                  'px-2.5 py-1 text-[11px] transition-colors',
                  browseMode === 'registries'
                    ? 'bg-foreground text-background'
                    : 'bg-background text-muted-foreground hover:text-foreground'
                )}
                onClick={() => onBrowseModeChange('registries')}
              >
                Registries
              </button>
              <button
                className={cn(
                  'px-2.5 py-1 text-[11px] transition-colors',
                  browseMode === 'all'
                    ? 'bg-foreground text-background'
                    : 'bg-background text-muted-foreground hover:text-foreground'
                )}
                onClick={() => onBrowseModeChange('all')}
              >
                Show all
              </button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={onRefreshAll}
              disabled={refreshingAll}
            >
              <RefreshCw className={cn('size-3', refreshingAll && 'animate-spin')} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={() => setShowAddDialog(true)}
            >
              <Plus className="size-3" />
              Add Repo
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn('h-7 text-xs gap-1.5', view === 'manage' && 'bg-surface-3')}
              onClick={() => setView(view === 'manage' ? 'browse' : 'manage')}
            >
              <Settings2 className="size-3" />
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
