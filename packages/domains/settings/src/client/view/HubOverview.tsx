import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { computerStatus } from '@slayzone/computers/labels'
import { getModeLabel, useAgents } from '@slayzone/terminal'
import { useTRPC } from '../trpc'
import { useDefaultAgent } from '../tabs/use-default-agent'
import { StatusDot } from './StatusDot'

/**
 * A hub's Overview, below its own card: one line per area of the hub, each the
 * area's headline fact and a link to its tab. Rendered inside the hub's scope, so
 * every read is that hub's.
 */
export function HubOverview({
  isDefault,
  openTab,
  openProjects
}: {
  /** Backups act on the default hub's machine (`app.*` host routers): only it lists them. */
  isDefault: boolean
  openTab: (tab: string) => void
  openProjects: () => void
}) {
  const trpc = useTRPC()
  const computers = useQuery(trpc.computers.list.queryOptions())
  const projects = useQuery(trpc.projects.list.queryOptions())
  const worktreeBase = useQuery(trpc.settings.get.queryOptions({ key: 'worktree_base_path' }))
  const { modes } = useAgents()
  const { defaultAgentId } = useDefaultAgent()
  const defaultMode = modes.find((m) => m.id === defaultAgentId)

  const live = (computers.data ?? []).filter((c) => c.revokedAt == null)
  const connected = live.filter((c) => computerStatus(c).tone === 'ok').length
  const projectCount = projects.data?.length

  return (
    <div className="divide-y rounded-lg border" data-testid="hub-overview">
      <SummaryRow
        label="Computers"
        onOpen={() => openTab('computers')}
        testId="hub-overview-computers"
      >
        {computers.data && (
          <span className="flex items-center gap-2">
            <StatusDot tone={live.length > 0 && connected === live.length ? 'ok' : 'idle'} />
            {connected} of {live.length} connected
          </span>
        )}
      </SummaryRow>
      <SummaryRow label="Projects" onOpen={openProjects} testId="hub-overview-projects">
        {projectCount != null && `${projectCount} ${projectCount === 1 ? 'project' : 'projects'}`}
      </SummaryRow>
      <SummaryRow
        label="Default agent"
        onOpen={() => openTab('agents')}
        testId="hub-overview-agent"
      >
        {defaultMode ? getModeLabel(defaultMode) : defaultAgentId}
      </SummaryRow>
      <SummaryRow
        label="Worktrees"
        onOpen={() => openTab('worktrees')}
        testId="hub-overview-worktrees"
      >
        {worktreeBase.isSuccess && (
          <span className="font-mono text-xs">{worktreeBase.data || 'Default location'}</span>
        )}
      </SummaryRow>
      {isDefault && <LastBackupRow onOpen={() => openTab('backups')} />}
    </div>
  )
}

function LastBackupRow({ onOpen }: { onOpen: () => void }) {
  const trpc = useTRPC()
  const backups = useQuery(trpc.app.backup.list.queryOptions())
  const latest = (backups.data ?? []).reduce<string | null>(
    (max, b) => (max == null || b.timestamp > max ? b.timestamp : max),
    null
  )
  return (
    <SummaryRow label="Last backup" onOpen={onOpen} testId="hub-overview-backup">
      {backups.isSuccess && (latest ? new Date(latest).toLocaleString() : 'None yet')}
    </SummaryRow>
  )
}

function SummaryRow({
  label,
  onOpen,
  testId,
  children
}: {
  label: string
  onOpen: () => void
  testId: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={testId}
      className="grid w-full grid-cols-[160px_minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 text-left transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-accent/50"
    >
      <span className="text-sm">{label}</span>
      <span className="min-w-0 truncate text-sm text-muted-foreground">{children}</span>
      <ChevronRight className="size-3.5 text-muted-foreground" />
    </button>
  )
}
