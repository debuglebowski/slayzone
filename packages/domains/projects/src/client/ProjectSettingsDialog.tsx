import { useState, useEffect, useCallback } from 'react'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { electronBootstrap, useTRPC } from '@slayzone/transport/client'
import { Dialog, DialogContent, DialogHeader, DialogTitle, useDepsChanged } from '@slayzone/ui'
import { SettingsLayout } from '@slayzone/ui'
import type { Project } from '@slayzone/projects/shared'
import type { IntegrationProvider } from '@slayzone/integrations/shared'
import { track } from '@slayzone/telemetry/client'
import { GeneralTab } from './GeneralTab'
import { EnvironmentTab } from './EnvironmentTab'
import { ColumnsTab } from './ColumnsTab'
import { IntegrationsTab } from './IntegrationsTab'
import { TestsTab } from '@slayzone/test-panel/client'
import { WorktreesTab } from './WorktreesTab'
import { ReposTab } from './ReposTab'
import { TagsSettingsTab } from '@slayzone/settings/client/tabs/TagsSettingsTab'
import { useDetectedRepos } from './useDetectedRepos'
import { TasksGeneralTab } from './TasksGeneralTab'

interface ProjectSettingsDialogProps {
  project: Project | null
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?:
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
    | 'templates'
  groupBy?: 'none' | 'path' | 'label'
  onGroupByChange?: (value: 'none' | 'path' | 'label') => void
  integrationOnboardingProvider?: IntegrationProvider | null
  onIntegrationOnboardingHandled?: () => void
  onUpdated: (project: Project) => void
  /** In-place update without closing the dialog. Falls back to onUpdated if not provided. */
  onChanged?: (project: Project) => void
  renderTemplatesTab?: (projectId: string) => React.ReactNode
}

/** Which provider's status sync locks the project's statuses (null = none, or unknown). */
async function fetchIntegrationLock(
  queryClient: QueryClient,
  trpc: ReturnType<typeof useTRPC>,
  projectId: string
): Promise<string | null> {
  try {
    const [linear, github] = await Promise.all([
      queryClient.fetchQuery(
        trpc.integrations.getProjectMapping.queryOptions({ projectId, provider: 'linear' })
      ),
      queryClient.fetchQuery(
        trpc.integrations.getProjectMapping.queryOptions({ projectId, provider: 'github' })
      )
    ])
    if (linear?.status_setup_complete) return 'Linear'
    if (github?.status_setup_complete) return 'GitHub'
    return null
  } catch {
    return null
  }
}

