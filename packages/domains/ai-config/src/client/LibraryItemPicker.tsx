import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, cn } from '@slayzone/ui'
import type { AiConfigItem, CliProvider } from '../shared'

interface LibraryItemPickerProps {
  projectId: string
  projectPath: string
  existingLinks: string[]
  type?: 'skill'
  onLoaded: () => void
  onClose: () => void
}

export function LibraryItemPicker({ projectId, projectPath, existingLinks, onLoaded, onClose }: LibraryItemPickerProps) {
  const [items, setItems] = useState<AiConfigItem[]>([])
  const [enabledProviders, setEnabledProviders] = useState<CliProvider[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    void (async () => {
      const [skills, providers] = await Promise.all([
        window.api.aiConfig.listItems({ scope: 'library', type: 'skill' }),
        window.api.aiConfig.getProjectProviders(projectId)
      ])
      setItems(skills)
      setEnabledProviders(providers)
    })()
  }, [projectId])

  const alreadyLinked = (id: string) => existingLinks.includes(id)

  const handleSelect = async (item: AiConfigItem) => {
    if (alreadyLinked(item.id)) return
    setLoading(true)
    try {
      await window.api.aiConfig.loadLibraryItem({
        projectId,
        projectPath,
        itemId: item.id,
        providers: enabledProviders
      })
      onLoaded()
    } catch (err) {
      console.error('Failed to load item:', err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">Add from Library</DialogTitle>
          <p className="text-xs text-muted-foreground">Link a library skill into this project</p>
        </DialogHeader>
        <div className="border-t max-h-72 overflow-y-auto">
          {items.map((item) => {
            const linked = alreadyLinked(item.id)
            return (
              <button
                key={item.id}
                disabled={linked || loading}
                onClick={() => handleSelect(item)}
                className={cn(
                  'flex w-full items-start gap-3 border-b border-border/40 last:border-0 px-5 py-3 text-left transition-colors',
                  linked
                    ? 'cursor-not-allowed opacity-40'
                    : 'hover:bg-muted/40'
                )}
              >
                <Sparkles className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">{item.slug}</p>
                    {linked && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">Linked</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                    {item.content.slice(0, 120) || '(empty)'}
                  </p>
                </div>
              </button>
            )
          })}
          {items.length === 0 && (
            <div className="px-5 py-8 text-center">
              <p className="text-sm text-muted-foreground">No library skills available</p>
              <p className="mt-1 text-xs text-muted-foreground/60">Create one in the Library section first</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
