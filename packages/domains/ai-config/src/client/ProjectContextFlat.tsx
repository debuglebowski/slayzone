import { useCallback, useEffect, useState } from 'react'
import {
  ArrowLeft, ChevronRight,
  FileText, RefreshCw, Server, Settings2, Sparkles,
  type LucideIcon
} from 'lucide-react'
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn, toast } from '@slayzone/ui'
import type {
  AiConfigItem,
  CliProvider,
  ContextTreeEntry,
  McpConfigFileResult,
  ProjectSkillStatus,
  SyncHealth,
  SyncReason
} from '../shared'
import type { GlobalContextManagerSection } from './ContextManagerSettings'
import { ItemSection } from './ItemSection'
import { computeUnmanagedSkillRows } from './unmanaged-skills'
import { McpFlatSection } from './McpFlatSection'
import { ProjectInstructions } from './ProjectInstructions'
import { ProviderChips } from './ProviderChips'
import { contextEntryToSyncHealth, countSyncHealths } from './sync-view-model'

interface ProjectContextFlatProps {
  projectId: string
  projectPath: string
  projectName?: string
  onOpenGlobalAiConfig?: (section: GlobalContextManagerSection) => void
}

type ProjectSection = 'providers' | 'instructions' | 'skill' | 'mcp'

interface ContextData {
  linkedSkills: ProjectSkillStatus[]
  localItems: AiConfigItem[]
  enabledProviders: CliProvider[]
  instructions: {
    content: string
    providerHealth?: Partial<Record<CliProvider, { health: SyncHealth; reason: SyncReason | null }>>
  }
  contextTree: ContextTreeEntry[]
  mcpConfigs: McpConfigFileResult[]
}

interface SectionCounts { total: number; synced: number; stale: number; unmanaged: number }

function computeSkillCounts(tree: ContextTreeEntry[]): SectionCounts {
  const counts = countSyncHealths(
    tree
      .filter((entry) => entry.category === 'skill')
      .map((entry) => contextEntryToSyncHealth(entry))
  )
  return {
    total: counts.synced + counts.stale + counts.unmanaged,
    synced: counts.synced,
    stale: counts.stale,
    unmanaged: counts.unmanaged
  }
}

// computeUnmanagedSkillRows and skillSlugFromContextPath extracted to ./unmanaged-skills.ts

function computeInstructionCounts(instructions: ContextData['instructions']): SectionCounts {
  const providerHealth = instructions.providerHealth ?? {}
  const counts = countSyncHealths(
    (Object.keys(providerHealth) as CliProvider[])
      .map((provider) => providerHealth[provider]?.health ?? 'not_synced')
  )
  return {
    total: counts.total,
    synced: counts.synced,
    stale: counts.stale,
    unmanaged: counts.unmanaged
  }
}

function computeMcpCounts(configs: McpConfigFileResult[]): SectionCounts {
  let total = 0
  for (const c of configs) total += Object.keys(c.servers).length
  return { total, synced: 0, stale: 0, unmanaged: 0 }
}

