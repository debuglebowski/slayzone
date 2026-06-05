import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react'
import {
  Button,
  IconButton,
  Input,
  Label,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn
} from '@slayzone/ui'
import type { AiConfigItem, CliProvider, ProjectSkillStatus } from '../shared'
import { StatusBadge, ProviderFileCard } from './SyncComponents'
import { aggregateProviderSyncHealth, hasPendingProviderSync } from './sync-view-model'
import { getSkillFrontmatterActionLabel } from './skill-validation'
import { useSkillItem } from './useSkillItem'

export function SkillItemDetail({
  item,
  providers,
  enabledProviders,
  isLocal,
  projectId,
  projectPath,
  onChanged,
  onRemove,
  onGoToLibrary
}: {
  item: AiConfigItem
  providers: ProjectSkillStatus['providers']
  enabledProviders: CliProvider[]
  isLocal: boolean
  projectId: string
  projectPath: string
  onChanged: () => void
  onRemove: () => void
  onGoToLibrary?: () => void
}) {
  const sk = useSkillItem({
    item,
    providers,
    enabledProviders,
    isLocal,
    projectId,
    projectPath,
    onChanged
  })
  const [expanded, setExpanded] = useState(false)
  const status = aggregateProviderSyncHealth(providers)
  const hasPendingSync = hasPendingProviderSync(sk.providerRows.map((row) => row.syncHealth))
  const validationStatus =
    sk.validation?.status === 'invalid' || sk.validation?.status === 'warning'
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
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 truncate font-mono text-xs">
          {item.slug}
          {isLocal && (
            <span className="ml-1.5 font-sans text-[10px] text-muted-foreground">(local)</span>
          )}
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
          size="icon-sm"
          variant="ghost"
          className="size-6 text-muted-foreground hover:text-destructive shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          <X className="size-3" />
        </IconButton>
      </div>

      {/* Expanded: stacked edit + sync sections */}
      {expanded && (
        <div className="p-4 space-y-3">
          <div data-testid={`skill-edit-section-${item.slug}`} className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-lg font-semibold leading-tight">Edit</p>
              {!sk.isLocal && (
                <div className="flex items-center gap-2">
                  {onGoToLibrary && (
                    <Button
                      data-testid={`skill-go-to-library-${item.slug}`}
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      onClick={onGoToLibrary}
                    >
                      Go to library
                    </Button>
                  )}
                  <Button
                    data-testid="skill-detail-revert"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    onClick={sk.handleRevert}
                  >
                    Revert to library
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
                  <Button
                    data-testid="skill-detail-rename"
                    size="sm"
                    onClick={sk.handleSlugSave}
                    disabled={sk.savingSlug}
                  >
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
                      {sk.validation.status === 'invalid'
                        ? 'Frontmatter is invalid'
                        : 'Frontmatter warning'}
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

          <div data-testid={`skill-sync-section-${item.slug}`} className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <p className="text-lg font-semibold leading-tight">Sync</p>
                {status === 'stale' && (
                  <span className="inline-flex size-2 rounded-full bg-amber-500" />
                )}
              </div>
              {sk.providerRows.length > 1 &&
                (hasPendingSync || sk.syncingAll || sk.hasValidationErrors) && (
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
                        Database → All Files
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {sk.hasValidationErrors
                        ? 'Fix frontmatter errors before syncing to files.'
                        : 'Overwrite all provider skill Files'}
                    </TooltipContent>
                  </Tooltip>
                )}
            </div>

            {sk.providerRows.length > 0 ? (
              <>
                <div className="space-y-2">
                  {sk.providerRows.map((row) => (
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
              <p className="text-sm text-muted-foreground py-4 text-center">
                No providers configured
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
