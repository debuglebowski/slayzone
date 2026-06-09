import { useEffect } from 'react'
import {
  ChevronRight,
  Sparkles,
  Server,
  FileText,
  FolderTree,
  Settings2,
  type LucideIcon
} from 'lucide-react'
import { useTRPC } from '@slayzone/transport/client'
import { useQuery } from '@tanstack/react-query'
import type { Section } from './ContextManagerSettings.types'

// ---------------------------------------------------------------------------
// Shared overview card
// ---------------------------------------------------------------------------

function OverviewCard({
  testId,
  icon: Icon,
  label,
  detail,
  onClick
}: {
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
      {detail && (
        <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{detail}</span>
      )}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Overview panel — library scope only
// ---------------------------------------------------------------------------

export function OverviewPanel({
  onNavigate,
  version
}: {
  onNavigate: (section: Section) => void
  version: number
}) {
  const trpc = useTRPC()
  const instructionsQuery = useQuery(trpc.aiConfig.getLibraryInstructions.queryOptions(undefined))
  const skillsQuery = useQuery(
    trpc.aiConfig.listItems.queryOptions({ scope: 'library', type: 'skill' })
  )
  const providersQuery = useQuery(trpc.aiConfig.listProviders.queryOptions())

  // External retrigger: bump `version` re-runs the underlying queries.
  useEffect(() => {
    void instructionsQuery.refetch()
    void skillsQuery.refetch()
    void providersQuery.refetch()
  }, [version])

  const instrContent = instructionsQuery.data
  const skills = skillsQuery.data
  const providers = providersQuery.data

  if (instrContent === undefined || skills === undefined || providers === undefined) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg border bg-muted/20" />
        ))}
      </div>
    )
  }

  const skillCount = skills.length
  const enabledProviders = providers.filter((p) => p.enabled)
  const hasContent = !!instrContent

  return (
    <div className="space-y-2.5">
      <OverviewCard
        testId="context-overview-providers"
        icon={Settings2}
        label="Providers"
        detail={`${enabledProviders.length} enabled`}
        onClick={() => onNavigate('providers')}
      />
      <OverviewCard
        testId="context-overview-instructions"
        icon={FileText}
        label="Instructions"
        detail={hasContent ? 'Saved' : 'Empty'}
        onClick={() => onNavigate('instructions')}
      />
      <OverviewCard
        testId="context-overview-skills"
        icon={Sparkles}
        label="Skills"
        detail={`${skillCount} defined`}
        onClick={() => onNavigate('skill')}
      />
      <OverviewCard
        testId="context-overview-mcp"
        icon={Server}
        label="MCP Servers"
        onClick={() => onNavigate('mcp')}
      />
      <OverviewCard
        testId="context-overview-files"
        icon={FolderTree}
        label="Files"
        onClick={() => onNavigate('files')}
      />
    </div>
  )
}
