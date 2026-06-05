import { useEffect, useState } from 'react'
import {
  ChevronRight,
  Sparkles,
  Server,
  FileText,
  FolderTree,
  Settings2,
  type LucideIcon
} from 'lucide-react'
import type { OverviewData, Section } from './ContextManagerSettings.types'

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
          providers
        })
      } catch {
        // silently fail — cards will show loading state
      }
    })()
    return () => {
      stale = true
    }
  }, [version])

  if (!data) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg border bg-muted/20" />
        ))}
      </div>
    )
  }

  const skillCount = data.skills.length
  const enabledProviders = data.providers.filter((p) => p.enabled)
  const hasContent = !!data.instructions?.content

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
