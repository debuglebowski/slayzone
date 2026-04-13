import { useCallback, useEffect, useState } from 'react'
import {
  ArrowLeft, AlertTriangle, ChevronRight,
  Plus, Sparkles, Server, FileText, FolderTree, Settings2,
  type LucideIcon
} from 'lucide-react'
import { Button, cn, Switch } from '@slayzone/ui'
import { buildDefaultSkillContent } from '../shared'
import type {
  AiConfigItem, AiConfigScope, CliProvider,
  CliProviderInfo, UpdateAiConfigItemInput
} from '../shared'
import { PROVIDER_LABELS } from '../shared/provider-registry'
import { ContextItemEditor } from './ContextItemEditor'
import { ComputerContextFiles } from './ComputerContextFiles'
import { McpServersPanel } from './McpServersPanel'
import { ProjectContextFlat } from './ProjectContextFlat'
import { ProjectContextFilesView } from './ProjectContextFilesView'
import { ProjectInstructions } from './ProjectInstructions'
import { SkillHelpCard } from './SkillHelpCard'
import { getSkillValidation } from './skill-validation'

export type ContextManagerSection = 'providers' | 'instructions' | 'skill' | 'mcp' | 'files' | 'provider-sync' | 'skills' | 'mcps'
type Section = ContextManagerSection

interface ContextManagerSettingsProps {
  scope: AiConfigScope
  projectId: string | null
  projectPath?: string | null
  projectName?: string
  projectTab?: ProjectContextManagerTab
  onOpenContextManager?: (section: ContextManagerSection) => void
  initialSection?: ContextManagerSection | null
}

