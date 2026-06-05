import type { Project } from '@slayzone/projects/shared'
import type {
  ExternalLink,
  IntegrationProvider,
  TaskSyncStatus
} from '@slayzone/integrations/shared'

export type TaskSyncRow = {
  taskId: string
  link: ExternalLink | null
  status: TaskSyncStatus | null
  error?: string
}

export type ProjectSyncSummary = {
  total: number
  in_sync: number
  local_ahead: number
  remote_ahead: number
  conflict: number
  unknown: number
  unlinked: number
  errors: number
  checkedAt: string
}

export type IntegrationSetupEntry = 'github_projects' | 'linear' | 'github_issues' | 'jira'
export type ImportIssueSort = 'updated_desc' | 'updated_asc' | 'title_asc' | 'title_desc'

export interface IntegrationsTabProps {
  project: Project
  open: boolean
  onUpdated: (project: Project) => void
  integrationOnboardingProvider?: IntegrationProvider | null
  onIntegrationOnboardingHandled?: () => void
}
