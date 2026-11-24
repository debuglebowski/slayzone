import { useEffect, useState, type ReactNode } from 'react'
import { electronBootstrap } from '@slayzone/transport/client'
import { cn } from '@slayzone/ui'
import type { Project } from '@slayzone/projects-contracts'
import { defaultProjectRoot } from '@slayzone/projects-contracts'
import { useTrack } from '@slayzone/telemetry/client'
import { TestsTab } from '@slayzone/test-panel/client'
import { GeneralTab } from './GeneralTab'
import { EnvironmentTab } from './EnvironmentTab'
import { ColumnsTab } from './ColumnsTab'
import { WorktreesTab } from './WorktreesTab'
import { ReposTab } from './ReposTab'
import { TasksGeneralTab } from './TasksGeneralTab'
import { MembersTab } from './sharing/MembersTab'
import { useSharingStatus } from './sharing/useSharing'
import {
  getProjectSettingsTabs,
  useProjectDetectedRepos,
  useStatusSyncLockLookup,
  type IntegrationOnboardingProvider,
  type IntegrationsSettingsTabProps
} from './ProjectSettingsTabs'

export type ProjectSettingsTab =
  | 'general'
  | 'environment'
  | 'tasks'
  | 'tasks/general'
  | 'tasks/statuses'
  | 'tasks/tags'
  | 'worktrees'
  | 'repos'
  | 'integrations'
  | 'tests'
  | 'members'
  | 'templates'

/** What the hosting shell provides; the same for every project it shows. */
export interface ProjectSettingsHost {
  onUpdated?: (project: Project) => void
  /** In-place update; falls back to `onUpdated`. */
  onChanged?: (project: Project) => void
  groupBy?: 'none' | 'path' | 'label'
  onGroupByChange?: (value: 'none' | 'path' | 'label') => void
  renderTemplatesTab?: (projectId: string) => ReactNode
}

/** A tab another feature adds to a project's settings (shown after General). */
export interface ProjectSettingsExtraTab {
  key: string
  label: string
  render: () => ReactNode
}

export interface ProjectSettingsPanelProps extends ProjectSettingsHost {
  integrationOnboardingProvider?: IntegrationOnboardingProvider | null
  onIntegrationOnboardingHandled?: () => void
  extraTabs?: ProjectSettingsExtraTab[]
  project: Project
  tab: string
  onTabChange: (tab: string) => void
  /** A tab's "done" action (e.g. after relocating the folder). */
  onClose: () => void
}

/** `tasks` was a nav group in the dialog; its first child is the page. */
function normalizeTab(tab: string): ProjectSettingsTab {
  return (tab === 'tasks' ? 'tasks/general' : tab) as ProjectSettingsTab
}

/**
 * A project's settings, as tabs: the body of the Settings view's project page.
 * Must render inside the project's hub scope — every tab uses the ambient tRPC.
 */
