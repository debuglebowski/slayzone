import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import {
  AlertTriangle, ChevronDown, ChevronRight,
  Plus, Loader2, X
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
// ============================================================
// Types & Helpers
// ============================================================

interface ItemSectionProps {
  type: AiConfigItemType
  linkedItems: ProjectSkillStatus[]
  localItems: AiConfigItem[]
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
        'rounded-md border bg-surface-3 overflow-hidden',
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
                  className="font-mono text-xs !bg-surface-3 dark:!bg-surface-3 shadow-none"
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
                className="min-h-[260px] max-h-[40vh] field-sizing-content resize-y font-mono text-sm !bg-surface-3 dark:!bg-surface-3 shadow-none"
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

// ============================================================
// Main Export
// ============================================================

export function ItemSection({
  type, linkedItems, localItems, enabledProviders,
  projectId, projectPath, onOpenGlobalAiConfig, onChanged
}: ItemSectionProps) {
  const [showPicker, setShowPicker] = useState(false)

  const allItems = [
    ...localItems.map(item => ({ item, providers: {} as ProjectSkillStatus['providers'], isLocal: true })),
    ...linkedItems.map(s => ({ item: s.item, providers: s.providers, isLocal: s.item.scope === 'project' }))
  ].sort((a, b) => a.item.slug.localeCompare(b.item.slug))
  const existingLinks = linkedItems.map(s => s.item.id)

  const handleRemove = async (itemId: string, isLocal: boolean) => {
    if (isLocal) {
      await window.api.aiConfig.deleteItem(itemId)
    } else {
      await window.api.aiConfig.removeProjectSelection(projectId, itemId)
    }
    onChanged()
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
