import { ArrowUpCircle, Circle, Store, Trash2, AlertTriangle } from 'lucide-react'
import { Button, cn } from '@slayzone/ui'
import { getSkillValidation, getMarketplaceProvenance } from './skill-validation'
import { useContextManagerStore } from './useContextManagerStore'
import type { AiConfigItem, SkillUpdateInfo } from '../shared'
import type { UnmanagedSkillRow } from './unmanaged-skills'

interface SkillListViewProps {
  items: AiConfigItem[]
  unmanagedItems?: UnmanagedSkillRow[]
  selectedSkillId: string | null
  onSelectSkill: (id: string | null) => void
  onDeleteItem: (id: string) => void
  updateMap?: Map<string, SkillUpdateInfo>
  onMarketplaceUpdate?: (itemId: string) => void
}

export function SkillListView({
  items,
  unmanagedItems,
  selectedSkillId,
  onSelectSkill,
  onDeleteItem,
  updateMap,
  onMarketplaceUpdate,
}: SkillListViewProps) {
  const showLineCount = useContextManagerStore((s) => s.showLineCount)
  const totalCount = items.length + (unmanagedItems?.length ?? 0)

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{totalCount} skill{totalCount !== 1 ? 's' : ''}</p>

      {totalCount === 0 && (
        <p className="text-xs text-muted-foreground py-8 text-center">
          No skills yet. Create one to get started.
        </p>
      )}

      <div className="space-y-1">
        {items.map((item) => {
          const validation = getSkillValidation(item)
          const provenance = getMarketplaceProvenance(item)
          const hasUpdate = updateMap?.has(item.id)
          const isSelected = selectedSkillId === item.id
          const hasIssues = validation && validation.status !== 'valid'

          return (
            <div
              key={item.id}
              onClick={() => onSelectSkill(isSelected ? null : item.id)}
              className={cn(
                'group flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors',
                isSelected
                  ? 'ring-1 ring-primary border-primary/50 bg-surface-1'
                  : 'hover:bg-surface-1'
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
                    <span className="flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">
                      <Store className="size-2.5" />
                      {provenance.registryName ?? 'Marketplace'}
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
                {item.name !== item.slug && (
                  <p className="text-xs text-muted-foreground truncate">{item.name}</p>
                )}
              </div>
              {showLineCount && (
                <span className="shrink-0 text-[10px] text-muted-foreground/60">{item.content.split('\n').length}L</span>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) => { e.stopPropagation(); onDeleteItem(item.id) }}
                className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          )
        })}

        {unmanagedItems && unmanagedItems.length > 0 && unmanagedItems.map((item) => (
          <div
            key={`unmanaged-${item.slug}`}
            className="flex items-center gap-3 rounded-lg border border-dashed px-3 py-2"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium truncate">{item.slug}</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">
                  <Circle className="size-2" />
                  On disk
                </span>
              </div>
              <p className="text-xs text-muted-foreground truncate">
                {item.locations[0]?.relativePath}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
