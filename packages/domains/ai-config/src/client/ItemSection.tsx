import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import {
  AlertTriangle, ChevronDown, ChevronRight,
  Plus, Loader2, Trash2, X
} from 'lucide-react'
import {
  Button, IconButton, Input, Label,
  Textarea, Tooltip, TooltipContent, TooltipTrigger, cn, toast
} from '@slayzone/ui'
import { repairSkillFrontmatter } from '../shared'
import type {
  AiConfigItem, AiConfigItemType, CliProvider,
  ProjectSkillStatus, SyncHealth
} from '../shared'
import type { GlobalContextManagerSection } from './ContextManagerSettings'
import { PROVIDER_PATHS } from '../shared/provider-registry'
import { AddItemPicker } from './AddItemPicker'
import { SkillHelpCard } from './SkillHelpCard'
import { StatusBadge, ProviderFileCard } from './SyncComponents'
import { aggregateProviderSyncHealth, hasPendingProviderSync } from './sync-view-model'
import { getSkillFrontmatterActionLabel, getSkillValidation } from './skill-validation'
import type { UnmanagedSkillRow } from './unmanaged-skills'

// ============================================================
// Types & Helpers
// ============================================================

interface ItemSectionProps {
  type: AiConfigItemType
  linkedItems: ProjectSkillStatus[]
  localItems: AiConfigItem[]
  unmanagedItems: UnmanagedSkillRow[]
  enabledProviders: CliProvider[]
  projectId: string
  projectPath: string
  onOpenGlobalAiConfig?: (section: GlobalContextManagerSection) => void
  onChanged: () => void
}

interface ProviderRow {
  provider: CliProvider
  path: string
  syncHealth: SyncHealth
}

function providerSupportsType(provider: CliProvider): boolean {
  return !!PROVIDER_PATHS[provider]?.skillsDir
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toProjectRelativePath(filePath: string, projectPath: string): string {
  const normalizedFile = filePath.replace(/\\/g, '/')
  const normalizedProject = projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalizedFile.startsWith(`${normalizedProject}/`)) return filePath
  return normalizedFile.slice(normalizedProject.length + 1)
}

function renameUnmanagedSkillPath(filePath: string, oldSlug: string, newSlug: string): string | null {
  const normalizedOldSlug = escapeRegExp(oldSlug)
  const skillPathPattern = new RegExp(`[\\\\/]${normalizedOldSlug}[\\\\/]SKILL\\.md$`)
  if (skillPathPattern.test(filePath)) {
    return filePath.replace(skillPathPattern, `${filePath.includes('\\') ? '\\\\' : '/'}${newSlug}${filePath.includes('\\') ? '\\\\' : '/'}SKILL.md`)
  }

  const legacyPathPattern = new RegExp(`[\\\\/]${normalizedOldSlug}\\.md$`)
  if (legacyPathPattern.test(filePath)) {
    return filePath.replace(legacyPathPattern, `${filePath.includes('\\') ? '\\\\' : '/'}${newSlug}.md`)
  }

  return null
}

// ============================================================
// Hook: useSkillItem
// ============================================================

