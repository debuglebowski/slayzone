import { ExternalLink } from 'lucide-react'
import type { SkillRegistry } from '../shared'

interface MarketplaceRegistryGridProps {
  registries: SkillRegistry[]
  onDrillIn: (registryId: string) => void
}

export function MarketplaceRegistryGrid({ registries, onDrillIn }: MarketplaceRegistryGridProps) {
  return (
    <div
      className="grid gap-3 content-start overflow-y-auto flex-1"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))' }}
    >
      {registries
        .filter((r) => r.enabled)
        .map((reg) => (
          <button
            key={reg.id}
            onClick={() => onDrillIn(reg.id)}
            className="rounded-lg border border-border/50 bg-surface-3 p-4 flex flex-col gap-2 text-left hover:border-border transition-colors h-fit"
          >
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-medium truncate">{reg.name}</h3>
              <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-[10px] text-muted-foreground">
                {reg.source_type}
              </span>
            </div>
            {reg.description && (
              <p className="text-xs text-muted-foreground line-clamp-2">{reg.description}</p>
            )}
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground/60 mt-auto pt-2 border-t border-border/30">
              <span>{reg.entry_count ?? 0} skills</span>
              {reg.github_owner && (
                <span className="flex items-center gap-1">
                  <ExternalLink className="size-2.5" />
                  {reg.github_owner}/{reg.github_repo}
                </span>
              )}
              {reg.last_synced_at && (
                <span>Synced {new Date(reg.last_synced_at).toLocaleDateString()}</span>
              )}
            </div>
          </button>
        ))}
    </div>
  )
}
