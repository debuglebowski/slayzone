import { useEffect, useState, type ChangeEvent } from 'react'
import { ArrowUpCircle, Library, Link2Off, Lock, Store, Trash2 } from 'lucide-react'
import { Button, Input, Label, Textarea, Tooltip, TooltipContent, TooltipTrigger } from '@slayzone/ui'
import { repairSkillFrontmatter } from '../shared'
import type { AiConfigItem, SkillUpdateInfo, SkillValidationState, UpdateAiConfigItemInput } from '../shared'
import { getMarketplaceProvenance, getSkillFrontmatterActionLabel, getSkillValidation } from './skill-validation'
import { useContextManagerStore } from './useContextManagerStore'

interface ContextItemEditorProps {
  item: AiConfigItem
  validationState?: SkillValidationState | null
  onUpdate: (patch: Omit<UpdateAiConfigItemInput, 'id'>) => Promise<void>
  onDelete: () => Promise<void>
  onClose: () => void
  readOnly?: boolean
  updateInfo?: SkillUpdateInfo | null
  onMarketplaceUpdate?: () => void
  onUnlink?: () => void
}

export function ContextItemEditor({ item, validationState, onUpdate, onDelete, onClose, readOnly, updateInfo, onMarketplaceUpdate, onUnlink }: ContextItemEditorProps) {
  const provenance = getMarketplaceProvenance(item)
  const isMarketplaceBound = !!provenance
  const isLibraryLinked = !isMarketplaceBound && !!readOnly && item.scope === 'library'
  const effectiveReadOnly = readOnly || isMarketplaceBound
  const navigateToMarketplaceEntry = useContextManagerStore((s) => s.navigateToMarketplaceEntry)
  const navigateToLibrarySkill = useContextManagerStore((s) => s.navigateToLibrarySkill)
  const [slug, setSlug] = useState(item.slug)
  const [content, setContent] = useState(item.content)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const effectiveValidation = validationState ?? getSkillValidation({
    type: item.type,
    slug: item.slug,
    content
  })

  useEffect(() => {
    setSlug(item.slug)
    setContent(item.content)
  }, [item.slug, item.content])

  const save = async (patch: Omit<UpdateAiConfigItemInput, 'id'>) => {
    setSaving(true)
    setError(null)
    try {
      await onUpdate(patch)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const isJson = slug.endsWith('.json')
  const jsonError = isJson && content.trim()
    ? (() => { try { JSON.parse(content); return null } catch (e) { return (e as Error).message } })()
    : null

  const fixFrontmatterLabel = getSkillFrontmatterActionLabel(effectiveValidation)

  const handleFixFrontmatter = async () => {
    const nextContent = repairSkillFrontmatter(item.slug, content)
    setContent(nextContent)
    await save({ content: nextContent })
  }

  return (
    <div className="flex-1 flex flex-col space-y-3">
      <div className="space-y-1">
        <Label className="text-xs">Filename</Label>
        <Input
          data-testid="context-item-editor-slug"
          className={`font-mono text-sm ${effectiveReadOnly ? 'opacity-50 cursor-not-allowed focus-visible:ring-0 focus-visible:border-input' : ''}`}
          placeholder="my-skill.md"
          value={slug}
          readOnly={effectiveReadOnly}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            setSlug(e.target.value)
            setError(null)
          }}
          onBlur={(e: ChangeEvent<HTMLInputElement>) => {
            if (effectiveReadOnly) return
            const nextSlug = e.currentTarget.value
            setSlug(nextSlug)
            void save({ slug: nextSlug })
          }}
        />
      </div>

      {provenance && (
        <div className="flex items-center justify-between gap-2 rounded border border-border/50 bg-surface-3 px-2.5 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Store className="size-3" />
              Marketplace
            </span>
            <span>
              From <button onClick={() => navigateToMarketplaceEntry(provenance.registryId, provenance.entryId)} className="font-medium text-foreground hover:underline">{item.slug}</button> in the <button onClick={() => navigateToMarketplaceEntry(provenance.registryId, provenance.entryId)} className="font-medium text-foreground hover:underline">{provenance.registryName ?? 'Marketplace'}</button> registry
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
                  onClick={() => navigateToMarketplaceEntry(provenance.registryId, provenance.entryId)}
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
              From <button onClick={() => navigateToLibrarySkill(item.id)} className="font-medium text-foreground hover:underline">{item.slug}</button> in the <button onClick={() => navigateToLibrarySkill(item.id)} className="font-medium text-foreground hover:underline">library</button>
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

      <div className="flex-1 flex flex-col space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs">Content</Label>
          {isLibraryLinked && (
            <div className="flex items-center gap-1.5 text-[11px] text-amber-500">
              <Lock className="size-3" />
              <span>Open this skill in the library to edit it.</span>
            </div>
          )}
        </div>
        <Textarea
          data-testid="context-item-editor-content"
          className={`flex-1 min-h-48 max-h-none field-sizing-fixed font-mono text-sm resize-none ${effectiveReadOnly ? 'opacity-50 cursor-not-allowed focus-visible:ring-0 focus-visible:border-input' : ''}`}
          placeholder="Write your content here..."
          value={content}
          readOnly={effectiveReadOnly}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
            setContent(e.target.value)
            setError(null)
          }}
          onBlur={(e: ChangeEvent<HTMLTextAreaElement>) => {
            if (effectiveReadOnly) return
            const nextContent = e.currentTarget.value
            setContent(nextContent)
            void save({ content: nextContent })
          }}
        />
      </div>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      {effectiveValidation && effectiveValidation.status !== 'valid' && (
        <div className="rounded border border-destructive/20 bg-destructive/5 px-2.5 py-2">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs font-medium text-destructive">
              {effectiveValidation.status === 'invalid' ? 'Frontmatter is invalid' : 'Frontmatter warning'}
            </p>
            {fixFrontmatterLabel && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[11px]"
                data-testid="context-item-editor-fix-frontmatter"
                onClick={() => void handleFixFrontmatter()}
              >
                {fixFrontmatterLabel}
              </Button>
            )}
          </div>
          <div className="mt-1 space-y-0.5">
            {effectiveValidation.issues.map((issue, index) => (
              <p key={`${issue.code}-${index}`} className="text-[11px] text-destructive/90">
                {issue.line ? `Line ${issue.line}: ` : ''}
                {issue.message}
              </p>
            ))}
          </div>
        </div>
      )}

      {isJson && jsonError && (
        <div className="rounded border border-destructive/20 bg-destructive/5 px-2.5 py-2">
          <p className="text-[11px] text-destructive">{jsonError}</p>
        </div>
      )}
      {isJson && !jsonError && content.trim() && (
        <p className="text-[11px] text-green-600 dark:text-green-400">Valid JSON</p>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={onClose} data-testid="context-item-editor-close">
          Close
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {isMarketplaceBound
              ? 'Read-only (marketplace skill)'
              : readOnly
                ? 'Read-only (library skill)'
                : saving ? 'Saving...' : 'Autosave on blur'}
          </span>
          {!effectiveReadOnly && (
            <Button size="sm" variant="ghost" className="text-destructive" onClick={onDelete}>
              <Trash2 className="mr-1 size-3" />
              Delete
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