function useSkillItem({
  item, providers, enabledProviders, isLocal, projectId, projectPath, onChanged
}: {
  item: AiConfigItem
  providers: ProjectSkillStatus['providers']
  enabledProviders: CliProvider[]
  isLocal: boolean
  projectId: string
  projectPath: string
  onChanged: () => void
}) {
  const [slug, setSlugRaw] = useState(item.slug)
  const [content, setContent] = useState(item.content)
  const validation = getSkillValidation({
    type: item.type,
    slug: item.slug,
    content
  })
  const hasValidationErrors = validation?.status === 'invalid'
  const [slugDirty, setSlugDirty] = useState(false)
  const [savingSlug, setSavingSlug] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [expandedProviders, setExpandedProviders] = useState<Set<CliProvider>>(new Set())
  const [diskContents, setDiskContents] = useState<Partial<Record<CliProvider, string>>>({})
  const [expectedContents, setExpectedContents] = useState<Partial<Record<CliProvider, string>>>({})
  const [syncingProvider, setSyncingProvider] = useState<CliProvider | null>(null)
  const [pullingProvider, setPullingProvider] = useState<CliProvider | null>(null)
  const [syncingAll, setSyncingAll] = useState(false)

  useEffect(() => {
    setContent(item.content)
    setSlugRaw(item.slug)
    setSlugDirty(false)
  }, [item.content, item.slug])

  const providerRows: ProviderRow[] = enabledProviders
    .filter(p => {
      if (!providerSupportsType(p)) return false
      if (isLocal) return true
      const info = providers[p]
      return info?.syncReason !== 'not_linked'
    })
    .map(p => {
      const info = providers[p]
      const path = info?.path ?? `${PROVIDER_PATHS[p]?.skillsDir}/${item.slug}/SKILL.md`
      const syncHealth = info?.syncHealth ?? 'not_synced'
      return { provider: p, path, syncHealth }
    })

  const saveContent = useCallback(async (text: string) => {
    try {
      await window.api.aiConfig.updateItem({ id: item.id, content: text })
      setExpectedContents({})
      onChanged()
    } catch { /* silent */ }
  }, [item.id, onChanged])

  const handleContentChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    setContent(text)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void saveContent(text), 800)
  }

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
  }, [])

  const handleSlugSave = async () => {
    setSavingSlug(true)
    try {
      await window.api.aiConfig.updateItem({ id: item.id, slug })
      setSlugDirty(false)
      setExpectedContents({})
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Rename failed')
    } finally {
      setSavingSlug(false)
    }
  }

  const handleRevert = async () => {
    try {
      await window.api.aiConfig.syncLinkedFile(projectId, projectPath, item.id)
      toast.success(`Reverted ${item.slug} to global`)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Revert failed')
    }
  }

  const loadDiskAndExpected = useCallback(async (provider: CliProvider) => {
    const [disk, expected] = await Promise.all([
      window.api.aiConfig.readProviderSkill(projectPath, provider, item.id),
      window.api.aiConfig.getExpectedSkillContent(projectPath, provider, item.id),
    ])
    setDiskContents(prev => ({ ...prev, [provider]: disk.exists ? disk.content : '' }))
    setExpectedContents(prev => ({ ...prev, [provider]: expected }))
  }, [projectPath, item.id])

  const toggleExpanded = (provider: CliProvider) => {
    setExpandedProviders(prev => {
      const next = new Set(prev)
      if (next.has(provider)) {
        next.delete(provider)
      } else {
        next.add(provider)
        void loadDiskAndExpected(provider)
      }
      return next
    })
  }

  const handlePush = async (provider: CliProvider) => {
    setSyncingProvider(provider)
    try {
      await window.api.aiConfig.syncLinkedFile(projectId, projectPath, item.id, provider)
      const expected = expectedContents[provider]
      if (expected !== undefined) {
        setDiskContents(prev => ({ ...prev, [provider]: expected }))
      }
      onChanged()
    } finally {
      setSyncingProvider(null)
    }
  }

  const handlePull = async (provider: CliProvider) => {
    setPullingProvider(provider)
    try {
      await window.api.aiConfig.pullProviderSkill(projectId, projectPath, provider, item.id)
      onChanged()
    } finally {
      setPullingProvider(null)
    }
  }

  const handleSyncAll = async () => {
    setSyncingAll(true)
    try {
      await window.api.aiConfig.syncLinkedFile(projectId, projectPath, item.id)
      const updated: Partial<Record<CliProvider, string>> = {}
      for (const { provider } of providerRows) {
        const expected = expectedContents[provider]
        if (expected !== undefined) updated[provider] = expected
      }
      setDiskContents(prev => ({ ...prev, ...updated }))
      onChanged()
    } finally {
      setSyncingAll(false)
    }
  }

  const handleFixFrontmatter = async () => {
    const nextContent = repairSkillFrontmatter(item.slug, content)
    setContent(nextContent)
    try {
      await window.api.aiConfig.updateItem({ id: item.id, content: nextContent })
      setExpectedContents({})
      onChanged()
    } catch {
      toast.error('Failed to update skill frontmatter')
    }
  }

  return {
    item, slug, content, slugDirty, savingSlug, isLocal,
    validation,
    hasValidationErrors,
    providerRows, expandedProviders, diskContents, expectedContents,
    syncingProvider, pullingProvider, syncingAll,
    setSlug: (v: string) => { setSlugRaw(v); setSlugDirty(v !== item.slug) },
    handleContentChange, handleSlugSave, handleRevert,
    handleFixFrontmatter,
    toggleExpanded, handlePush, handlePull, handleSyncAll,
  }
}

// ============================================================
// Skill item detail
// ============================================================

