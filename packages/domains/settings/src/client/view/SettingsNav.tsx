import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Plus } from 'lucide-react'
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
        'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-sm transition-colors',
        active
          ? 'bg-accent font-semibold text-foreground'
          : 'text-foreground hover:bg-accent/50'
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
        className="grid h-8 w-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
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

function PanelsGroup() {
  const route = useSettingsViewStore((s) => s.route)
  const inside = route.kind === 'prefs' && route.page.startsWith('panels/')
  const [open, setOpen] = useFold('panels', inside)
  return (
    <>
      <FoldRow open={open} onToggle={setOpen} label="Panels">
        <NavItem
          route={prefs('panels')}
          testId="settings-nav-panels"
          onOpen={() => setOpen(true)}
          match={(r) =>
            r.kind === 'prefs' && (r.page === 'panels' || r.page.startsWith('panels/web:'))
          }
        >
          Panels
        </NavItem>
      </FoldRow>
      {open && (
        <div className="ml-3.5 border-l pl-1.5">
          {PANEL_PAGES.map(([page, label]) => (
            <NavItem
              key={page}
              route={prefs(page)}
              testId={`settings-nav-${page.replace('/', '-')}`}
            >
              {label}
            </NavItem>
          ))}
        </div>
      )}
    </>
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
      {/* pr-0: the action's w-6 box lines up with the fold chevrons' w-6 box below */}
      <div className="mb-1 flex h-7 items-center pl-2.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
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
        <PanelsGroup />
        <NavItem route={prefs('telemetry')} testId="settings-nav-telemetry">
          Privacy & telemetry
        </NavItem>
      </Section>
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
        <NavItem route={{ kind: 'projects' }} testId="settings-nav-all-projects">
          All projects
        </NavItem>
      </Section>
    </nav>
  )
}

/** Live connection dot of a federated hub. */
function HubConnectionDot({ hubId }: { hubId: string }) {
  return <StatusDot tone={toneOfConnection(useHubConnection(hubId))} className="ml-auto" />
}

function HubNavRow({ hub, onOpen }: { hub: NavHub; onOpen?: () => void }) {
  return (
    <NavItem
      route={{ kind: 'hub', hubId: hub.id, tab: 'overview' }}
      testId="settings-nav-hub"
      onOpen={onOpen}
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
  const route = useSettingsViewStore((s) => s.route)
  // Unfolded by default only when the open page belongs to this hub.
  const inside =
    (route.kind === 'hub' && (route.hubId === hub.id || (route.hubId === null && hub.isDefault))) ||
    (route.kind === 'computer' && (route.hubId || null) === hub.id) ||
    (route.kind === 'project' && !!projects.data?.some((p) => p.id === route.projectId))
  const [open, setOpen] = useFold(`hub:${hub.id ?? 'ambient'}`, inside)
  return (
    <div data-testid="settings-nav-hub-group" data-hub-id={hub.id ?? ''}>
      <FoldRow open={open} onToggle={setOpen} label={hub.label}>
        <HubNavRow hub={hub} onOpen={() => setOpen(true)} />
      </FoldRow>
      {open && (
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
      )}
    </div>
  )
}
