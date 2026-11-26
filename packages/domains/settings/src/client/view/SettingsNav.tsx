import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DEFAULT_LOCAL_COMPUTER_NAME } from '@slayzone/platform/computer-identity'
import { ChevronRight, Plus } from 'lucide-react'
import { HubScope, useFederationOrNull, useHubConnection } from '@slayzone/transport/client'
import { cn } from '@slayzone/ui'
import { useTRPC } from '../trpc'
import { sameRoute, type SettingsRoute } from '../settings-route'
import { useSettingsViewStore } from '../settings-view-store'
import { StatusDot, toneOfConnection } from './StatusDot'
import { hubPageTabs } from './hub-tabs'

/** The hubs the nav lists: the federation's, or this client's one hub outside it. */
export interface NavHub {
  /** Null outside a federation: the ambient (only) hub. */
  id: string | null
  label: string
  isDefault: boolean
  /** This machine's own hub. The ambient hub outside a federation (the Chromium fork) is. */
  isLocal: boolean
}

export function useNavHubs(): NavHub[] {
  const federation = useFederationOrNull()
  if (!federation) return [{ id: null, label: 'This hub', isDefault: true, isLocal: true }]
  return federation.hubs
    .filter((h) => !!h.url)
    .map((h) => ({
      id: h.id,
      label: h.label,
      isDefault: h.id === federation.defaultHubId,
      isLocal: h.kind === 'local'
    }))
}

/**
 * The local hub, when it is the only hub. Then the Settings view drops hubs and
 * computers as concepts: its hub-wide pages are plain Workspace pages, its one
 * computer is "This machine", and adding a hub is the way back to them.
 */
export function useSoloLocalHub(): NavHub | null {
  const hubs = useNavHubs()
  return hubs.length === 1 && hubs[0]!.isLocal ? hubs[0]! : null
}

function NavItem({
  route,
  children,
  match,
  testId,
  onOpen
}: {
  route: SettingsRoute
  children: ReactNode
  /** Highlight for every route this returns true for (a page and its sub-pages). */
  match?: (current: SettingsRoute) => boolean
  testId?: string
  /** Also run on click (a group row unfolds its items). */
  onOpen?: () => void
}) {
  const current = useSettingsViewStore((s) => s.route)
  const navigate = useSettingsViewStore((s) => s.navigate)
  const active = match ? match(current) : sameRoute(current, route)
  return (
    <button
      type="button"
      data-testid={testId}
      aria-current={active ? 'page' : undefined}
      onClick={() => {
        onOpen?.()
        navigate(route)
      }}
      className={cn(
        'flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-sm transition-colors',
        active ? 'bg-accent font-semibold text-foreground' : 'text-foreground hover:bg-accent/50'
      )}
    >
      {children}
    </button>
  )
}

/**
 * A nav group's fold state: what the user chose, else unfolded exactly when the open
 * page is inside the group. Kept in the view store while the app runs.
 */
function useFold(group: string, containsCurrent: boolean): [boolean, (open: boolean) => void] {
  const chosen = useSettingsViewStore((s) => s.folds[group])
  const setFold = useSettingsViewStore((s) => s.setFold)
  return [chosen ?? containsCurrent, (open) => setFold(group, open)]
}

