import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Project } from '@slayzone/projects-contracts'
import { useFederationOrNull, useHubOwnershipStore } from '@slayzone/transport/client'
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Checkbox,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Switch
} from '@slayzone/ui'
import { useTRPC } from '../trpc'
import {
  APP_BADGE_KEYS,
  appBadgeProjectKey,
  parseAppBadgeSettings,
  type AppBadgeScope,
  type AppBadgeSettings,
  type AppBadgeSource,
  type AppBadgeStyle
} from '../../shared/app-badge'

const ROW = 'grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4'

const SOURCE_LABELS: Record<AppBadgeSource, string> = {
  unread: 'Unread tasks',
  idle: 'Idle agents'
}

/**
 * App icon badge (dock / taskbar). Rendered only by hosts that have an app icon —
 * the desktop app passes its merged (all-hub) project list.
 */
export function AppBadgeSettingsCard({ projects }: { projects: Project[] }) {
  const trpc = useTRPC()
  const allSettingsQuery = useQuery(trpc.settings.getAll.queryOptions())
  const queryClient = useQueryClient()
  // Refetch the shared settings snapshot on save so the badge updates live, not
  // only when the Settings dialog closes.
  const { mutate: setSetting } = useMutation(
    trpc.settings.set.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(trpc.settings.getAll.queryFilter())
    })
  )
  const federation = useFederationOrNull()
  const defaultHubId = federation?.defaultHubId ?? 'local'
  const hubIdByProject = useHubOwnershipStore((s) => s.hubIdByProject)
  const hubLabels = new Map((federation?.hubs ?? []).map((h) => [h.id, h.label]))
  const multiHub = hubLabels.size > 1

  const [state, setState] = useState<AppBadgeSettings>(() => parseAppBadgeSettings({}))
  // Each new settings snapshot re-seeds the controls — adjusted while rendering.
  const [seen, setSeen] = useState<typeof allSettingsQuery.data>()
  const all = allSettingsQuery.data
  if (all !== seen) {
    setSeen(all)
    if (all) setState(parseAppBadgeSettings(all))
  }

  const toggleSource = (source: AppBadgeSource, on: boolean): void => {
    const sources = on ? [...state.sources, source] : state.sources.filter((s) => s !== source)
    setState({ ...state, sources })
    setSetting({ key: APP_BADGE_KEYS.sources, value: JSON.stringify(sources) })
  }
  const setStyle = (style: AppBadgeStyle): void => {
    setState({ ...state, style })
    setSetting({ key: APP_BADGE_KEYS.style, value: style })
  }
  const setScope = (scope: AppBadgeScope): void => {
    setState({ ...state, scope })
    setSetting({ key: APP_BADGE_KEYS.scope, value: scope })
  }
  const setOpenTabsOnly = (openTabsOnly: boolean): void => {
    setState({ ...state, openTabsOnly })
    setSetting({ key: APP_BADGE_KEYS.openTabsOnly, value: String(openTabsOnly) })
  }
  const toggleProject = (key: string, on: boolean): void => {
    const keys = on ? [...state.projects, key] : state.projects.filter((k) => k !== key)
    setState({ ...state, projects: keys })
    setSetting({ key: APP_BADGE_KEYS.projects, value: JSON.stringify(keys) })
  }

  const off = state.sources.length === 0

  return (
    <Card data-testid="app-badge-settings">
      <CardHeader>
        <CardTitle>App icon badge</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {(Object.keys(SOURCE_LABELS) as AppBadgeSource[]).map((source) => (
          <div key={source} className={ROW}>
            <span className="text-sm">{SOURCE_LABELS[source]}</span>
            <Switch
              checked={state.sources.includes(source)}
              onCheckedChange={(on) => toggleSource(source, on)}
              data-testid={`app-badge-source-${source}`}
            />
          </div>
        ))}
        <div className={ROW}>
          <span className="text-sm">Show as</span>
          <Select value={state.style} onValueChange={(v) => setStyle(v as AppBadgeStyle)}>
            <SelectTrigger className="w-48" disabled={off}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" side="bottom">
              <SelectItem value="count">Total count</SelectItem>
              <SelectItem value="separate">One number per status</SelectItem>
              <SelectItem value="dot">Dot only</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className={ROW}>
          <span className="text-sm">Only tasks open in tabs</span>
          <Switch
            checked={state.openTabsOnly}
            disabled={off}
            onCheckedChange={setOpenTabsOnly}
            data-testid="app-badge-open-tabs-only"
          />
        </div>
        <div className={ROW}>
          <span className="text-sm">Projects</span>
          <Select value={state.scope} onValueChange={(v) => setScope(v as AppBadgeScope)}>
            <SelectTrigger className="w-48" disabled={off}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" side="bottom">
              <SelectItem value="all">All projects</SelectItem>
              <SelectItem value="selected">Selected projects</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {state.scope === 'selected' && (
          <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4">
            <span />
            <div className="space-y-1.5">
              {projects.map((p) => {
                const hubId = hubIdByProject.get(p.id) ?? defaultHubId
                const key = appBadgeProjectKey(hubId, p.id)
                return (
                  <label key={key} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={state.projects.includes(key)}
                      disabled={off}
                      onCheckedChange={(on) => toggleProject(key, on === true)}
                    />
                    <span className="truncate">{p.name}</span>
                    {multiHub && (
                      <span className="text-muted-foreground text-xs">{hubLabels.get(hubId)}</span>
                    )}
                  </label>
                )
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
