import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { HubScope, useFederationOrNull, useHubConnection } from '@slayzone/transport/client'
import { computerStatus } from '@slayzone/computers/labels'
import { cn } from '@slayzone/ui'
import { useTRPC } from '../trpc'
import { sameRoute, type SettingsRoute } from '../settings-route'
import { useSettingsViewStore } from '../settings-view-store'
import { StatusDot, toneOfConnection } from './StatusDot'

/** The hubs the nav lists: the federation's, or this client's one hub outside it. */
export interface NavHub {
  /** Null outside a federation: the ambient (only) hub. */
  id: string | null
  label: string
  isDefault: boolean
}

export function useNavHubs(): NavHub[] {
  const federation = useFederationOrNull()
  if (!federation) return [{ id: null, label: 'This hub', isDefault: true }]
  return federation.hubs
    .filter((h) => !!h.url)
    .map((h) => ({ id: h.id, label: h.label, isDefault: h.id === federation.defaultHubId }))
}

function NavItem({
  route,
  children,
  match,
  testId
}: {
  route: SettingsRoute
  children: ReactNode
  /** Highlight for every route this returns true for (a page and its sub-pages). */
  match?: (current: SettingsRoute) => boolean
  testId?: string
}) {
  const current = useSettingsViewStore((s) => s.route)
  const navigate = useSettingsViewStore((s) => s.navigate)
  const active = match ? match(current) : sameRoute(current, route)
  return (
    <button
      type="button"
      data-testid={testId}
      aria-current={active ? 'page' : undefined}
      onClick={() => navigate(route)}
      className={cn(
        'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-sm transition-colors',
        active
          ? 'bg-accent font-semibold text-foreground'
          : 'text-foreground/80 hover:bg-accent/50 hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

function Section({
  title,
  action,
  children
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="pb-9">
      <div className="mb-1 flex h-7 items-center px-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-foreground/70">
        {title}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

const prefs = (page: string): SettingsRoute => ({ kind: 'prefs', page })
const app = (page: string): SettingsRoute => ({ kind: 'app', page })

export function SettingsNav() {
  const hubs = useNavHubs()
  const navigate = useSettingsViewStore((s) => s.navigate)
  return (
    <nav className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-6" aria-label="Settings sections">
      <Section title="Preferences">
        <NavItem route={prefs('appearance')} testId="settings-nav-appearance">
          Appearance
        </NavItem>
        <NavItem route={prefs('layout')} testId="settings-nav-layout">
          Layout
        </NavItem>
        <NavItem
          route={prefs('panels')}
          testId="settings-nav-panels"
          match={(r) => r.kind === 'prefs' && (r.page === 'panels' || r.page.startsWith('panels/'))}
        >
          Panels
        </NavItem>
        <NavItem route={prefs('telemetry')} testId="settings-nav-telemetry">
          Privacy & telemetry
        </NavItem>
      </Section>
      <Section title="App">
        <NavItem route={app('diagnostics')} testId="settings-nav-diagnostics">
          Diagnostics
        </NavItem>
        <NavItem route={app('labs')} testId="settings-nav-labs">
          Labs
        </NavItem>
        <NavItem route={app('about')} testId="settings-nav-about">
          About
        </NavItem>
      </Section>
      <Section
        title="Hubs"
        action={
          <button
            type="button"
            title="Add or manage hubs"
            aria-label="Add or manage hubs"
            data-testid="settings-nav-hubs"
            onClick={() => navigate({ kind: 'hubs' })}
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-3.5" />
          </button>
        }
      >
        {hubs.map((hub) =>
          hub.id ? (
            <HubScope key={hub.id} hubId={hub.id} fallback={<HubNavRow hub={hub} />}>
              <HubNavGroup hub={hub} />
            </HubScope>
          ) : (
            <HubNavGroup key="ambient" hub={hub} />
          )
        )}
      </Section>
    </nav>
  )
}

/** Live connection dot of a federated hub. */
function HubConnectionDot({ hubId }: { hubId: string }) {
  return <StatusDot tone={toneOfConnection(useHubConnection(hubId))} className="ml-auto" />
}

function HubNavRow({ hub }: { hub: NavHub }) {
  return (
    <NavItem
      route={{ kind: 'hub', hubId: hub.id, tab: 'agents' }}
      testId="settings-nav-hub"
      // a legacy deep link names no hub (`hubId: null`): it means the default one
      match={(r) => r.kind === 'hub' && (r.hubId === hub.id || (r.hubId === null && hub.isDefault))}
    >
      <span className="truncate">{hub.label}</span>
      {hub.isDefault && (
        <span className="shrink-0 rounded-full border px-1.5 text-[10px] leading-4 text-muted-foreground">
          default
        </span>
      )}
      {hub.id && <HubConnectionDot hubId={hub.id} />}
    </NavItem>
  )
}

/** A hub, then its computers and projects. Rendered inside the hub's own scope. */
function HubNavGroup({ hub }: { hub: NavHub }) {
  const trpc = useTRPC()
  const computers = useQuery(
    trpc.computers.list.queryOptions(undefined, { refetchInterval: 10_000 })
  )
  const projects = useQuery(trpc.projects.list.queryOptions())
  return (
    <div data-testid="settings-nav-hub-group" data-hub-id={hub.id ?? ''}>
      <HubNavRow hub={hub} />
      <div className="ml-3.5 border-l pl-1.5">
        {(computers.data ?? [])
          .filter((c) => c.revokedAt == null)
          .map((c) => (
            <NavItem
              key={c.id}
              testId="settings-nav-computer"
              route={{ kind: 'computer', hubId: hub.id ?? '', computerId: c.id, tab: 'general' }}
              match={(r) => r.kind === 'computer' && r.computerId === c.id}
            >
              <span className="truncate">{c.name}</span>
              <StatusDot tone={computerStatus(c).tone} className="ml-auto" />
            </NavItem>
          ))}
        {(projects.data ?? []).map((p) => (
          <NavItem
            key={p.id}
            testId="settings-nav-project"
            route={{ kind: 'project', projectId: p.id, tab: 'general' }}
            match={(r) => r.kind === 'project' && r.projectId === p.id}
          >
            <span
              aria-hidden
              className="grid size-[18px] shrink-0 place-items-center rounded-[5px] text-[8px] font-bold text-background"
              style={{ backgroundColor: p.color }}
            >
              {(p.icon_letters || p.name).slice(0, 2).toUpperCase()}
            </span>
            <span className="truncate">{p.name}</span>
          </NavItem>
        ))}
      </div>
    </div>
  )
}
