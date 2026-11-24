import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { HubScope, useFederationOrNull, useHubIdForProject } from '@slayzone/transport/client'
import type { Project } from '@slayzone/projects-contracts'
import { ProjectSettingsPanel, type ProjectSettingsHost } from '@slayzone/projects'
import { useTelemetry, TelemetrySettings } from '@slayzone/telemetry/client'
import { cn, toast } from '@slayzone/ui'
import { useTRPC } from '../trpc'
import { routeFromLegacyTab, type SettingsRoute } from '../settings-route'
import { closeSettings, useSettingsViewStore } from '../settings-view-store'
import { AppearanceSettingsTab } from '../tabs/AppearanceSettingsTab'
import { LayoutSettingsTab } from '../tabs/LayoutSettingsTab'
import { PanelsSettingsTab } from '../tabs/PanelsSettingsTab'
import { AiProvidersSettingsTab } from '../tabs/AiProvidersSettingsTab'
import { WorktreesSettingsTab } from '../tabs/WorktreesSettingsTab'
import { McpSettingsTab } from '../tabs/McpSettingsTab'
import { BackupSettingsTab } from '../tabs/BackupSettingsTab'
import { DataSettingsTab } from '../tabs/DataSettingsTab'
import { DiagnosticsSettingsTab } from '../tabs/DiagnosticsSettingsTab'
import { LabsSettingsTab } from '../tabs/LabsSettingsTab'
import { AboutSettingsTab } from '../tabs/AboutSettingsTab'
import { CliSettingsTab } from '../tabs/CliSettingsTab'
import { ConnectionsSettingsTab } from '../tabs/ConnectionsSettingsTab'
import { HubsSettingsTab } from '../tabs/HubsSettingsTab'
import { SettingsTabIntro } from '../tabs/SettingsTabIntro'
import { AgentHubSettings } from '../tabs/panels-settings/AgentHubSettings'
import { AllProjectsPage } from './AllProjectsPage'
import { ComputerPage } from './ComputerPage'
import { SettingsSearchResults } from './SettingsSearch'
import { ProjectAgentSettings } from './ProjectAgentSettings'
import { useNavHubs } from './SettingsNav'

export interface SettingsPagesProps {
  /** Projects for the app icon badge card; absent = this host has no app icon. */
  appBadgeProjects?: Project[]
  /**
   * The shell's live project list (every hub). A project page shows the row from
   * here when present, so an edit made elsewhere (the Relocate dialog) shows at once.
   */
  projects?: Project[]
  projectHost?: ProjectSettingsHost
}

export function SettingsPage({
  route,
  appBadgeProjects,
  projects,
  projectHost
}: { route: SettingsRoute } & SettingsPagesProps) {
  const navigate = useSettingsViewStore((s) => s.navigate)
  switch (route.kind) {
    case 'prefs':
      if (route.page === 'appearance')
        return (
          <>
            <DeviceNote />
            <AppearanceSettingsTab appBadgeProjects={appBadgeProjects} />
          </>
        )
      if (route.page === 'layout') return <LayoutSettingsTab />
      if (route.page === 'telemetry') return <TelemetryPage />
      return (
        <PanelsSettingsTab
          activeTab={route.page}
          navigateTo={(tab) => navigate({ kind: 'prefs', page: tab })}
        />
      )
    case 'app':
      if (route.page === 'labs') return <LabsSettingsTab />
      if (route.page === 'cli') return <CliSettingsTab />
      // About: this install's version and data, and its diagnostics.
      return (
        <>
          <AboutSettingsTab />
          <DiagnosticsSettingsTab />
        </>
      )
    case 'hubs':
      return <ConnectionsSettingsTab />
    case 'hub':
      return <HubPage route={route} />
    case 'computer':
      return (
        <ScopeOf hubId={route.hubId || null}>
          <ComputerPage route={route} />
        </ScopeOf>
      )
    case 'project':
      return <ProjectPage route={route} host={projectHost} live={projects} />
    case 'projects':
      return <AllProjectsPage />
    case 'search':
      return <SettingsSearchResults query={route.query} />
  }
}

/**
 * Theme, fonts and terminal rendering are kept per device (phase 4). Said only where
 * it can surprise: with more than one hub, i.e. an account other devices sign in to.
 */
function DeviceNote() {
  const federation = useFederationOrNull()
  if (!federation || federation.hubs.length < 2) return null
  return (
    <p
      className="rounded-md border px-3 py-2 text-xs text-muted-foreground"
      data-testid="settings-device-note"
    >
      Theme, fonts, text sizes and terminal rendering are saved on this device. Your other devices
      keep their own.
    </p>
  )
}

function TelemetryPage() {
  const { tier, setTier, lockedByHub, homeHubLabel, withheldHubs } = useTelemetry()
  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Privacy & telemetry"
        description="Choose what product usage data is collected. Telemetry helps improve reliability while honoring your selected privacy tier."
      />
      <TelemetrySettings
        tier={tier}
        onTierChange={setTier}
        lockedByHub={lockedByHub}
        homeHubLabel={homeHubLabel}
        withheldHubs={withheldHubs}
      />
    </div>
  )
}

/** Binds `children` to a hub: its `HubScope` inside a federation, the ambient hub otherwise. */
export function ScopeOf({ hubId, children }: { hubId: string | null; children: ReactNode }) {
  const federation = useFederationOrNull()
  if (!federation || !hubId) return <>{children}</>
  return (
    <HubScope
      key={hubId}
      hubId={hubId}
      fallback={<p className="text-sm text-muted-foreground">This hub is not connected.</p>}
    >
      {children}
    </HubScope>
  )
}

