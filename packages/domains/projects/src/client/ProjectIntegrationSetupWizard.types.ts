import type { Project } from '@slayzone/projects/shared'
import type {
  IntegrationProjectMapping,
  IntegrationSyncMode
} from '@slayzone/integrations/shared'

export type ProjectIntegrationProvider = 'linear' | 'github' | 'jira'
export type WizardSyncMode = 'one_way_import' | 'one_way_export' | 'two_way' | 'manual'

export interface ProjectIntegrationSetupWizardProps {
  project: Project
  provider: ProjectIntegrationProvider
  initialConnectionId?: string
  connectionLocked?: boolean
  initialTeamId?: string
  initialLinearProjectId?: string
  initialSyncMode?: IntegrationSyncMode
  initialAssignedToMe?: boolean
  onCancel: () => void
  onCompleted: (result: {
    provider: ProjectIntegrationProvider
    mapping: IntegrationProjectMapping
    imported: number
  }) => void
}