function SkillItemDetail({ item, providers, enabledProviders, isLocal, projectId, projectPath, onChanged, onRemove, onGoToGlobal }: {
  item: AiConfigItem; providers: ProjectSkillStatus['providers']; enabledProviders: CliProvider[]
  isLocal: boolean; projectId: string; projectPath: string; onChanged: () => void
  onRemove: () => void
  onGoToGlobal?: () => void
}) {
  const sk = useSkillItem({ item, providers, enabledProviders, isLocal, projectId, projectPath, onChanged })
  const [expanded, setExpanded] = useState(false)
  const status = aggregateProviderSyncHealth(providers)
  const hasPendingSync = hasPendingProviderSync(sk.providerRows.map((row) => row.syncHealth))
  const validationStatus = sk.validation?.status === 'invalid' || sk.validation?.status === 'warning'
    ? sk.validation.status
    : null
  const fixFrontmatterLabel = getSkillFrontmatterActionLabel(sk.validation)

  const handleToggleExpanded = () => setExpanded((prev) => !prev)

  return (
    <div
      data-testid={`project-context-item-skill-${item.slug}`}
      className={cn(
        'rounded-md border overflow-hidden',
        expanded && 'border-primary/30'
      )}
    >
      {/* Collapsed row */}
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 transition-colors cursor-pointer',
          expanded ? 'border-b border-primary/20' : 'hover:bg-muted/30'
        )}
        onClick={handleToggleExpanded}
      >
        {expanded
          ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        }
        <span className="flex-1 truncate font-mono text-xs">
          {item.slug}
          {isLocal && <span className="ml-1.5 font-sans text-[10px] text-muted-foreground">(local)</span>}
        </span>
        {validationStatus && (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
              validationStatus === 'invalid'
                ? 'bg-destructive/15 text-destructive'
                : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
            )}
          >
            <AlertTriangle className="size-3" />
            {validationStatus === 'invalid' ? 'Invalid frontmatter' : 'Frontmatter warning'}
          </span>
        )}
        <StatusBadge syncHealth={status} />
        <IconButton
          aria-label="Remove skill"
          size="icon-sm" variant="ghost"
          className="size-6 text-muted-foreground hover:text-destructive shrink-0"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
        >
          <X className="size-3" />
        </IconButton>
      </div>

      {/* Expanded: stacked edit + sync sections */}
      {expanded && (
        <div className="p-4 space-y-3">
          <div
            data-testid={`skill-edit-section-${item.slug}`}
            className="space-y-3"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-lg font-semibold leading-tight">Edit</p>
              {!sk.isLocal && (
                <div className="flex items-center gap-2">
                  {onGoToGlobal && (
                    <Button
                      data-testid={`skill-go-to-global-${item.slug}`}
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      onClick={onGoToGlobal}
                    >
                      Go to global
                    </Button>
                  )}
                  <Button
                    data-testid="skill-detail-revert"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    onClick={sk.handleRevert}
                  >
                    Revert to global
                  </Button>
                </div>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Filename</Label>
              <div className="flex items-center gap-2">
                <Input
                  data-testid="skill-detail-filename"
                  className="font-mono text-xs !bg-surface-1 dark:!bg-surface-1 shadow-none"
                  placeholder="my-skill"
                  value={sk.slug}
                  onChange={(e) => sk.setSlug(e.target.value)}
                />
                {sk.slugDirty && (
                  <Button data-testid="skill-detail-rename" size="sm" onClick={sk.handleSlugSave} disabled={sk.savingSlug}>
                    {sk.savingSlug ? 'Renaming...' : 'Rename'}
                  </Button>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <Textarea
                data-testid="skill-detail-content"
                className="min-h-[260px] max-h-[40vh] field-sizing-content resize-y font-mono text-sm !bg-surface-1 dark:!bg-surface-1 shadow-none"
                placeholder="Write your skill content here."
                value={sk.content}
                onChange={sk.handleContentChange}
              />
              {sk.validation && sk.validation.status !== 'valid' && (
                <div className="rounded border border-destructive/20 bg-destructive/5 px-2.5 py-2">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-xs font-medium text-destructive">
                      {sk.validation.status === 'invalid' ? 'Frontmatter is invalid' : 'Frontmatter warning'}
                    </p>
                    {fixFrontmatterLabel && (
                      <Button
                        data-testid="skill-detail-fix-frontmatter"
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => void sk.handleFixFrontmatter()}
                      >
                        {fixFrontmatterLabel}
                      </Button>
                    )}
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {sk.validation.issues.map((issue, index) => (
                      <p key={`${issue.code}-${index}`} className="text-[11px] text-destructive/90">
                        {issue.line ? `Line ${issue.line}: ` : ''}
                        {issue.message}
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div
            data-testid={`skill-sync-section-${item.slug}`}
            className="space-y-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <p className="text-lg font-semibold leading-tight">Sync</p>
                {status === 'stale' && (
                  <span className="inline-flex size-2 rounded-full bg-amber-500" />
                )}
              </div>
              {sk.providerRows.length > 1 && (hasPendingSync || sk.syncingAll || sk.hasValidationErrors) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      data-testid={`skill-push-all-${sk.item.slug}`}
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      onClick={sk.handleSyncAll}
                      disabled={sk.syncingAll || !!sk.syncingProvider || sk.hasValidationErrors}
                    >
                      {sk.syncingAll && <Loader2 className="size-3.5 animate-spin" />}
                      Config → All Files
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {sk.hasValidationErrors
                      ? 'Fix frontmatter errors before syncing to files.'
                      : 'Overwrite all provider skill files on disk'}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>

            {sk.providerRows.length > 0 ? (
              <>
                <div className="space-y-2">
                  {sk.providerRows.map(row => (
                    <ProviderFileCard
                      key={row.provider}
                      testIdPrefix="skill"
                      testIdSuffix={sk.item.slug}
                      provider={row.provider}
                      path={row.path}
                      syncHealth={row.syncHealth}
                      isPushing={sk.syncingProvider === row.provider}
                      isPulling={sk.pullingProvider === row.provider}
                      isExpanded={sk.expandedProviders.has(row.provider)}
                      syncingAll={sk.syncingAll}
                      disk={sk.diskContents[row.provider]}
                      expected={sk.expectedContents[row.provider]}
                      canPush={!sk.hasValidationErrors}
                      onToggleExpand={() => sk.toggleExpanded(row.provider)}
                      onPush={() => void sk.handlePush(row.provider)}
                      onPull={() => void sk.handlePull(row.provider)}
                    />
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">No providers configured</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function UnmanagedSkillItemRow({
  item,
  projectPath,
  managingSlug,
  onManage,
  onDelete
}: {
  item: UnmanagedSkillRow
  projectPath: string
  managingSlug: string | null
  onManage: (item: UnmanagedSkillRow) => Promise<void>
  onDelete: (item: UnmanagedSkillRow) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [committedSlug, setCommittedSlug] = useState(item.slug)
  const [slug, setSlug] = useState(item.slug)
  const [content, setContent] = useState('')
  const [locations, setLocations] = useState(item.locations)
  const [loadingContent, setLoadingContent] = useState(false)
  const [savingSlug, setSavingSlug] = useState(false)
  const [savingContent, setSavingContent] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [slugDirty, setSlugDirty] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setCommittedSlug(item.slug)
    setSlug(item.slug)
    setLocations(item.locations)
    setSlugDirty(false)
  }, [item.slug, item.locations])

  const loadPrimaryContent = useCallback(async () => {
    const primary = locations[0]
    if (!primary) {
      setContent('')
      return
    }
    setLoadingContent(true)
    try {
      const text = await window.api.aiConfig.readContextFile(primary.path, projectPath)
      setContent(text)
    } catch {
      setContent('')
    } finally {
      setLoadingContent(false)
    }
  }, [locations, projectPath])

  const saveContentToDisk = useCallback(async (text: string) => {
    if (locations.length === 0) return
    setSavingContent(true)
    try {
      await Promise.all(
        locations.map((location) => window.api.aiConfig.writeContextFile(location.path, text, projectPath))
      )
    } catch {
      toast.error('Failed to save unmanaged skill')
    } finally {
      setSavingContent(false)
    }
  }, [locations, projectPath])

  const handleToggleExpanded = () => {
    setExpanded((prev) => {
      const next = !prev
      if (next) void loadPrimaryContent()
      return next
    })
  }

  const handleContentChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    setContent(text)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void saveContentToDisk(text), 800)
  }

  const handleSlugChange = (nextValue: string) => {
    setSlug(nextValue)
    setSlugDirty(normalizeSlug(nextValue) !== committedSlug)
  }

  const handleSlugSave = async () => {
    const normalized = normalizeSlug(slug)
    if (normalized === committedSlug) {
      setSlug(normalized)
      setSlugDirty(false)
      return
    }

    setSavingSlug(true)
    try {
      const renamedLocations = locations.map((location) => {
        const nextPath = renameUnmanagedSkillPath(location.path, committedSlug, normalized)
        if (!nextPath) throw new Error(`Could not rename unmanaged path: ${location.relativePath}`)
        return {
          ...location,
          path: nextPath,
          relativePath: toProjectRelativePath(nextPath, projectPath)
        }
      })

      for (let i = 0; i < locations.length; i += 1) {
        await window.api.aiConfig.renameContextFile(locations[i].path, renamedLocations[i].path, projectPath)
      }

      setSlug(normalized)
      setCommittedSlug(normalized)
      setLocations(renamedLocations)
      setSlugDirty(false)
      toast.success(`Renamed unmanaged skill to ${normalized}.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Rename failed')
    } finally {
      setSavingSlug(false)
    }
  }

  const handleManageClick = async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      await saveContentToDisk(content)
    }
    await onManage({ slug: normalizeSlug(slug), locations })
  }

  const handleDeleteClick = async () => {
    setDeleting(true)
    try {
      await onDelete({ slug: committedSlug, locations })
    } finally {
      setDeleting(false)
    }
  }

  const managing = managingSlug !== null && (
    managingSlug === committedSlug ||
    managingSlug === normalizeSlug(slug) ||
    managingSlug === item.slug
  )

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
  }, [])

  return (
    <div
      data-testid={`project-context-item-unmanaged-skill-${item.slug}`}
      className={cn(
        'rounded-md border overflow-hidden',
        expanded && 'border-primary/30'
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 transition-colors cursor-pointer',
          expanded ? 'border-b border-primary/20' : 'hover:bg-muted/30'
        )}
        onClick={handleToggleExpanded}
      >
        {expanded
          ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        }
        <span className="flex-1 truncate font-mono text-xs">{committedSlug}</span>
        <StatusBadge syncHealth="unmanaged" />
      </div>
      {expanded && (
        <div className="p-4 space-y-3">
          <div
            data-testid={`unmanaged-skill-edit-section-${committedSlug}`}
            className="space-y-3"
          >
            <p className="text-lg font-semibold leading-tight">Edit</p>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Filename</Label>
              <div className="flex items-center gap-2">
                <Input
                  data-testid="skill-detail-filename"
                  className="font-mono text-xs !bg-surface-1 dark:!bg-surface-1 shadow-none"
                  value={slug}
                  onChange={(e) => handleSlugChange(e.target.value)}
                />
                {slugDirty && (
                  <Button data-testid="skill-detail-rename" size="sm" onClick={handleSlugSave} disabled={savingSlug}>
                    {savingSlug ? 'Renaming...' : 'Rename'}
                  </Button>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <Textarea
                data-testid="skill-detail-content"
                className="min-h-[260px] max-h-[40vh] field-sizing-content resize-y font-mono text-sm !bg-surface-1 dark:!bg-surface-1 shadow-none"
                placeholder="Write your skill content here."
                value={loadingContent ? '' : content}
                onChange={handleContentChange}
              />
              <div className="flex items-center justify-end">
                {savingContent && (
                  <span className="text-[11px] text-muted-foreground">Saving…</span>
                )}
              </div>
            </div>
          </div>

          <div
            data-testid={`unmanaged-skill-manage-section-${committedSlug}`}
            className="space-y-3"
          >
            <p className="text-lg font-semibold leading-tight">Sync</p>
            <div className="space-y-0.5">
              {locations.map((location) => (
                <p key={location.path} className="truncate font-mono text-[11px] text-muted-foreground">{location.relativePath}</p>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                data-testid={`unmanaged-skill-delete-${committedSlug}`}
                onClick={() => { void handleDeleteClick() }}
                disabled={deleting || managing || savingSlug || savingContent}
              >
                {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                Delete files
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid={`unmanaged-skill-manage-${committedSlug}`}
                onClick={() => { void handleManageClick() }}
                disabled={managing || slugDirty || savingSlug || savingContent}
              >
                {managing && <Loader2 className="size-3.5 animate-spin" />}
                Turn into managed
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================
// Main Export
// ============================================================

export function ItemSection({
  type, linkedItems, localItems, unmanagedItems, enabledProviders,
  projectId, projectPath, onOpenGlobalAiConfig, onChanged
}: ItemSectionProps) {
  const [showPicker, setShowPicker] = useState(false)
  const [managingUnmanagedSlug, setManagingUnmanagedSlug] = useState<string | null>(null)

  const allItems = [
    ...localItems.map(item => ({ item, providers: {} as ProjectSkillStatus['providers'], isLocal: true })),
    ...linkedItems.map(s => ({ item: s.item, providers: s.providers, isLocal: s.item.scope === 'project' }))
  ]
  const existingSlugs = new Set(allItems.map(({ item }) => item.slug))
  const visibleUnmanagedItems = unmanagedItems.filter((item) => !existingSlugs.has(item.slug))
  const existingLinks = linkedItems.map(s => s.item.id)

  const handleRemove = async (itemId: string, isLocal: boolean) => {
    if (isLocal) {
      await window.api.aiConfig.deleteItem(itemId)
    } else {
      await window.api.aiConfig.removeProjectSelection(projectId, itemId)
    }
    onChanged()
  }

  const handleManageUnmanaged = async (item: UnmanagedSkillRow) => {
    setManagingUnmanagedSlug(item.slug)
    let createdItemId: string | null = null
    try {
      const primaryLocation = item.locations[0]
      if (!primaryLocation) throw new Error('No unmanaged file found')

      const diskContent = await window.api.aiConfig.readContextFile(primaryLocation.path, projectPath)

      const created = await window.api.aiConfig.createItem({
        type: 'skill',
        scope: 'project',
        projectId,
        slug: item.slug,
        content: diskContent
      })
      createdItemId = created.id

      const targetByProvider = new Map<CliProvider, string>()
      for (const location of item.locations) {
        if (!location.provider) continue
        if (!targetByProvider.has(location.provider)) {
          targetByProvider.set(location.provider, location.relativePath)
        }
      }
      for (const [provider, targetPath] of targetByProvider.entries()) {
        await window.api.aiConfig.setProjectSelection({
          projectId,
          itemId: created.id,
          provider,
          targetPath
        })
      }

      toast.success(`Turned ${item.slug} into managed.`)
      onChanged()
    } catch (err) {
      if (createdItemId) {
        try {
          await window.api.aiConfig.deleteItem(createdItemId)
        } catch { /* ignore cleanup errors */ }
      }
      toast.error(err instanceof Error ? err.message : 'Failed to manage unmanaged skill')
    } finally {
      setManagingUnmanagedSlug(null)
    }
  }

  const handleDeleteUnmanaged = async (item: UnmanagedSkillRow) => {
    try {
      for (const location of item.locations) {
        await window.api.aiConfig.deleteContextFile(location.path, projectPath, projectId)
      }
      toast.success(`Deleted ${item.slug}`)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete skill files')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {allItems.map(({ item, providers, isLocal }) => (
          <SkillItemDetail
            key={item.id}
            item={item} providers={providers} enabledProviders={enabledProviders}
            isLocal={isLocal} projectId={projectId} projectPath={projectPath}
            onGoToGlobal={!isLocal && onOpenGlobalAiConfig ? () => onOpenGlobalAiConfig('skill') : undefined}
            onChanged={onChanged} onRemove={() => handleRemove(item.id, isLocal)}
          />
        ))}
        {visibleUnmanagedItems.map((item) => (
          <UnmanagedSkillItemRow
            key={`unmanaged-${item.slug}`}
            item={item}
            projectPath={projectPath}
            managingSlug={managingUnmanagedSlug}
            onManage={handleManageUnmanaged}
            onDelete={handleDeleteUnmanaged}
          />
        ))}

        <div
          data-testid={`project-context-add-${type}`}
          className="mt-1 flex items-center gap-2 rounded-md border border-dashed px-3 py-2 cursor-pointer text-muted-foreground transition-colors hover:bg-muted/15 hover:text-foreground"
          onClick={() => setShowPicker(true)}
        >
          <Plus className="size-3 shrink-0" />
          <span className="text-xs">Add skill</span>
        </div>
      </div>
      <SkillHelpCard testId="project-skill-help-card" className="mt-3 shrink-0" />

      <AddItemPicker
        open={showPicker}
        onOpenChange={setShowPicker}
        type={type}
        projectId={projectId}
        projectPath={projectPath}
        enabledProviders={enabledProviders}
        existingLinks={existingLinks}
        onAdded={() => { setShowPicker(false); onChanged() }}
      />
    </div>
  )
}
