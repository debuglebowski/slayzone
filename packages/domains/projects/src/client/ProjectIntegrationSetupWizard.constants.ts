import type { ProjectIntegrationProvider, WizardSyncMode } from './ProjectIntegrationSetupWizard.types'

export const STEPS = [
  'Connect account',
  'Choose source',
  'Choose mode',
  'Set up statuses',
  'Review mapping',
  'Preview and confirm'
]

export const SYNC_MODE_OPTIONS: Array<{
  value: WizardSyncMode
  label: string
  description: string
  enabled: (provider: ProjectIntegrationProvider) => boolean
}> = [
  {
    value: 'one_way_import',
    label: 'One-way import',
    description: 'External updates flow into SlayZone for this project.',
    enabled: () => true
  },
  {
    value: 'one_way_export',
    label: 'One-way export',
    description: 'SlayZone updates pushed out to external system.',
    enabled: () => false
  },
  {
    value: 'two_way',
    label: 'Two-way sync',
    description: 'Changes can flow in both directions.',
    enabled: (provider) => provider === 'linear' || provider === 'jira'
  },
  {
    value: 'manual',
    label: 'Manual sync only',
    description: 'Sync only when you run it manually.',
    enabled: () => false
  }
]
