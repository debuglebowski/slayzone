import { FolderPlus, Library, RefreshCw, X } from 'lucide-react'
import { Button } from '@slayzone/ui'
import type { SkillRegistryEntry } from '../shared'

interface SkillEntryCardProps {
  entry: SkillRegistryEntry
  onAddToLibrary: (entryId: string) => void
  onAddToProject: (entryId: string) => void
  onUpdate: (itemId: string, entryId: string) => void
  onUninstall: (itemId: string) => void
  onPreview: (entry: SkillRegistryEntry) => void
  hasProject: boolean
  installing?: boolean
}

export function SkillEntryCard({ entry, onAddToLibrary, onAddToProject, onUpdate, onUninstall, onPreview, hasProject, installing }: SkillEntryCardProps) {
  const isInLibrary = !!entry.installed_library_item_id
  const isInProject = !!entry.installed_project_item_id
  const hasUpdate = !!entry.has_update

  return (
    <div
      className="rounded-lg border border-border/50 bg-surface-3 p-4 flex flex-col gap-3 cursor-pointer hover:border-border transition-colors"
      onClick={() => onPreview(entry)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium truncate">{entry.name}</h3>
          {entry.registry_name && (
            <p className="text-[11px] text-muted-foreground/60">{entry.registry_name}</p>
          )}
        </div>
        {entry.category && (
          <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-[10px] text-muted-foreground">
            {entry.category}
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground line-clamp-2 flex-1">{entry.description}</p>

      <div className="flex items-center justify-between pt-1 border-t border-border/30">
        {entry.author && (
          <span className="text-[11px] text-muted-foreground/60">by {entry.author}</span>
        )}
        <div className="ml-auto flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {isInLibrary ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
              onClick={() => onUninstall(entry.installed_library_item_id!)}
              disabled={installing}
            >
              <X className="size-3" />
              Remove from library
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5"
              onClick={() => onAddToLibrary(entry.id)}
              disabled={installing}
            >
              <Library className="size-3" />
              Add to library
            </Button>
          )}
          {isInProject ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
              onClick={() => onUninstall(entry.installed_project_item_id!)}
              disabled={installing}
            >
              <X className="size-3" />
              Remove from project
            </Button>
          ) : hasProject ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5"
              onClick={() => onAddToProject(entry.id)}
              disabled={installing}
            >
              <FolderPlus className="size-3" />
              Add to project
            </Button>
          ) : null}
          {(isInLibrary || isInProject) && hasUpdate && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5 text-amber-500 border-amber-500/30"
              onClick={() => onUpdate(entry.installed_item_id!, entry.id)}
              disabled={installing}
            >
              <RefreshCw className="size-3" />
              Update
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
