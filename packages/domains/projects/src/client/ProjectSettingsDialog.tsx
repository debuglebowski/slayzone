import { useState, useEffect, useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
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
  initialTab?: 'general' | 'environment' | 'tasks' | 'tasks/general' | 'tasks/statuses' | 'tasks/tags' | 'worktrees' | 'repos' | 'integrations' | 'ai-config' | 'tests' | 'templates'
  groupBy?: 'none' | 'path' | 'label'
  onGroupByChange?: (value: 'none' | 'path' | 'label') => void
  integrationOnboardingProvider?: IntegrationProvider | null
  onIntegrationOnboardingHandled?: () => void
  onUpdated: (project: Project) => void
  /** In-place update without closing the dialog. Falls back to onUpdated if not provided. */
  onChanged?: (project: Project) => void
  renderTemplatesTab?: (projectId: string) => React.ReactNode
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
  const [activeTab, setActiveTab] = useState<'general' | 'environment' | 'tasks' | 'tasks/general' | 'tasks/statuses' | 'tasks/tags' | 'worktrees' | 'repos' | 'templates' | 'integrations' | 'ai-config' | 'tests'>('general')
  const detectedRepos = useDetectedRepos(open ? project?.path ?? null : null)
  const [lockedByProvider, setLockedByProvider] = useState<string | null>(null)

  const checkIntegrationLock = useCallback(async () => {
    if (!project || window.api.app.isPlaywright) {
      setLockedByProvider(null)
      return
    }
    try {
      const [linear, github] = await Promise.all([
        window.api.integrations.getProjectMapping(project.id, 'linear'),
        window.api.integrations.getProjectMapping(project.id, 'github')
      ])
      if (linear?.status_setup_complete) setLockedByProvider('Linear')
      else if (github?.status_setup_complete) setLockedByProvider('GitHub')
      else setLockedByProvider(null)
    } catch {
      setLockedByProvider(null)
    }
  }, [project])

  useEffect(() => {
    if (open) void checkIntegrationLock()
  }, [open, checkIntegrationLock])

  useEffect(() => {
    if (open) {
      setActiveTab(initialTab)
    }
  }, [open, project?.id, initialTab])

  useEffect(() => {
    if (!open) return
    if (!integrationOnboardingProvider) return
    setActiveTab('integrations')
  }, [open, integrationOnboardingProvider])


  const navItems = [
    { key: 'general', label: 'General' },
    { key: 'environment', label: 'Environment' },
    {
      key: 'tasks',
      label: 'Tasks',
      children: [
        { key: 'tasks/general', label: 'General' },
        { key: 'tasks/statuses', label: 'Statuses' },
        { key: 'tasks/tags', label: 'Tags' },
      ]
    },
    ...(renderTemplatesTab ? [{ key: 'templates' as const, label: 'Task Templates' }] : []),
    { key: 'worktrees', label: 'Worktrees' },
    ...(detectedRepos.length > 0 ? [{ key: 'repos' as const, label: 'Repositories' }] : []),
    { key: 'tests', label: 'Tests' },
    { key: 'integrations' as const, label: 'Integrations' },
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
            <ReposTab
              project={project}
              repos={detectedRepos}
              onUpdated={onUpdated}
            />
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
              onUpdated={(p) => { onUpdated(p); void checkIntegrationLock() }}
              integrationOnboardingProvider={integrationOnboardingProvider}
              onIntegrationOnboardingHandled={onIntegrationOnboardingHandled}
            />
          )}

          {activeTab === 'tasks/tags' && project && (
            <TagsSettingsTab projectId={project.id} />
          )}

          {activeTab === 'templates' && project && renderTemplatesTab?.(project.id)}

          {activeTab === 'tests' && project && (
            <TestsTab
              projectId={project.id}
              groupBy={groupBy}
              onGroupByChange={onGroupByChange ?? (() => {})}
            />
          )}

        </SettingsLayout>
      </DialogContent>
    </Dialog>
  )
}
