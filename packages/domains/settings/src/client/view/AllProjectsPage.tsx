import { useState } from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { getModeLabel, useAgents } from '@slayzone/terminal'
import { AGENT_STARTUP_SETTING } from '@slayzone/terminal-contracts'
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
  toast
} from '@slayzone/ui'
import { useTRPC, useTRPCClient } from '../trpc'
import { useSettingsViewStore } from '../settings-view-store'
import { ScopeOf } from './SettingsPages'
import { useNavHubs, type NavHub } from './SettingsNav'

/** The hub settings the table compares (each a project may override). */
const COLUMNS = [
  { key: 'default_agent_id', label: 'Default agent', fallback: 'claude-code' },
  { key: AGENT_STARTUP_SETTING, label: 'Agent startup', fallback: 'auto' }
] as const

const STARTUP_LABEL: Record<string, string> = { manual: 'Manual', auto: 'Auto', instant: 'Instant' }

/**
 * Every project on every hub, side by side (plans/settings-by-scope.md, phase 5):
 * which settings each one takes from its hub and which it overrides, with bulk
 * actions. Each hub's block renders in that hub's scope, so every read and write
 * goes to the hub that owns the project.
 */
export function AllProjectsPage() {
  const hubs = useNavHubs()
  const [filter, setFilter] = useState('')
  const [onlyOverrides, setOnlyOverrides] = useState(false)
  return (
    <div className="space-y-6" data-testid="settings-all-projects">
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">Projects</div>
        <h1 className="text-2xl font-semibold tracking-tight">All projects</h1>
        <p className="text-sm text-muted-foreground">
          Compare settings across projects, find overrides and change several projects at once.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder="Filter projects"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="all-projects-filter"
        />
        <Button
          variant={onlyOverrides ? 'default' : 'outline'}
          size="sm"
          onClick={() => setOnlyOverrides((v) => !v)}
          data-testid="all-projects-only-overrides"
        >
          Only with overrides
        </Button>
      </div>
      {hubs.map((hub) => (
        <ScopeOf key={hub.id ?? 'ambient'} hubId={hub.id}>
          <HubProjects hub={hub} filter={filter} onlyOverrides={onlyOverrides} />
        </ScopeOf>
      ))}
    </div>
  )
}

function HubProjects({
  hub,
  filter,
  onlyOverrides
}: {
  hub: NavHub
  filter: string
  onlyOverrides: boolean
}) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const navigate = useSettingsViewStore((s) => s.navigate)
  const { modes } = useAgents()
  const projects = useQuery(trpc.projects.list.queryOptions())
  const hubValues = useQueries({
    queries: COLUMNS.map((c) => trpc.settings.effective.queryOptions({ key: c.key }))
  })
  const overrides = useQueries({
    queries: COLUMNS.map((c) =>
      trpc.settings.overridesOfKey.queryOptions({ key: c.key }, { retry: false })
    )
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const label = (key: string, value: string) =>
    key === AGENT_STARTUP_SETTING
      ? (STARTUP_LABEL[value] ?? value)
      : (() => {
          const m = modes.find((x) => x.id === value)
          return m ? getModeLabel(m) : value
        })()
  const ownOf = (i: number, projectId: string) =>
    overrides[i].data?.find((o) => o.projectId === projectId)?.value
  const rows = (projects.data ?? [])
    .filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()))
    .map((p) => ({
      project: p,
      cells: COLUMNS.map((c, i) => {
        const own = ownOf(i, p.id)
        const hubValue = hubValues[i].data?.value ?? c.fallback
        return { key: c.key, value: own ?? hubValue, own: own !== undefined }
      })
    }))
    .filter((r) => !onlyOverrides || r.cells.some((c) => c.own))
  if (projects.isPending || rows.length === 0) return null

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.settings.overridesOfKey.queryFilter()),
      queryClient.invalidateQueries(trpc.settings.effective.queryFilter())
    ])
  const forSelected = async (work: (projectId: string) => Promise<unknown>, done: string) => {
    setBusy(true)
    await Promise.all([...selected].map(work))
      .then(() => {
        toast.success(done)
        setSelected(new Set())
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
    await refresh()
    setBusy(false)
  }
  const resetSelected = () =>
    forSelected(
      (projectId) =>
        Promise.all(
          COLUMNS.map((c) => client.settings.clearProjectOverride.mutate({ projectId, key: c.key }))
        ),
      'Reset to hub defaults'
    )
  const setAgent = (agentId: string) =>
    forSelected(
      (projectId) =>
        client.settings.setProjectOverride.mutate({
          projectId,
          key: 'default_agent_id',
          value: agentId
        }),
      'Default agent set'
    )
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="space-y-2" data-testid="all-projects-hub" data-hub-id={hub.id ?? ''}>
      <div className="text-xs text-muted-foreground">
        {hub.label}
        {hub.isDefault ? ' · default hub' : ''}
      </div>
      {selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-surface-2 px-3 py-2 text-sm"
          data-testid="all-projects-bulk"
        >
          <span className="font-medium">{selected.size} selected</span>
          <Select onValueChange={(v) => void setAgent(v)} disabled={busy}>
            <SelectTrigger size="sm" className="w-44" aria-label="Set default agent">
              <SelectValue placeholder="Set default agent…" />
            </SelectTrigger>
            <SelectContent>
              {modes
                .filter((m) => m.enabled)
                .map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {getModeLabel(m)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void resetSelected()}
            data-testid="all-projects-reset"
          >
            Reset to hub defaults
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      )}
      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs text-muted-foreground">
            <tr>
              <th className="w-8 px-3 py-2" />
              <th className="px-3 py-2 font-medium">Project</th>
              {COLUMNS.map((c) => (
                <th key={c.key} className="px-3 py-2 font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ project, cells }) => (
              <tr key={project.id} className="border-t" data-testid="all-projects-row">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${project.name}`}
                    checked={selected.has(project.id)}
                    onChange={() => toggle(project.id)}
                  />
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    className="flex items-center gap-2 text-left hover:underline"
                    onClick={() =>
                      navigate({ kind: 'project', projectId: project.id, tab: 'agents' })
                    }
                  >
                    <span
                      aria-hidden
                      className="grid size-[18px] shrink-0 place-items-center rounded-[5px] text-[8px] font-bold text-background"
                      style={{ backgroundColor: project.color }}
                    >
                      {(project.icon_letters || project.name).slice(0, 2).toUpperCase()}
                    </span>
                    {project.name}
                  </button>
                </td>
                {cells.map((cell) => (
                  <td
                    key={cell.key}
                    className={cn(
                      'px-3 py-2',
                      cell.own ? 'font-medium text-foreground' : 'text-muted-foreground'
                    )}
                    data-own={cell.own ? 'true' : 'false'}
                    title={cell.own ? 'Set for this project' : 'From the hub'}
                  >
                    {label(cell.key, cell.value)}
                    {cell.own && <span className="ml-1.5 text-[10px] text-primary">●</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
