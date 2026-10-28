import type { ProjectSettingsTabs } from '@slayzone/projects/client/ProjectSettingsTabs'
import { IntegrationsTab } from './IntegrationsTab'
import { useStatusSyncLockLookup } from './useStatusSyncLockLookup'

/**
 * This feature's half of ProjectSettingsDialog's injected tabs (see projects'
 * ProjectSettingsTabs.ts). The app spreads it into what it passes to
 * registerProjectSettingsTabs.
 */
export const integrationsProjectSettingsTabs = {
  IntegrationsTab,
  useStatusSyncLockLookup
} satisfies Pick<ProjectSettingsTabs, 'IntegrationsTab' | 'useStatusSyncLockLookup'>
