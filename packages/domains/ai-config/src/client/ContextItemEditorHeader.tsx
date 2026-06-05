import { ArrowUpCircle, Library, Link2Off, Store } from 'lucide-react'
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import type { AiConfigItem, SkillUpdateInfo } from '../shared'
import { getMarketplaceProvenance } from './skill-validation'

type MarketplaceProvenance = NonNullable<ReturnType<typeof getMarketplaceProvenance>>

interface ContextItemEditorHeaderProps {
  provenance: MarketplaceProvenance | null
  isLibraryLinked: boolean
  item: AiConfigItem
  updateInfo?: SkillUpdateInfo | null
  onMarketplaceUpdate?: () => void
  onUnlink?: () => void
  navigateToMarketplaceEntry: (registryId: string, entryId: string) => void
  navigateToLibrarySkill: (id: string) => void
}

export function ContextItemEditorHeader({
  provenance,
  isLibraryLinked,
  item,
  updateInfo,
  onMarketplaceUpdate,
  onUnlink,
  navigateToMarketplaceEntry,
  navigateToLibrarySkill
}: ContextItemEditorHeaderProps) {
  return (
    <>
      {provenance && (
        <div className="flex items-center justify-between gap-2 rounded border border-border/50 bg-surface-3 px-2.5 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Store className="size-3" />
              Marketplace
            </span>
            <span>
              From{' '}
              <button
                onClick={() =>
                  navigateToMarketplaceEntry(provenance.registryId, provenance.entryId)
                }
                className="font-medium text-foreground hover:underline"
              >
                {item.slug}
              </button>{' '}
              in the{' '}
              <button
                onClick={() =>
                  navigateToMarketplaceEntry(provenance.registryId, provenance.entryId)
                }
                className="font-medium text-foreground hover:underline"
              >
                {provenance.registryName ?? 'Marketplace'}
              </button>{' '}
              registry
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {updateInfo && onMarketplaceUpdate ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px] gap-1 text-amber-500 border-amber-500/30"
                    onClick={onMarketplaceUpdate}
                    data-testid="context-item-editor-sync-marketplace"
                  >
                    <ArrowUpCircle className="size-3" />
                    Sync
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Update to the latest marketplace version</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[11px] gap-1 pointer-events-none"
                      disabled
                      data-testid="context-item-editor-sync-marketplace"
                    >
                      <ArrowUpCircle className="size-3" />
                      Sync
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Up to date with marketplace</TooltipContent>
              </Tooltip>
            )}
            {onUnlink && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px] gap-1"
                    onClick={onUnlink}
                    data-testid="context-item-editor-unlink-marketplace"
                  >
                    <Link2Off className="size-3" />
                    Unlink
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Convert to editable local copy</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[11px] gap-1 ml-2"
                  onClick={() =>
                    navigateToMarketplaceEntry(provenance.registryId, provenance.entryId)
                  }
                  data-testid="context-item-editor-go-to-source"
                >
                  <Store className="size-3" />
                  Go to source
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open in {provenance.registryName ?? 'Marketplace'}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}

      {isLibraryLinked && (
        <div className="flex items-center justify-between gap-2 rounded border border-border/50 bg-surface-3 px-2.5 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Library className="size-3" />
              Library
            </span>
            <span>
              From{' '}
              <button
                onClick={() => navigateToLibrarySkill(item.id)}
                className="font-medium text-foreground hover:underline"
              >
                {item.slug}
              </button>{' '}
              in the{' '}
              <button
                onClick={() => navigateToLibrarySkill(item.id)}
                className="font-medium text-foreground hover:underline"
              >
                library
              </button>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px] gap-1 pointer-events-none"
                    disabled
                    data-testid="context-item-editor-sync-library"
                  >
                    <ArrowUpCircle className="size-3" />
                    Sync
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>Up to date with library</TooltipContent>
            </Tooltip>
            {onUnlink && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px] gap-1"
                    onClick={onUnlink}
                    data-testid="context-item-editor-unlink-library"
                  >
                    <Link2Off className="size-3" />
                    Unlink
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Remove from project</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[11px] gap-1 ml-2"
                  onClick={() => navigateToLibrarySkill(item.id)}
                  data-testid="context-item-editor-go-to-source"
                >
                  <Library className="size-3" />
                  Go to source
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open in library</TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}
    </>
  )
}