export function PageTabs<T extends string>({
  tabs,
  active,
  onSelect,
  testIdPrefix
}: {
  tabs: Array<[T, string]>
  active: string
  onSelect: (tab: T) => void
  testIdPrefix: string
}) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1 border-b">
      {tabs.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={active === key}
          data-testid={`${testIdPrefix}-${key}`}
          onClick={() => onSelect(key)}
          className={cn(
            '-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm transition-colors',
            active === key
              ? 'border-primary font-medium text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function PageHeader({
  crumb,
  title,
  children
}: {
  crumb: string
  title: string
  children?: ReactNode
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{crumb}</div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  )
}

type HubRoute = Extract<SettingsRoute, { kind: 'hub' }>

/**
 * A hub's page. Backups, import/export and the MCP port act on the machine that
 * runs the hub (`app.*` host routers), so they stay on the default hub, as in the
 * old dialog.
 */
function HubPage({ route }: { route: HubRoute }) {
  const navigate = useSettingsViewStore((s) => s.navigate)
  const hubs = useNavHubs()
  const hub = hubs.find((h) => h.id === route.hubId) ?? hubs.find((h) => h.isDefault) ?? hubs[0]
  const isDefault = !!hub?.isDefault
  const tabs: Array<[string, string]> = [
    ['overview', 'Overview'],
    ['agents', 'Agents & providers'],
    ['worktrees', 'Worktrees'],
    ...(isDefault
      ? ([
          ['mcp', 'MCP'],
          ['backups', 'Backups'],
          ['data', 'Import & export']
        ] as Array<[string, string]>)
      : [])
  ]
  const tab = tabs.some(([k]) => k === route.tab) ? route.tab : 'overview'
  const go = (next: Partial<HubRoute>) =>
    navigate({ ...route, hubId: hub?.id ?? null, sub: undefined, ...next })
  return (
    <div className="space-y-6" data-testid="settings-hub-page">
      <PageHeader crumb="Hubs" title={hub?.label ?? 'Hub'} />
      <PageTabs tabs={tabs} active={tab} onSelect={(t) => go({ tab: t })} testIdPrefix="hub-tab" />
      {/* Status, sign-in, default, edit, remove and this hub's computers: the Hubs
          page's own card (it scopes itself). */}
      {tab === 'overview' && <HubsSettingsTab onlyHubId={hub?.id ?? 'local'} />}
      <ScopeOf hubId={hub?.id ?? null}>
        {tab === 'agents' && (
          <div className="space-y-8">
            <AiProvidersSettingsTab
              activeTab={route.sub ? `ai-providers/${route.sub}` : 'ai-providers'}
              navigateTo={(t) => {
                const next = routeFromLegacyTab(t)
                go(next.kind === 'hub' ? { tab: next.tab, sub: next.sub } : {})
              }}
            />
            {!route.sub && <AgentHubSettings />}
          </div>
        )}
        {tab === 'worktrees' && <WorktreesSettingsTab />}
        {tab === 'mcp' && <McpSettingsTab />}
        {tab === 'backups' && <BackupSettingsTab />}
        {tab === 'data' && <DataSettingsTab />}
      </ScopeOf>
    </div>
  )
}

type ProjectRoute = Extract<SettingsRoute, { kind: 'project' }>

type ProjectPageProps = { route: ProjectRoute; host?: ProjectSettingsHost; live?: Project[] }

function ProjectPage({ route, host, live }: ProjectPageProps) {
  const ownerHubId = useHubIdForProject(route.projectId) ?? null
  return (
    <ScopeOf hubId={ownerHubId}>
      <ProjectPageBody route={route} host={host} live={live} />
    </ScopeOf>
  )
}

function ProjectPageBody({ route, host, live }: ProjectPageProps) {
  const trpc = useTRPC()
  const navigate = useSettingsViewStore((s) => s.navigate)
  const projects = useQuery(trpc.projects.list.queryOptions())
  const project =
    live?.find((p) => p.id === route.projectId) ??
    projects.data?.find((p) => p.id === route.projectId)
  if (!project) {
    return projects.isPending ? null : (
      <p className="text-sm text-muted-foreground">This project no longer exists.</p>
    )
  }
  return (
    <div className="space-y-6" data-testid="settings-project-page">
      <PageHeader crumb="Project" title={project.name} />
      <ProjectSettingsPanel
        {...host}
        project={project}
        tab={route.tab}
        extraTabs={[
          {
            key: 'agents',
            label: 'Agents',
            render: () => <ProjectAgentSettings projectId={project.id} />
          }
        ]}
        integrationOnboardingProvider={route.onboarding ?? null}
        onIntegrationOnboardingHandled={() =>
          navigate({ kind: 'project', projectId: route.projectId, tab: 'integrations' })
        }
        // A tab the user picks ends any onboarding landing (it forces Integrations).
        onTabChange={(tab) => navigate({ kind: 'project', projectId: route.projectId, tab })}
        onClose={closeSettings}
        // Saving keeps the page open (the dialog this replaced closed on save).
        onUpdated={(p) => {
          host?.onUpdated?.(p)
          void projects.refetch()
          toast.success('Saved')
        }}
      />
    </div>
  )
}
