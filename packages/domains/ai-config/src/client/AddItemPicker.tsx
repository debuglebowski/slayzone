import { useEffect, useMemo, useState } from 'react'
import { Library, Plus, Sparkles } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, cn } from '@slayzone/ui'
import { buildDefaultSkillContent } from '../shared'
import type { AiConfigItem, AiConfigItemType, CliProvider } from '../shared'
import { PROVIDER_PATHS } from '../shared/provider-registry'

interface AddItemPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  type: AiConfigItemType
  projectId: string
  projectPath: string
  enabledProviders: CliProvider[]
  existingLinks: string[]
  onAdded: () => void
}

function providerSupportsType(provider: CliProvider): boolean {
  return !!PROVIDER_PATHS[provider]?.skillsDir
}

function nextAvailableSlug(base: string, existingSlugs: Set<string>): string {
  if (!existingSlugs.has(base)) return base
  let index = 2
  while (existingSlugs.has(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}

type Step = 'choose' | 'library'

export function AddItemPicker({
  open, onOpenChange, type, projectId, projectPath,
  enabledProviders, existingLinks, onAdded
}: AddItemPickerProps) {
  const [step, setStep] = useState<Step>('choose')
  const [globalItems, setGlobalItems] = useState<AiConfigItem[]>([])
  const [loading, setLoading] = useState(false)

  // Reset step when dialog opens
  useEffect(() => {
    if (open) {
      setStep('choose')
    }
  }, [open])

  // Fetch library items when entering library step
  useEffect(() => {
    if (!open || step !== 'library') return
    void (async () => {
      const items = await window.api.aiConfig.listItems({ scope: 'global', type })
      setGlobalItems(items)
    })()
  }, [open, step, type])

  const compatibleProviders = useMemo(
    () => enabledProviders.filter((provider) => providerSupportsType(provider)),
    [enabledProviders]
  )
  const canLinkFromLibrary = compatibleProviders.length > 0

  const handleSelectGlobal = async (item: AiConfigItem) => {
    if (!canLinkFromLibrary) return
    if (existingLinks.includes(item.id)) return
    setLoading(true)
    try {
      await window.api.aiConfig.loadGlobalItem({
        projectId,
        projectPath,
        itemId: item.id,
        providers: compatibleProviders
      })
      onAdded()
      onOpenChange(false)
    } finally {
      setLoading(false)
    }
  }

  const handleCreateLocal = async () => {
    setLoading(true)
    try {
      const existingItems = await window.api.aiConfig.listItems({
        scope: 'project',
        projectId,
        type
      })
      const existingSlugs = new Set(existingItems.map((item) => item.slug))
      const slug = nextAvailableSlug('new-skill', existingSlugs)
      await window.api.aiConfig.createItem({
        type,
        scope: 'project',
        projectId,
        slug,
        content: buildDefaultSkillContent(slug)
      })
      onAdded()
      onOpenChange(false)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">
            {step === 'choose' ? 'Add Skill' : 'Add from Library'}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            {step === 'choose' ? 'Create a new skill or link one from your library' : 'Link a global skill into this project'}
          </p>
        </DialogHeader>

        {step === 'choose' ? (
          <div className="border-t">
            <button
              className="flex w-full items-start gap-3 border-b border-border/40 px-5 py-3 text-left transition-colors hover:bg-muted/40"
              onClick={handleCreateLocal}
              disabled={loading}
            >
              <Plus className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Create new</p>
                <p className="mt-0.5 text-xs text-muted-foreground">New project skill</p>
              </div>
            </button>
            <button
              className={cn(
                'flex w-full items-start gap-3 px-5 py-3 text-left transition-colors',
                canLinkFromLibrary ? 'hover:bg-muted/40' : 'opacity-40 cursor-not-allowed'
              )}
              onClick={() => canLinkFromLibrary && setStep('library')}
              disabled={!canLinkFromLibrary}
            >
              <Library className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">From library</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {canLinkFromLibrary ? 'Link a global skill' : 'No compatible providers'}
                </p>
              </div>
            </button>
          </div>
        ) : (
          <div className="border-t max-h-72 overflow-y-auto">
            {[...globalItems].sort((a, b) => a.slug.localeCompare(b.slug)).map(item => {
              const linked = existingLinks.includes(item.id)
              return (
                <button
                  key={item.id}
                  disabled={linked || loading}
                  onClick={() => handleSelectGlobal(item)}
                  data-testid={`add-item-option-${item.slug}`}
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
            {globalItems.length === 0 && (
              <div className="px-5 py-8 text-center">
                <p className="text-sm text-muted-foreground">No library skills available</p>
                <p className="mt-1 text-xs text-muted-foreground/60">Create one in the Library section first</p>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