/** A group row: the row opens its page and unfolds; the chevron folds and unfolds. */
function FoldRow({
  open,
  onToggle,
  label,
  children
}: {
  open: boolean
  onToggle: (open: boolean) => void
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-0.5">
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? 'Fold' : 'Unfold'} ${label}`}
        onClick={() => onToggle(!open)}
        className="grid h-7 w-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        data-testid="settings-nav-fold"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      </button>
    </div>
  )
}

const PANEL_PAGES = [
  ['panels/terminal', 'Terminal'],
  ['panels/editor', 'Editor'],
  ['panels/git', 'Git & diff'],
  ['panels/browser', 'Browser']
] as const

/** The Panels section: the shared panels page, then one page per panel. */
function PanelsSection() {
  return (
    <Section title="Panels">
      <NavItem
        route={prefs('panels')}
        testId="settings-nav-panels"
        match={(r) =>
          r.kind === 'prefs' && (r.page === 'panels' || r.page.startsWith('panels/web:'))
        }
      >
        General
      </NavItem>
      {PANEL_PAGES.map(([page, label]) => (
        <NavItem key={page} route={prefs(page)} testId={`settings-nav-${page.replace('/', '-')}`}>
          {label}
        </NavItem>
      ))}
    </Section>
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
    <div className="pb-4">
      {/* pr-0: the action's w-6 box lines up with the fold chevrons' w-6 box below */}
      <div className="flex h-6 items-center pl-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
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
  const solo = useSoloLocalHub()
  const navigate = useSettingsViewStore((s) => s.navigate)
  return (
    <nav className="min-h-0 flex-1 overflow-y-auto px-3 pt-6 pb-6" aria-label="Settings sections">
      <Section title="Preferences">
        <NavItem route={prefs('appearance')} testId="settings-nav-appearance">
          Appearance
        </NavItem>
        <NavItem route={prefs('layout')} testId="settings-nav-layout">
          Layout
        </NavItem>
        <NavItem route={prefs('telemetry')} testId="settings-nav-telemetry">
          Privacy & telemetry
        </NavItem>
      </Section>
      <PanelsSection />
      <Section title="App">
        <NavItem route={app('about')} testId="settings-nav-about">
          About
        </NavItem>
        <NavItem route={app('cli')} testId="settings-nav-cli">
          CLI
        </NavItem>
        <NavItem route={app('labs')} testId="settings-nav-labs">
          Labs
        </NavItem>
      </Section>
      {solo ? (
        <>
          <ScopeOf hubId={solo.id}>
            <WorkspaceNav hub={solo} />
          </ScopeOf>
          {/* A local hub takes no other computers: adding a hub is the next step. */}
          <NavItem route={{ kind: 'hubs' }} testId="settings-nav-hubs">
            <LeadSlot>
              <Plus className="size-3.5 text-muted-foreground" />
            </LeadSlot>
            Add hub
          </NavItem>
        </>
      ) : (
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
      )}
    </nav>
  )
}

/** A row's leading 18px box (a hub's dot, the Add hub icon), as wide as the project blobs. */
function LeadSlot({ children }: { children?: ReactNode }) {
  return (
    <span aria-hidden className="grid size-[18px] shrink-0 place-items-center">
      {children}
    </span>
  )
}

/** Live connection dot of a federated hub. */
function HubConnectionDot({ hubId }: { hubId: string }) {
  return <StatusDot tone={toneOfConnection(useHubConnection(hubId))} />
}

/**
 * The route is this hub's own page or one of its computers' (reached from the hub
 * page; the nav lists no computers, so the hub row stays lit for them).
 */
function isHubPage(hub: NavHub, r: SettingsRoute): boolean {
  // a legacy deep link names no hub (`hubId: null`): it means the default one
  if (r.kind === 'hub') return r.hubId === hub.id || (r.hubId === null && hub.isDefault)
  // outside a federation (`hub.id` null) there is one hub: every computer is its
  if (r.kind === 'computer') return hub.id === null || r.hubId === hub.id
  return false
}

function HubNavRow({ hub, onOpen }: { hub: NavHub; onOpen?: () => void }) {
  return (
    <NavItem
      route={{ kind: 'hub', hubId: hub.id, tab: 'overview' }}
      testId="settings-nav-hub"
      onOpen={onOpen}
      match={(r) => isHubPage(hub, r)}
    >
      <LeadSlot>{hub.id && <HubConnectionDot hubId={hub.id} />}</LeadSlot>
      <span className="truncate">{hub.label}</span>
      {hub.isDefault && (
        <span className="shrink-0 rounded-full border px-1.5 text-[10px] leading-4 text-muted-foreground">
          default
        </span>
      )}
    </NavItem>
  )
}

/** Inside the hub's scope (outside a federation there is none to enter). */
function ScopeOf({ hubId, children }: { hubId: string | null; children: ReactNode }) {
  if (!hubId) return <>{children}</>
  return (
    <HubScope hubId={hubId} fallback={null}>
      {children}
    </HubScope>
  )
}

/** The only hub, as plain pages: its hub-wide settings, this machine, its projects. */
function WorkspaceNav({ hub }: { hub: NavHub }) {
  const trpc = useTRPC()
  const projects = useQuery(trpc.projects.list.queryOptions())
  const computers = useQuery(trpc.computers.list.queryOptions())
  // The app's own computer on its own hub (found by its enroll name, as on its page).
  // Missing (it never enrolled): the Computers tab, which says why and offers Start.
  const local = computers.data?.find(
    (c) => c.revokedAt == null && c.name === DEFAULT_LOCAL_COMPUTER_NAME
  )
  return (
    <>
      <Section title="Workspace">
        {hubPageTabs({ isDefault: true, solo: true, isLocal: true }).map(([tab, label]) => (
          <NavItem
            key={tab}
            route={{ kind: 'hub', hubId: hub.id, tab }}
            testId={`settings-nav-workspace-${tab}`}
            match={(r) => r.kind === 'hub' && r.tab === tab}
          >
            {label}
          </NavItem>
        ))}
        <NavItem
          route={
            local
              ? { kind: 'computer', hubId: hub.id ?? 'local', computerId: local.id, tab: 'general' }
              : { kind: 'hub', hubId: hub.id, tab: 'computers' }
          }
          testId="settings-nav-this-machine"
          match={(r) => r.kind === 'computer' || (r.kind === 'hub' && r.tab === 'computers')}
        >
          This machine
        </NavItem>
      </Section>
      {(projects.data ?? []).length > 0 && (
        <Section title="Projects">
          {(projects.data ?? []).map((p) => (
            <ProjectNavItem key={p.id} project={p} />
          ))}
        </Section>
      )}
    </>
  )
}

function ProjectNavItem({
  project: p
}: {
  project: { id: string; name: string; color: string; icon_letters?: string | null }
}) {
  return (
    <NavItem
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
  )
}

/** A hub, then its projects (its computers are listed on its page). Rendered inside the hub's own scope. */
function HubNavGroup({ hub }: { hub: NavHub }) {
  const trpc = useTRPC()
  const projects = useQuery(trpc.projects.list.queryOptions())
  const route = useSettingsViewStore((s) => s.route)
  // Unfolded by default only when the open page belongs to this hub.
  const inside =
    isHubPage(hub, route) ||
    (route.kind === 'project' && !!projects.data?.some((p) => p.id === route.projectId))
  const [open, setOpen] = useFold(`hub:${hub.id ?? 'ambient'}`, inside)
  return (
    <div data-testid="settings-nav-hub-group" data-hub-id={hub.id ?? ''}>
      <FoldRow open={open} onToggle={setOpen} label={hub.label}>
        <HubNavRow hub={hub} onOpen={() => setOpen(true)} />
      </FoldRow>
      {open && (
        <div className="ml-3.5 border-l pl-1.5">
          {(projects.data ?? []).map((p) => (
            <ProjectNavItem key={p.id} project={p} />
          ))}
        </div>
      )}
    </div>
  )
}