export function ProjectSettingsPanel({
  project,
  tab: rawTab,
  onTabChange,
  onClose,
  onUpdated = () => {},
  onChanged,
  groupBy = 'none',
  onGroupByChange,
  integrationOnboardingProvider = null,
  onIntegrationOnboardingHandled,
  renderTemplatesTab,
  extraTabs = []
}: ProjectSettingsPanelProps) {
  const { trackProject } = useTrack()
  const lookupStatusSyncLock = useStatusSyncLockLookup()
  const sharing = useSharingStatus()
  const detectedRepos = useProjectDetectedRepos(defaultProjectRoot(project), project.id)
  const [lockedByProvider, setLockedByProvider] = useState<string | null>(null)

  const checkIntegrationLock = () => {
    if (electronBootstrap.isPlaywright()) return
    void lookupStatusSyncLock(project.id).then(setLockedByProvider)
  }
  useEffect(() => {
    if (electronBootstrap.isPlaywright()) return
    void lookupStatusSyncLock(project.id).then(setLockedByProvider)
  }, [project.id, lookupStatusSyncLock])

  // An onboarding provider (a project created from GitHub/Linear) lands on
  // Integrations, whatever tab the route named.
  const tab: string = integrationOnboardingProvider ? 'integrations' : normalizeTab(rawTab)

  const tabs: Array<[string, string]> = [
    ['general', 'General'],
    ...extraTabs.map((t): [string, string] => [t.key, t.label]),
    ['environment', 'Environment'],
    ['tasks/general', 'Tasks'],
    ['tasks/statuses', 'Statuses'],
    ['tasks/tags', 'Tags'],
    ...(renderTemplatesTab
      ? [['templates', 'Task templates'] as [ProjectSettingsTab, string]]
      : []),
    ['worktrees', 'Worktrees'],
    ...(detectedRepos.length > 0
      ? [['repos', 'Repositories'] as [ProjectSettingsTab, string]]
      : []),
    ['tests', 'Tests'],
    ['integrations', 'Integrations'],
    // Only on a hub with login: there are other people to share with (T-100).
    ...(sharing.enabled ? [['members', 'Members'] as [ProjectSettingsTab, string]] : [])
  ]

  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="Project settings" className="flex flex-wrap gap-1 border-b">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            data-testid={`project-settings-tab-${key}`}
            onClick={() => {
              trackProject(project.id, 'project_settings_tab_viewed', { tab: key })
              onTabChange(key)
            }}
            className={cn(
              '-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm transition-colors',
              tab === key
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {extraTabs.find((t) => t.key === tab)?.render()}
      {tab === 'general' && (
        <GeneralTab
          project={project}
          onUpdated={onUpdated}
          onChanged={onChanged ?? onUpdated}
          onClose={onClose}
        />
      )}
      {tab === 'environment' && (
        <EnvironmentTab project={project} onUpdated={onUpdated} onClose={onClose} />
      )}
      {tab === 'worktrees' && (
        <WorktreesTab project={project} onUpdated={onUpdated} onClose={onClose} />
      )}
      {tab === 'repos' && (
        <ReposTab project={project} repos={detectedRepos} onUpdated={onUpdated} />
      )}
      {tab === 'tasks/general' && <TasksGeneralTab project={project} onUpdated={onUpdated} />}
      {tab === 'tasks/statuses' && (
        <ColumnsTab project={project} onUpdated={onUpdated} lockedByProvider={lockedByProvider} />
      )}
      {tab === 'integrations' && (
        <RegisteredIntegrationsTab
          project={project}
          open
          onUpdated={(p) => {
            onUpdated(p)
            checkIntegrationLock()
          }}
          integrationOnboardingProvider={integrationOnboardingProvider}
          onIntegrationOnboardingHandled={onIntegrationOnboardingHandled}
        />
      )}
      {tab === 'tasks/tags' && <RegisteredTagsTab projectId={project.id} />}
      {tab === 'members' && <MembersTab project={project} />}
      {tab === 'templates' && renderTemplatesTab?.(project.id)}
      {tab === 'tests' && (
        <TestsTab
          projectId={project.id}
          groupBy={groupBy}
          // `groupBy` is lifted state owned by the host; a host without a setter gets
          // an inert control, not a crash.
          onGroupByChange={onGroupByChange ?? (() => {})}
        />
      )}
    </div>
  )
}

/** The app-registered tag editor (see ProjectSettingsTabs.ts). */
function RegisteredTagsTab({ projectId }: { projectId: string }) {
  const { TagsSettingsTab } = getProjectSettingsTabs()
  return <TagsSettingsTab projectId={projectId} />
}

/** The app-registered Integrations tab (see ProjectSettingsTabs.ts). */
function RegisteredIntegrationsTab(props: IntegrationsSettingsTabProps) {
  const { IntegrationsTab } = getProjectSettingsTabs()
  return <IntegrationsTab {...props} />
}
