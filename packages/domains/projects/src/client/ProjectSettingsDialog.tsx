import { useState, useEffect, useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { SettingsLayout } from '@slayzone/ui'
import type { Project } from '@slayzone/projects/shared'
import type { IntegrationProvider } from '@slayzone/integrations/shared'
import type { GlobalContextManagerSection } from '../../../ai-config/src/client/ContextManagerSettings'
import { GeneralTab } from './GeneralTab'
import { EnvironmentTab } from './EnvironmentTab'
import { ColumnsTab } from './ColumnsTab'
import { IntegrationsTab } from './IntegrationsTab'
import { AiConfigTab } from './AiConfigTab'
import { TestsTab } from '@slayzone/test-panel/client'
import { WorktreesTab } from './WorktreesTab'

interface ProjectSettingsDialogProps {
  project: Project | null
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: 'general' | 'environment' | 'columns' | 'worktrees' | 'integrations' | 'ai-config' | 'tests'
  groupBy?: 'none' | 'path' | 'label'
  onGroupByChange?: (value: 'none' | 'path' | 'label') => void
  integrationOnboardingProvider?: IntegrationProvider | null
  onIntegrationOnboardingHandled?: () => void
  onOpenGlobalAiConfig?: (section: GlobalContextManagerSection) => void
  onUpdated: (project: Project) => void
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
  onOpenGlobalAiConfig,
  onUpdated
}: ProjectSettingsDialogProps) {
  const [integrationsEnabled, setIntegrationsEnabled] = useState(window.api.app.isIntegrationsEnabledSync)
  const [activeTab, setActiveTab] = useState<'general' | 'environment' | 'columns' | 'worktrees' | 'integrations' | 'ai-config' | 'tests'>('general')
  const [contextManagerEnabled, setContextManagerEnabled] = useState(window.api.app.isContextManagerEnabledSync)
  const [lockedByProvider, setLockedByProvider] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    window.api.app.isContextManagerEnabled().then(setContextManagerEnabled)
    window.api.app.isIntegrationsEnabled().then(setIntegrationsEnabled)
  }, [open])

  const checkIntegrationLock = useCallback(async () => {
    if (!project || !integrationsEnabled || window.api.app.isPlaywright) {
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
  }, [project, integrationsEnabled])

  useEffect(() => {
    if (open) void checkIntegrationLock()
  }, [open, checkIntegrationLock])

  useEffect(() => {
    if (open) {
      const resolvedInitialTab = !integrationsEnabled && initialTab === 'integrations'
        ? 'general'
        : initialTab
      setActiveTab(resolvedInitialTab)
    }
  }, [open, project?.id, initialTab, integrationsEnabled])

  useEffect(() => {
    if (!integrationsEnabled) return
    if (!open) return
    if (!integrationOnboardingProvider) return
    setActiveTab('integrations')
  }, [open, integrationOnboardingProvider, integrationsEnabled])


  const navItems: Array<{ key: typeof activeTab; label: string }> = [
    { key: 'general', label: 'General' },
    { key: 'environment', label: 'Environment' },
    { key: 'columns', label: 'Task statuses' },
    { key: 'worktrees', label: 'Worktrees' },
    { key: 'tests', label: 'Tests' },
    ...(integrationsEnabled ? [{ key: 'integrations' as const, label: 'Integrations' }] : []),
  ]
  if (contextManagerEnabled) {
    navItems.push({ key: 'ai-config', label: 'Context Manager' })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="project-settings" className="overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Project Settings</DialogTitle>
        </DialogHeader>
        <SettingsLayout
          items={navItems}
          activeKey={activeTab}
          onSelect={(key) => setActiveTab(key as typeof activeTab)}
        >
          {activeTab === 'general' && project && (
            <GeneralTab
              project={project}
              onUpdated={onUpdated}
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

          {activeTab === 'columns' && project && (
            <ColumnsTab
              project={project}
              onUpdated={onUpdated}
              lockedByProvider={lockedByProvider}
            />
          )}

          {integrationsEnabled && activeTab === 'integrations' && project && (
            <IntegrationsTab
              project={project}
              open={open}
              onUpdated={(p) => { onUpdated(p); void checkIntegrationLock() }}
              integrationOnboardingProvider={integrationOnboardingProvider}
              onIntegrationOnboardingHandled={onIntegrationOnboardingHandled}
            />
          )}

          {activeTab === 'tests' && project && (
            <TestsTab
              projectId={project.id}
              groupBy={groupBy}
              onGroupByChange={onGroupByChange ?? (() => {})}
            />
          )}

          {contextManagerEnabled && activeTab === 'ai-config' && project && (
            <AiConfigTab
              project={project}
              onOpenGlobalAiConfig={onOpenGlobalAiConfig}
            />
          )}
        </SettingsLayout>
      </DialogContent>
    </Dialog>
  )
}