export function ProjectSettingsDialog({
  project,
  open,
  onOpenChange,
  initialTab = 'general',
  groupBy = 'none',
  onGroupByChange,
  integrationOnboardingProvider = null,
  onIntegrationOnboardingHandled,
  onUpdated,
  onChanged,
  renderTemplatesTab
}: ProjectSettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<
    | 'general'
    | 'environment'
    | 'tasks'
    | 'tasks/general'
    | 'tasks/statuses'
    | 'tasks/tags'
    | 'worktrees'
    | 'repos'
    | 'templates'
    | 'integrations'
    | 'tests'
  >('general')
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const detectedRepos = useDetectedRepos(open ? (project?.path ?? null) : null, project?.id)
  const [lockedByProvider, setLockedByProvider] = useState<string | null>(null)

  const checkIntegrationLock = useCallback(async () => {
    if (!project || electronBootstrap.isPlaywright()) {
      setLockedByProvider(null)
      return
    }
    setLockedByProvider(await fetchIntegrationLock(queryClient, trpc, project.id))
  }, [project, queryClient, trpc])

  // Re-check whenever the dialog opens or its project changes. The no-project /
  // e2e branch needs no round-trip, so it is adjusted during render under the
  // same trigger; only the lookup runs in the effect.
  const [lockCheckSeen, setLockCheckSeen] = useState<{
    open: boolean
    project: Project | null
    queryClient: typeof queryClient
    trpc: typeof trpc
  } | null>(null)
  if (
    lockCheckSeen === null ||
    !Object.is(lockCheckSeen.open, open) ||
    !Object.is(lockCheckSeen.project, project) ||
    !Object.is(lockCheckSeen.queryClient, queryClient) ||
    !Object.is(lockCheckSeen.trpc, trpc)
  ) {
    setLockCheckSeen({ open, project, queryClient, trpc })
    if (open && (!project || electronBootstrap.isPlaywright())) setLockedByProvider(null)
  }
  useEffect(() => {
    if (!open || !project || electronBootstrap.isPlaywright()) return
    void fetchIntegrationLock(queryClient, trpc, project.id).then(setLockedByProvider)
  }, [open, project, queryClient, trpc])

  // Pick the tab while rendering (same triggers as an effect on these deps, incl.
  // mount), so opening never commits the previously active tab first — that
  // tab would mount and run its effects/fetches for one frame. An onboarding
  // provider wins when both trigger at once (Integrations is where it lands).
  const tabTriggerChanged = useDepsChanged([open, project?.id, initialTab], true)
  const onboardingTriggerChanged = useDepsChanged([open, integrationOnboardingProvider], true)
  if (open && onboardingTriggerChanged && integrationOnboardingProvider) {
    setActiveTab('integrations')
  } else if (open && tabTriggerChanged) {
    setActiveTab(initialTab)
  }

  const navItems = [
    { key: 'general', label: 'General' },
    { key: 'environment', label: 'Environment' },
    {
      key: 'tasks',
      label: 'Tasks',
      children: [
        { key: 'tasks/general', label: 'General' },
        { key: 'tasks/statuses', label: 'Statuses' },
        { key: 'tasks/tags', label: 'Tags' }
      ]
    },
    ...(renderTemplatesTab ? [{ key: 'templates' as const, label: 'Task Templates' }] : []),
    { key: 'worktrees', label: 'Worktrees' },
    ...(detectedRepos.length > 0 ? [{ key: 'repos' as const, label: 'Repositories' }] : []),
    { key: 'tests', label: 'Tests' },
    { key: 'integrations' as const, label: 'Integrations' }
  ]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="project-settings" className="overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Project Settings</DialogTitle>
        </DialogHeader>
        <SettingsLayout
          items={navItems}
          activeKey={activeTab}
          onSelect={(key) => {
            const tab = (key === 'tasks' ? 'tasks/general' : key) as typeof activeTab
            track('project_settings_tab_viewed', { tab })
            setActiveTab(tab)
          }}
        >
          {activeTab === 'general' && project && (
            <GeneralTab
              project={project}
              onUpdated={onUpdated}
              onChanged={onChanged ?? onUpdated}
              onClose={() => onOpenChange(false)}
            />
          )}

          {activeTab === 'environment' && project && (
            <EnvironmentTab
              project={project}
              onUpdated={onUpdated}
              onClose={() => onOpenChange(false)}
            />
          )}

          {activeTab === 'worktrees' && project && (
            <WorktreesTab
              project={project}
              onUpdated={onUpdated}
              onClose={() => onOpenChange(false)}
            />
          )}

          {activeTab === 'repos' && project && (
            <ReposTab project={project} repos={detectedRepos} onUpdated={onUpdated} />
          )}

          {activeTab === 'tasks/general' && project && (
            <TasksGeneralTab project={project} onUpdated={onUpdated} />
          )}

          {activeTab === 'tasks/statuses' && project && (
            <ColumnsTab
              project={project}
              onUpdated={onUpdated}
              lockedByProvider={lockedByProvider}
            />
          )}

          {activeTab === 'integrations' && project && (
            <IntegrationsTab
              project={project}
              open={open}
              onUpdated={(p) => {
                onUpdated(p)
                void checkIntegrationLock()
              }}
              integrationOnboardingProvider={integrationOnboardingProvider}
              onIntegrationOnboardingHandled={onIntegrationOnboardingHandled}
            />
          )}

          {activeTab === 'tasks/tags' && project && <TagsSettingsTab projectId={project.id} />}

          {activeTab === 'templates' && project && renderTemplatesTab?.(project.id)}

          {activeTab === 'tests' && project && (
            <TestsTab
              projectId={project.id}
              groupBy={groupBy}
              onGroupByChange={
                onGroupByChange ??
                (() => {
                  // `groupBy` is lifted state owned by the host. TestsTab
                  // requires the setter, so a host that renders the dialog
                  // without one gets an inert group-by control, not a crash.
                })
              }
            />
          )}
        </SettingsLayout>
      </DialogContent>
    </Dialog>
  )
}