function CountsSummary({ counts }: { counts: SectionCounts }) {
  if (counts.total === 0) return null
  const pills: Array<{ label: string; value: number; bg: string; text: string }> = []
  if (counts.synced > 0) pills.push({ label: 'synced', value: counts.synced, bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400' })
  if (counts.stale > 0) pills.push({ label: 'stale', value: counts.stale, bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-400' })
  if (counts.unmanaged > 0) pills.push({ label: 'unmanaged', value: counts.unmanaged, bg: 'bg-muted', text: 'text-muted-foreground' })
  if (pills.length === 0) return null
  return (
    <div className="flex items-center gap-1">
      {pills.map((p) => (
        <span key={p.label} className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', p.bg, p.text)}>
          {p.value} {p.label}
        </span>
      ))}
    </div>
  )
}

function OverviewCard({ testId, icon: Icon, label, detail, counts, onClick }: {
  testId: string
  icon: LucideIcon
  label: string
  detail?: string
  counts?: SectionCounts
  onClick: () => void
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg border p-3.5 text-left transition-colors hover:bg-muted/50"
    >
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium">{label}</span>
      </div>
      {counts && counts.total > 0 && <CountsSummary counts={counts} />}
      {detail && <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{detail}</span>}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

function ProjectOverviewPanel({
  data,
  syncingMode,
  onNavigate,
  onResetAndSync,
  onSyncAll
}: {
  data: ContextData
  syncingMode: 'sync' | 'reset' | null
  onNavigate: (section: ProjectSection) => void
  onResetAndSync: () => Promise<void>
  onSyncAll: () => Promise<void>
}) {
  const skillCounts = computeSkillCounts(data.contextTree)
  const instrCounts = computeInstructionCounts(data.instructions)
  const mcpCounts = computeMcpCounts(data.mcpConfigs)

  return (
    <div className="space-y-2.5">
      <OverviewCard testId="project-context-overview-providers" icon={Settings2} label="Providers" detail={`${data.enabledProviders.length} enabled`} onClick={() => onNavigate('providers')} />
      <OverviewCard testId="project-context-overview-instructions" icon={FileText} label="Instructions" detail={`${instrCounts.total} provider${instrCounts.total === 1 ? '' : 's'}`} counts={instrCounts} onClick={() => onNavigate('instructions')} />
      <OverviewCard testId="project-context-overview-skills" icon={Sparkles} label="Skills" detail={`${skillCounts.total} total`} counts={skillCounts} onClick={() => onNavigate('skill')} />
      <OverviewCard testId="project-context-overview-mcp" icon={Server} label="MCP Servers" detail={`${mcpCounts.total} server${mcpCounts.total === 1 ? '' : 's'}`} onClick={() => onNavigate('mcp')} />

      <div className="flex items-center gap-2 pt-3">
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                size="sm"
                className="h-7 px-2 text-[11px]"
                variant="outline"
                onClick={() => { void onResetAndSync() }}
                disabled={syncingMode !== null}
                data-testid="project-context-reset-sync"
              >
                <RefreshCw className={cn('mr-1.5 size-3.5', syncingMode === 'reset' && 'animate-spin')} />
                Reset and sync
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Remove unmanaged files, then sync all managed items.
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => { void onSyncAll() }}
                disabled={syncingMode !== null}
                data-testid="project-context-sync-all"
              >
                <RefreshCw className={cn('mr-1.5 size-3.5', syncingMode === 'sync' && 'animate-spin')} />
                Sync All
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Sync all managed items to provider files.
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main project layout
// ---------------------------------------------------------------------------

export function ProjectContextFlat({ projectId, projectPath, onOpenGlobalAiConfig }: ProjectContextFlatProps) {
  const [data, setData] = useState<ContextData | null>(null)
  const [version, setVersion] = useState(0)
  const [syncingMode, setSyncingMode] = useState<'sync' | 'reset' | null>(null)
  const [section, setSection] = useState<ProjectSection | null>(null)

  const bumpVersion = useCallback(() => setVersion(v => v + 1), [])

  useEffect(() => {
    let stale = false
    void (async () => {
      try {
        const [skillsStatus, localItems, enabledProviders, instructions, contextTree, mcpConfigs] = await Promise.all([
          window.api.aiConfig.getProjectSkillsStatus(projectId, projectPath),
          window.api.aiConfig.listItems({ scope: 'project', projectId }),
          window.api.aiConfig.getProjectProviders(projectId),
          window.api.aiConfig.getRootInstructions(projectId, projectPath),
          window.api.aiConfig.getContextTree(projectPath, projectId),
          window.api.aiConfig.discoverMcpConfigs(projectPath)
        ])
        if (stale) return
        setData({
          linkedSkills: skillsStatus.filter(s => s.item.type === 'skill'),
          localItems: localItems.filter(i => i.type !== 'root_instructions'),
          enabledProviders,
          instructions: {
            ...instructions,
            providerHealth: instructions.providerHealth ?? {}
          },
          contextTree,
          mcpConfigs
        })
      } catch {
        // silent
      }
    })()
    return () => { stale = true }
  }, [projectId, projectPath, version])

  const handleSyncAll = async () => {
    if (!data) return
    setSyncingMode('sync')
    try {
      const result = await window.api.aiConfig.syncAll({
        projectId,
        projectPath
      })
      const removed = result.deleted.length
      const added = result.written.length
      toast.success(`Sync complete: removed ${removed} file${removed === 1 ? '' : 's'}, added ${added} file${added === 1 ? '' : 's'}.`)
      bumpVersion()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setSyncingMode(null)
    }
  }

  const handleResetAndSync = async () => {
    setSyncingMode('reset')
    try {
      const result = await window.api.aiConfig.syncAll({
        projectId,
        projectPath,
        pruneUnmanaged: true
      })
      const removed = result.deleted.length
      const added = result.written.length
      toast.success(`Reset complete: removed ${removed} file${removed === 1 ? '' : 's'}, added ${added} file${added === 1 ? '' : 's'}.`)
      bumpVersion()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reset and sync failed')
    } finally {
      setSyncingMode(null)
    }
  }



  if (!data) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="h-16 animate-pulse rounded-lg border bg-muted/20" />
        ))}
      </div>
    )
  }

  const linkedSkillIds = new Set(data.linkedSkills.map(s => s.item.id))
  const localSkills = data.localItems.filter(i => i.type === 'skill' && !linkedSkillIds.has(i.id))
  const unmanagedSkills = computeUnmanagedSkillRows(data.contextTree)

  const sectionTitles: Record<ProjectSection, string> = {
    providers: 'Providers',
    instructions: 'Instructions',
    skill: 'Skills',
    mcp: 'MCP Servers'
  }

  const sectionDescriptions: Record<ProjectSection, string> = {
    providers: 'Choose which providers this project syncs to. Defaults inherited from global settings.',
    instructions: 'Use the “Use global” button in the instructions editor to load shared content.',
    skill: 'Select, edit, and sync project skills.',
    mcp: 'Manage MCP servers synced for this project.'
  }

  const content = (() => {
    if (section === null) {
      return (
        <ProjectOverviewPanel
          data={data}
          syncingMode={syncingMode}
          onNavigate={setSection}
          onResetAndSync={handleResetAndSync}
          onSyncAll={handleSyncAll}
        />
      )
    }
    if (section === 'providers') {
      return (
        <ProviderChips
          projectId={projectId}
          layout="panel"
          onChange={bumpVersion}
        />
      )
    }
    if (section === 'instructions') {
      return (
        <ProjectInstructions
          projectId={projectId}
          projectPath={projectPath}
        />
      )
    }
    if (section === 'skill') {
      return (
        <ItemSection
          type="skill"
          linkedItems={data.linkedSkills}
          localItems={localSkills}
          unmanagedItems={unmanagedSkills}
          enabledProviders={data.enabledProviders}
          projectId={projectId}
          projectPath={projectPath}
          onOpenGlobalAiConfig={onOpenGlobalAiConfig}
          onChanged={bumpVersion}
        />
      )
    }
    return (
      <McpFlatSection
        projectPath={projectPath}
        enabledProviders={data.enabledProviders}
        onOpenGlobalAiConfig={onOpenGlobalAiConfig}
        onChanged={bumpVersion}
      />
    )
  })()

  return (
    <div className="flex h-full min-h-0 flex-col">
      {section !== null && (
        <div className="flex items-center justify-between gap-3 pb-4">
          <button
            onClick={() => setSection(null)}
            className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            {sectionTitles[section]}
          </button>
          <div className="flex items-center gap-2">
            <div id="context-manager-header-actions" />
            {section !== 'instructions' && (
              <span className="text-xs text-muted-foreground">
                {sectionDescriptions[section]}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {content}
      </div>
    </div>
  )
}
