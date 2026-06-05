import { useMemo } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@slayzone/ui'
import type { SkillRegistry, SkillRegistryEntry } from '../shared'
import { SkillEntryCard } from './SkillEntryCard'
import type { BrowseMode } from './useSkillMarketplace'

interface MarketplaceSkillGridProps {
  browseMode: BrowseMode
  search: string
  onSearchChange: (value: string) => void
  selectedRegistry: string | null
  onSelectedRegistryChange: (value: string | null) => void
  registries: SkillRegistry[]
  loading: boolean
  entries: SkillRegistryEntry[]
  hasProject: boolean
  installing: string | null
  onAddToLibrary: (entryId: string) => void
  onAddToProject: (entryId: string) => void
  onUpdate: (itemId: string, entryId: string) => void
  onUninstall: (itemId: string) => void
  onPreview: (entry: SkillRegistryEntry) => void
}

export function MarketplaceSkillGrid({
  browseMode,
  search,
  onSearchChange,
  selectedRegistry,
  onSelectedRegistryChange,
  registries,
  loading,
  entries,
  hasProject,
  installing,
  onAddToLibrary,
  onAddToProject,
  onUpdate,
  onUninstall,
  onPreview
}: MarketplaceSkillGridProps) {
  const groupedEntries = useMemo(() => {
    const groups = new Map<string, typeof entries>()
    for (const entry of entries) {
      const cat = entry.category || 'general'
      const list = groups.get(cat)
      if (list) list.push(entry)
      else groups.set(cat, [entry])
    }
    return groups
  }, [entries])

  return (
    <>
      {/* Show-all mode: search + registry filter */}
      {browseMode === 'all' && (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search skills..."
              className="pl-8 h-8 text-xs"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </div>
          {registries.length > 1 && (
            <select
              className="h-8 rounded-md border border-border/50 bg-surface-3 px-2 text-xs text-foreground"
              value={selectedRegistry ?? ''}
              onChange={(e) => onSelectedRegistryChange(e.target.value || null)}
            >
              <option value="">All registries</option>
              {registries
                .filter((r) => r.enabled)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </select>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
          Loading skills...
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
          <p className="text-sm text-muted-foreground">No skills found</p>
          <p className="text-xs text-muted-foreground/60">
            {search ? 'Try a different search term' : 'This registry has no skills yet'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-12 overflow-y-auto flex-1">
          {[...groupedEntries.entries()].map(([category, categoryEntries]) => (
            <div key={category}>
              <h3 className="text-lg font-semibold text-foreground mb-4 uppercase">{category}</h3>
              <div
                className="grid gap-3 content-start"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))' }}
              >
                {categoryEntries.map((entry) => (
                  <SkillEntryCard
                    key={entry.id}
                    entry={entry}
                    onAddToLibrary={onAddToLibrary}
                    onAddToProject={onAddToProject}
                    hasProject={hasProject}
                    onUpdate={onUpdate}
                    onUninstall={onUninstall}
                    onPreview={onPreview}
                    installing={installing === entry.id}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
