import { Check, FolderPlus, Library, RefreshCw } from 'lucide-react'
import { Button, cn, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@slayzone/ui'
import type { SkillRegistryEntry } from '../shared'

interface SkillPreviewDialogProps {
  entry: SkillRegistryEntry | null
  onOpenChange: (open: boolean) => void
  onAddToLibrary: (entryId: string) => void
  onAddToProject: (entryId: string) => void
  onUpdate: (itemId: string, entryId: string) => void
  hasProject: boolean
  installing?: boolean
}

export function SkillPreviewDialog({ entry, onOpenChange, onAddToLibrary, onAddToProject, onUpdate, hasProject, installing }: SkillPreviewDialogProps) {
  if (!entry) return null

  const isInstalled = !!entry.installed
  const hasUpdate = !!entry.has_update

  return (
    <Dialog open={!!entry} onOpenChange={onOpenChange}>
      <DialogContent className="w-[80vw] h-[80vh] max-w-none flex flex-col">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3 pr-6">
            <div className="min-w-0">
              <DialogTitle>{entry.name}</DialogTitle>
              <p className="text-xs text-muted-foreground mt-1">{entry.description}</p>
            </div>
            {entry.category && (
              <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-[10px] text-muted-foreground">
                {entry.category}
              </span>
            )}
          </div>
          {(entry.author || entry.registry_name) && (
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground/60">
              {entry.author && <span>by {entry.author}</span>}
              {entry.registry_name && <span>{entry.registry_name}</span>}
            </div>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 rounded-md border border-border/50 bg-surface-1">
          <pre className="p-4 text-xs text-foreground/80 whitespace-pre-wrap break-words font-mono leading-relaxed">
            {entry.content}
          </pre>
        </div>

        <DialogFooter>
          <div className="flex items-center gap-1.5">
            {!isInstalled && (
              <>
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
                {hasProject && (
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
                )}
              </>
            )}
            {isInstalled && hasUpdate && (
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
            {isInstalled && !hasUpdate && (
              <span className={cn('flex items-center gap-1 text-xs text-emerald-500')}>
                <Check className="size-3" />
                Installed
              </span>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
