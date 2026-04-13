import { useMemo } from 'react'
import { ArrowUpCircle, Library, Store, Trash2, AlertTriangle } from 'lucide-react'
import { Button, cn } from '@slayzone/ui'
import { getSkillValidation, getMarketplaceProvenance } from './skill-validation'
import { StatusBadge } from './SyncComponents'
import { useContextManagerStore, type SkillGroupBy } from './useContextManagerStore'
import type { AiConfigItem, SyncHealth, SkillUpdateInfo } from '../shared'

type SkillSource = 'project' | 'library' | 'marketplace'

const SOURCE_LABELS: Record<SkillSource, string> = {
  project: 'Project',
  library: 'Library',
  marketplace: 'Marketplace',
}

function getSkillSource(item: AiConfigItem, isProject: boolean): SkillSource {
  if (getMarketplaceProvenance(item)) return 'marketplace'
  if (isProject && item.scope === 'library') return 'library'
  return 'project'
}

function getSkillPrefix(item: AiConfigItem): string {
  const idx = item.slug.indexOf('-')
  return idx > 0 ? item.slug.slice(0, idx) : item.slug
}

interface SkillGroup {
  label: string
  items: AiConfigItem[]
}

function buildGroups(items: AiConfigItem[], groupBy: SkillGroupBy, isProject: boolean): SkillGroup[] | null {
  if (groupBy === 'none') return null

  if (groupBy === 'source') {
    const buckets: Partial<Record<SkillSource, AiConfigItem[]>> = {}
    for (const item of items) {
      const src = getSkillSource(item, isProject)
      ;(buckets[src] ??= []).push(item)
    }
    const order: SkillSource[] = isProject
      ? ['project', 'library', 'marketplace']
      : ['project', 'marketplace']
    return order.filter((s) => buckets[s]?.length).map((s) => ({ label: SOURCE_LABELS[s], items: buckets[s]! }))
  }

  // prefix
  const buckets = new Map<string, AiConfigItem[]>()
  for (const item of items) {
    const prefix = getSkillPrefix(item)
    const list = buckets.get(prefix)
    if (list) list.push(item)
    else buckets.set(prefix, [item])
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, groupItems]) => ({ label: prefix, items: groupItems }))
}

interface SkillListViewProps {
  items: AiConfigItem[]
  selectedSkillId: string | null
  isProject?: boolean
  groupBy?: SkillGroupBy
  onSelectSkill: (id: string | null) => void
  onDeleteItem: (id: string) => void
  updateMap?: Map<string, SkillUpdateInfo>
  onMarketplaceUpdate?: (itemId: string) => void
  syncHealthMap?: Map<string, SyncHealth>
}

export function SkillListView({
  items,
  selectedSkillId,
  isProject,
  groupBy = 'none',
  onSelectSkill,
  onDeleteItem,
  updateMap,
  onMarketplaceUpdate,
  syncHealthMap,
}: SkillListViewProps) {
  const showLineCount = useContextManagerStore((s) => s.showLineCount)
  const totalCount = items.length

  const groups = useMemo(
    () => buildGroups(items, groupBy, !!isProject),
    [items, groupBy, isProject]
  )

  return (
    <div className="space-y-2">
      {totalCount === 0 && (
        <p className="text-xs text-muted-foreground py-8 text-center">
          No skills yet. Create one to get started.
        </p>
      )}

      {groups ? (
        <div className="space-y-10">
          {groups.map(({ label, items: groupItems }) => (
            <div key={label} className="space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {label} <span className="text-muted-foreground/60">({groupItems.length})</span>
              </p>
              {groupItems.map((item) => (
                <SkillRow
                  key={item.id}
                  item={item}
                  isProject={isProject}
                  isSelected={selectedSkillId === item.id}
                  showLineCount={showLineCount}
                  hasUpdate={updateMap?.has(item.id)}
                  syncHealth={syncHealthMap?.get(item.id)}
                  onSelect={onSelectSkill}
                  onDelete={onDeleteItem}
                  onMarketplaceUpdate={onMarketplaceUpdate}
                />
              ))}
            </div>
          ))}
        </div>
      ) : (
      <div className="space-y-1">
        {items.map((item) => (
          <SkillRow
            key={item.id}
            item={item}
            isProject={isProject}
            isSelected={selectedSkillId === item.id}
            showLineCount={showLineCount}
            hasUpdate={updateMap?.has(item.id)}
            syncHealth={syncHealthMap?.get(item.id)}
            onSelect={onSelectSkill}
            onDelete={onDeleteItem}
            onMarketplaceUpdate={onMarketplaceUpdate}
          />
        ))}
      </div>
      )}
    </div>
  )
}

function SkillRow({
  item,
  isProject,
  isSelected,
  showLineCount,
  hasUpdate,
  syncHealth,
  onSelect,
  onDelete,
  onMarketplaceUpdate,
}: {
  item: AiConfigItem
  isProject?: boolean
  isSelected: boolean
  showLineCount: boolean
  hasUpdate?: boolean
  syncHealth?: SyncHealth
  onSelect: (id: string | null) => void
  onDelete: (id: string) => void
  onMarketplaceUpdate?: (itemId: string) => void
}) {
  const validation = getSkillValidation(item)
  const provenance = getMarketplaceProvenance(item)
  const isLibraryLinked = isProject && !provenance && item.scope === 'library'
  const hasIssues = validation && validation.status !== 'valid'

  return (
    <div
      onClick={() => onSelect(isSelected ? null : item.id)}
      className={cn(
        'group flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors',
        isSelected
          ? 'ring-1 ring-primary border-primary/50 bg-surface-3'
          : 'hover:bg-surface-3'
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium truncate">{item.slug}</span>
          {hasIssues && (
            <AlertTriangle className={cn(
              'size-3 shrink-0',
              validation.status === 'invalid' ? 'text-destructive' : 'text-amber-500'
            )} />
          )}
          {provenance && (
            <span className="flex items-center gap-1 rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">
              <Store className="size-2.5" />
              {provenance.registryName ?? 'Marketplace'}
            </span>
          )}
          {isLibraryLinked && (
            <span className="flex items-center gap-1 rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">
              <Library className="size-2.5" />
              Library
            </span>
          )}
          {hasUpdate && (
            <button
              onClick={(e) => { e.stopPropagation(); onMarketplaceUpdate?.(item.id) }}
              className="flex items-center gap-0.5 text-[10px] text-amber-500 hover:text-amber-400 shrink-0"
              title="Update available from marketplace"
            >
              <ArrowUpCircle className="size-3" />
            </button>
          )}
        </div>
      </div>
      {syncHealth === 'stale' && (
        <StatusBadge syncHealth={syncHealth} />
      )}
      {showLineCount && (
        <span className="shrink-0 text-[10px] text-muted-foreground/60">{item.content.split('\n').length}L</span>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={(e) => { e.stopPropagation(); onDelete(item.id) }}
        className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
      >
        <Trash2 className="size-3" />
      </Button>
    </div>
  )
}
