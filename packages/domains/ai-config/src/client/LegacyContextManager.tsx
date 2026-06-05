import { ArrowLeft, AlertTriangle, Plus, Sparkles } from 'lucide-react'
import { Button, cn } from '@slayzone/ui'
import { ContextItemEditor } from './ContextItemEditor'
import { ComputerContextFiles } from './ComputerContextFiles'
import { McpServersPanel } from './McpServersPanel'
import { ProjectInstructions } from './ProjectInstructions'
import { SkillHelpCard } from './SkillHelpCard'
import { getSkillValidation } from './skill-validation'
import { OverviewPanel } from './ContextManagerOverviewPanel'
import { ProvidersPanel } from './ContextManagerProvidersPanel'
import type { ContextManagerSection } from './ContextManagerSettings.types'
import { formatTimestamp } from './ContextManagerSettings.utils'
import { useLegacyContextState } from './useLegacyContextState'

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
// Legacy (pre-shell) context manager — own component so hooks are unconditional
// ---------------------------------------------------------------------------

export function LegacyContextManager({
  initialSection
}: {
  initialSection: ContextManagerSection | null
}) {
  const {
    section,
    setSection,
    items,
    editingId,
    setEditingId,
    loading,
    providerVersion,
    syncCheckVersion,
    isItemSection,
    handleCreate,
    handleUpdate,
    handleDelete
  } = useLegacyContextState(initialSection)

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
      const validationStatus =
        validation?.status === 'invalid' || validation?.status === 'warning'
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
            {
              {
                providers: 'Providers',
                'provider-sync': 'Providers',
                instructions: 'Instructions',
                skill: 'Skills',
                skills: 'Skills',
                mcp: 'MCP Servers',
                mcps: 'MCP Servers',
                files: 'Files'
              }[section]
            }
          </button>

          <span className="flex-1 text-right text-xs text-muted-foreground">
            {section === 'providers' && 'Choose which AI coding tools to sync content to.'}
            {section === 'instructions' &&
              'Library instructions stored in the database. Not synced to any file.'}
            {section === 'skill' &&
              'Library skills shared across all projects. Synced to enabled providers.'}
            {section === 'mcp' && 'Browse and favorite MCP servers from the curated catalog.'}
            {section === 'files' && 'Computer-level config files across all provider directories.'}
          </span>

          <div className="flex items-center gap-2">
            <div id="context-manager-header-actions" />
            {isItemSection && (
              <Button size="sm" onClick={handleCreate} data-testid={`context-new-${section}`}>
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
          <OverviewPanel onNavigate={setSection} version={providerVersion + syncCheckVersion} />
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
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">{librarySkillContent}</div>
            <SkillHelpCard testId="library-skill-help-card" className="mt-3 shrink-0" />
          </div>
        ) : null}
      </div>
    </div>
  )
}
