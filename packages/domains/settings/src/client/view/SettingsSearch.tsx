import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SettingsRoute } from '../settings-route'
import { useSettingsViewStore } from '../settings-view-store'
import { useTRPC } from '../trpc'
import { ScopeOf } from './SettingsPages'
import { useNavHubs, useSoloLocalHub, type NavHub } from './SettingsNav'

interface Entry {
  label: string
  /** Where it lives, shown under the label. */
  path: string
  /** Words a search should find it by (besides its label). */
  keywords: string
  route: SettingsRoute
}

const PREFS: Array<[string, string, string]> = [
  ['appearance', 'Appearance', 'theme color dark light font size reduce motion tint badge icon'],
  ['layout', 'Layout', 'sidebar tabs tree view chat width project scoped'],
  [
    'panels',
    'Panels',
    'panel web panels browser editor git terminal font family scrollback option meta diff word wrap whitespace commit graph shortcut'
  ],
  ['telemetry', 'Privacy & telemetry', 'telemetry privacy analytics usage data']
]
const APP: Array<[string, string, string]> = [
  [
    'about',
    'About',
    'version database path diagnostics logs logging verbose export bundle sidecar local hub process'
  ],
  ['cli', 'CLI', 'slay command line terminal install'],
  ['labs', 'Labs', 'experimental loop tests panel']
]
/** A hub's tabs; `defaultOnly`: offered on the default hub only (`HubPage`). */
const HUB_TABS: Array<[string, string, string, boolean]> = [
  [
    'overview',
    'Overview',
    'status sign in login default hub address remove disconnect users summary',
    false
  ],
  ['computers', 'Computers', 'computers enroll add machine restart disable replace', false],
  [
    'agents',
    'Agents & providers',
    'default agent provider startup manual auto instant idle close flags chat permission mode model effort custom agent',
    false
  ],
  ['worktrees', 'Worktrees', 'worktree base path auto create copy files presets submodules', false],
  ['mcp', 'MCP', 'mcp port server', true],
  ['backups', 'Backups', 'backup restore snapshot chat backups', true],
  ['data', 'Import & export', 'import export project file', true]
]

const matches = (q: string, e: Pick<Entry, 'label' | 'keywords' | 'path'>) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const hay = `${e.label} ${e.path} ${e.keywords}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

/**
 * Search across Settings (plans/settings-by-scope.md, phase 5): pages, every hub's
 * tabs, and each hub's computers and projects by name. Each hub's own entries are
 * listed inside that hub's scope.
 */
export function SettingsSearchResults({ query }: { query: string }) {
  const hubs = useNavHubs()
  const fixed: Entry[] = [
    ...PREFS.map(([page, label, keywords]) => ({
      label,
      path: 'Preferences',
      keywords,
      route: { kind: 'prefs', page } as SettingsRoute
    })),
    ...APP.map(([page, label, keywords]) => ({
      label,
      path: 'App',
      keywords,
      route: { kind: 'app', page } as SettingsRoute
    })),
    {
      label: 'All projects',
      path: 'Hubs',
      keywords: 'compare overrides bulk',
      route: { kind: 'projects' } as SettingsRoute
    }
  ].filter((e) => matches(query, e))
  return (
    <div className="space-y-6" data-testid="settings-search-results">
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">Search</div>
        <h1 className="text-2xl font-semibold tracking-tight">Results for “{query}”</h1>
      </div>
      {fixed.length > 0 && <ResultList entries={fixed} />}
      {hubs.map((hub) => (
        <ScopeOf key={hub.id ?? 'ambient'} hubId={hub.id}>
          <HubResults hub={hub} query={query} />
        </ScopeOf>
      ))}
    </div>
  )
}

function HubResults({ hub, query }: { hub: NavHub; query: string }) {
  const trpc = useTRPC()
  const computers = useQuery(trpc.computers.list.queryOptions())
  const projects = useQuery(trpc.projects.list.queryOptions())
  // The only hub, and local: no hubs or computers as such (see `useSoloLocalHub`).
  const solo = !!useSoloLocalHub()
  const path = solo ? 'Workspace' : `Hub · ${hub.label}`
  const entries: Entry[] = [
    ...HUB_TABS.filter(
      ([tab, , , defaultOnly]) =>
        (!defaultOnly || hub.isDefault) && !(solo && (tab === 'overview' || tab === 'computers'))
    ).map(([tab, label, keywords]) => ({
      label,
      path,
      keywords,
      route: { kind: 'hub', hubId: hub.id, tab } as SettingsRoute
    })),
    ...(computers.data ?? [])
      .filter((c) => c.revokedAt == null)
      .map((c) => ({
        label: solo ? 'This machine' : c.name,
        path: solo ? path : `${path} · computer`,
        keywords: 'computer folders roots restart disable chat backups',
        route: {
          kind: 'computer',
          hubId: hub.id ?? '',
          computerId: c.id,
          tab: 'general'
        } as SettingsRoute
      })),
    ...(projects.data ?? []).map((p) => ({
      label: p.name,
      path: `${path} · project`,
      keywords: 'project',
      route: { kind: 'project', projectId: p.id, tab: 'general' } as SettingsRoute
    }))
  ].filter((e) => matches(query, e))
  if (entries.length === 0) return null
  return <ResultList entries={entries} />
}

function ResultList({ entries }: { entries: Entry[] }) {
  return (
    <div className="divide-y rounded-lg border">
      {entries.map((e) => (
        <ResultRow key={`${e.path}/${e.label}/${JSON.stringify(e.route)}`} route={e.route}>
          <div className="text-sm">{e.label}</div>
          <div className="text-xs text-muted-foreground">{e.path}</div>
        </ResultRow>
      ))}
    </div>
  )
}

function ResultRow({ route, children }: { route: SettingsRoute; children: ReactNode }) {
  const navigate = useSettingsViewStore((s) => s.navigate)
  return (
    <button
      type="button"
      className="block w-full px-4 py-2.5 text-left hover:bg-accent/50"
      onClick={() => navigate(route)}
      data-testid="settings-search-result"
    >
      {children}
    </button>
  )
}