export type ProjectContextManagerTab = 'config' | 'files'

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Recently'
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function nextAvailableSlug(base: string, existingSlugs: Set<string>): string {
  if (!existingSlugs.has(base)) return base
  let index = 2
  while (existingSlugs.has(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}

// ---------------------------------------------------------------------------
// Shared overview card
// ---------------------------------------------------------------------------

function OverviewCard({ testId, icon: Icon, label, detail, onClick }: {
  testId: string
  icon: LucideIcon
  label: string
  detail?: string
  onClick: () => void
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg border bg-surface-3 p-3.5 text-left transition-colors"
    >
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium">{label}</span>
      </div>
      {detail && <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{detail}</span>}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

function SkillValidationBadge({ status }: { status: 'invalid' | 'warning' }) {
  const invalid = status === 'invalid'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
        invalid
          ? 'bg-destructive/15 text-destructive'
          : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
      )}
    >
      <AlertTriangle className="size-3" />
      {invalid ? 'Invalid frontmatter' : 'Frontmatter warning'}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Overview panel — library scope only
// ---------------------------------------------------------------------------

interface OverviewData {
  instructions: { content: string } | null
  skills: AiConfigItem[]
  providers: CliProviderInfo[]
}

function OverviewPanel({
  onNavigate,
  version
}: {
  onNavigate: (section: Section) => void
  version: number
}) {
  const [data, setData] = useState<OverviewData | null>(null)

  useEffect(() => {
    let stale = false
    void (async () => {
      try {
        const [instrContent, skills, providers] = await Promise.all([
          window.api.aiConfig.getLibraryInstructions(),
          window.api.aiConfig.listItems({ scope: 'library', type: 'skill' }),
          window.api.aiConfig.listProviders()
        ])
        if (stale) return
        setData({
          instructions: { content: instrContent },
          skills,
          providers,
        })
      } catch {
        // silently fail — cards will show loading state
      }
    })()
    return () => { stale = true }
  }, [version])

  if (!data) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="h-20 animate-pulse rounded-lg border bg-muted/20" />
        ))}
      </div>
    )
  }

  const skillCount = data.skills.length
  const enabledProviders = data.providers.filter(p => p.enabled)
  const hasContent = !!data.instructions?.content

  return (
    <div className="space-y-2.5">
      <OverviewCard testId="context-overview-providers" icon={Settings2} label="Providers" detail={`${enabledProviders.length} enabled`} onClick={() => onNavigate('providers')} />
      <OverviewCard testId="context-overview-instructions" icon={FileText} label="Instructions" detail={hasContent ? 'Saved' : 'Empty'} onClick={() => onNavigate('instructions')} />
      <OverviewCard testId="context-overview-skills" icon={Sparkles} label="Skills" detail={`${skillCount} defined`} onClick={() => onNavigate('skill')} />
      <OverviewCard testId="context-overview-mcp" icon={Server} label="MCP Servers" onClick={() => onNavigate('mcp')} />
      <OverviewCard testId="context-overview-files" icon={FolderTree} label="Files" onClick={() => onNavigate('files')} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Providers panel
// ---------------------------------------------------------------------------

function ProvidersPanel() {
  const [providers, setProviders] = useState<CliProviderInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      try {
        const list = await window.api.aiConfig.listProviders()
        setProviders(list)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const handleToggle = async (provider: CliProviderInfo) => {
    const newEnabled = !provider.enabled
    await window.api.aiConfig.toggleProvider(provider.id, newEnabled)
    setProviders(prev => prev.map(p => p.id === provider.id ? { ...p, enabled: newEnabled } : p))
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading...</p>

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Enable the providers you use. Skills and instructions will sync to enabled providers.
      </p>
      {providers.map(provider => {
        const isPlaceholder = provider.status === 'placeholder'
        return (
          <div
            key={provider.id}
            className={cn(
              'flex items-center justify-between rounded-md border bg-surface-3 px-3 py-2.5',
              isPlaceholder && 'opacity-50'
            )}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {PROVIDER_LABELS[provider.kind as CliProvider] ?? provider.name}
              </p>
              {isPlaceholder && (
                <p className="text-[11px] text-muted-foreground">Coming soon</p>
              )}
            </div>
            <Switch
              checked={provider.enabled}
              onCheckedChange={() => handleToggle(provider)}
              disabled={isPlaceholder}
            />
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ContextManagerSettings({
  scope,
  projectId,
  projectPath,
  projectName,
  projectTab,
  onOpenContextManager,
  initialSection
}: ContextManagerSettingsProps) {
  const isProject = scope === 'project' && !!projectId && !!projectPath
  const activeProjectTab = projectTab ?? 'config'

  if (isProject) {
    if (activeProjectTab === 'files') {
      return (
        <ProjectContextFilesView
          projectId={projectId!}
          projectPath={projectPath!}
        />
      )
    }

    return (
      <ProjectContextFlat
        projectId={projectId!}
        projectPath={projectPath!}
        projectName={projectName}
        onOpenContextManager={onOpenContextManager}
      />
    )
  }

  return <LegacyContextManager initialSection={initialSection ?? null} />
}

// ---------------------------------------------------------------------------
// Legacy (pre-shell) context manager — own component so hooks are unconditional
// ---------------------------------------------------------------------------

function LegacyContextManager({ initialSection }: { initialSection: ContextManagerSection | null }) {
  const [section, setSection] = useState<Section | null>(initialSection)
  const [items, setItems] = useState<AiConfigItem[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [providerVersion] = useState(0)
  const [syncCheckVersion] = useState(0)

  const isItemSection = section === 'skill'

  const loadItems = useCallback(async () => {
    if (!isItemSection) return
    setLoading(true)
    try {
      const rows = await window.api.aiConfig.listItems({
        scope: 'library',
        type: 'skill'
      })
      setItems(rows)
    } finally {
      setLoading(false)
    }
  }, [section, isItemSection])

  useEffect(() => {
    void loadItems()
    setEditingId(null)
  }, [loadItems])

  useEffect(() => {
    setSection(initialSection)
  }, [initialSection])

  const handleCreate = async () => {
    if (!isItemSection) return
    const existingSlugs = new Set(items.map((item) => item.slug))
    const slug = nextAvailableSlug('new-skill', existingSlugs)
    const created = await window.api.aiConfig.createItem({
      type: 'skill',
      scope: 'library',
      slug,
      content: buildDefaultSkillContent(slug)
    })
    setItems((prev) => [created, ...prev])
    setEditingId(created.id)
  }

  const handleUpdate = async (itemId: string, patch: Omit<UpdateAiConfigItemInput, 'id'>) => {
    const updated = await window.api.aiConfig.updateItem({ id: itemId, ...patch })
    if (!updated) return
    setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
  }

  const handleDelete = async (itemId: string) => {
    await window.api.aiConfig.deleteItem(itemId)
    setItems((prev) => prev.filter((item) => item.id !== itemId))
    setEditingId(null)
  }

  const librarySkillContent = (() => {
    if (loading) {
      return <p className="text-sm text-muted-foreground">Loading...</p>
    }

    if (items.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
          <Sparkles className="size-8 text-muted-foreground/40" />
          <p className="mt-3 text-sm font-medium text-foreground">No skills yet</p>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            Skills give AI assistants reusable capabilities. Create one to get started.
          </p>
          <Button size="sm" className="mt-4" onClick={handleCreate}>
            <Plus className="mr-1 size-3.5" />
            Create skill
          </Button>
        </div>
      )
    }

    return items.map((item) => {
      const validation = getSkillValidation(item)
      const validationStatus = validation?.status === 'invalid' || validation?.status === 'warning'
        ? validation.status
        : null

      return (
        <div key={item.id}>
          {editingId === item.id ? (
            <ContextItemEditor
              item={item}
              validationState={validation}
              onUpdate={(patch) => handleUpdate(item.id, patch)}
              onDelete={() => handleDelete(item.id)}
              onClose={() => setEditingId(null)}
            />
          ) : (
            <button
              onClick={() => setEditingId(item.id)}
              data-testid={`context-library-item-${item.slug}`}
              className="flex w-full items-center justify-between gap-3 rounded-md border bg-surface-3 px-3 py-2.5 text-left transition-colors"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-sm">{item.slug}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {validationStatus && <SkillValidationBadge status={validationStatus} />}
                <span className="text-[11px] text-muted-foreground">
                  {formatTimestamp(item.updated_at)}
                </span>
              </div>
            </button>
          )}
        </div>
      )
    })
  })()

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: back button + description + actions when drilled in */}
      {section !== null && (
        <div className="flex items-center justify-between gap-3 pb-4">
          <button
            onClick={() => setSection(null)}
            className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            {{ 'providers': 'Providers', 'provider-sync': 'Providers', 'instructions': 'Instructions', 'skill': 'Skills', 'skills': 'Skills', 'mcp': 'MCP Servers', 'mcps': 'MCP Servers', 'files': 'Files' }[section]}
          </button>

          <span className="flex-1 text-right text-xs text-muted-foreground">
            {section === 'providers' && 'Choose which AI coding tools to sync content to.'}
            {section === 'instructions' && 'Library instructions stored in the database. Not synced to any file.'}
            {section === 'skill' && 'Library skills shared across all projects. Synced to enabled providers.'}
            {section === 'mcp' && 'Browse and favorite MCP servers from the curated catalog.'}
            {section === 'files' && 'Computer-level config files across all provider directories.'}
          </span>

          <div className="flex items-center gap-2">
            <div id="context-manager-header-actions" />
            {isItemSection && (
              <Button
                size="sm"
                onClick={handleCreate}
                data-testid={`context-new-${section}`}
              >
                <Plus className="mr-1 size-3.5" />
                New
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Content area */}
      <div className="min-h-0 flex-1">
        {section === null ? (
          <OverviewPanel
            onNavigate={setSection}
            version={providerVersion + syncCheckVersion}
          />
        ) : section === 'providers' ? (
          <ProvidersPanel />
        ) : section === 'instructions' ? (
          <ProjectInstructions />
        ) : section === 'mcp' ? (
          <McpServersPanel mode="computer" />
        ) : section === 'files' ? (
          <ComputerContextFiles />
        ) : isItemSection ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
              {librarySkillContent}
            </div>
            <SkillHelpCard testId="library-skill-help-card" className="mt-3 shrink-0" />
          </div>
        ) : null}
      </div>
    </div>
  )
}
