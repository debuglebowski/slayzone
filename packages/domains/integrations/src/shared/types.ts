export type IntegrationProvider = 'linear' | 'github'
export type ExternalType = 'issue'
export type SyncState = 'active' | 'error' | 'paused'
export type IntegrationSyncMode = 'one_way' | 'two_way'

export interface IntegrationConnection {
  id: string
  provider: IntegrationProvider
  credential_ref: string
  enabled: boolean
  created_at: string
  updated_at: string
  last_synced_at: string | null
}

export interface IntegrationConnectionPublic {
  id: string
  provider: IntegrationProvider
  enabled: boolean
  created_at: string
  updated_at: string
  last_synced_at: string | null
}

export interface IntegrationConnectionUsageProject {
  project_id: string
  project_name: string
  has_mapping: boolean
  linked_task_count: number
}

export interface IntegrationConnectionUsage {
  connection_id: string
  provider: IntegrationProvider
  mapped_project_count: number
  linked_task_count: number
  projects: IntegrationConnectionUsageProject[]
}

export interface IntegrationProjectMapping {
  id: string
  project_id: string
  provider: IntegrationProvider
  connection_id: string
  external_team_id: string
  external_team_key: string
  external_project_id: string | null
  sync_mode: IntegrationSyncMode
  status_setup_complete: number
  created_at: string
  updated_at: string
}

export interface ExternalLink {
  id: string
  provider: IntegrationProvider
  connection_id: string
  external_type: ExternalType
  external_id: string
  external_key: string
  external_url: string
  task_id: string
  sync_state: SyncState
  last_sync_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface LinearTeam {
  id: string
  key: string
  name: string
}

export interface LinearProject {
  id: string
  name: string
  teamId: string
}

export interface ConnectLinearInput {
  apiKey: string
  projectId?: string
}

export interface ConnectGithubInput {
  token: string
  projectId?: string
}

export interface UpdateIntegrationConnectionInput {
  connectionId: string
  credential: string
}

export interface SetProjectConnectionInput {
  projectId: string
  provider: IntegrationProvider
  connectionId: string
}

export interface ClearProjectConnectionInput {
  projectId: string
  provider: IntegrationProvider
}

export interface SetProjectMappingInput {
  projectId: string
  provider: IntegrationProvider
  connectionId: string
  // Linear: team id. GitHub: project owner login.
  externalTeamId: string
  // Linear: team key. GitHub: owner + project number label.
  externalTeamKey: string
  // Linear: optional project scope id. GitHub: ProjectV2 node id.
  externalProjectId?: string | null
  syncMode?: IntegrationSyncMode
}

export interface ImportLinearIssuesInput {
  projectId: string
  connectionId: string
  teamId?: string
  linearProjectId?: string
  selectedIssueIds?: string[]
  limit?: number
  cursor?: string | null
}

export interface ListLinearIssuesInput {
  connectionId: string
  projectId?: string
  teamId?: string
  linearProjectId?: string
  limit?: number
  cursor?: string | null
}

export interface ImportLinearIssuesResult {
  imported: number
  linked: number
  nextCursor: string | null
}

export interface SyncNowInput {
  connectionId?: string
  projectId?: string
  taskId?: string
}

export interface ClearProjectProviderInput {
  projectId: string
  provider: IntegrationProvider
}

export interface SyncNowResult {
  scanned: number
  pushed: number
  pulled: number
  conflictsResolved: number
  errors: string[]
  at: string
}

export type TaskSyncFieldState = 'in_sync' | 'local_ahead' | 'remote_ahead' | 'conflict'
export type TaskSyncOverallState = 'in_sync' | 'local_ahead' | 'remote_ahead' | 'conflict' | 'unknown'

export interface TaskSyncFieldDiff {
  field: 'title' | 'description' | 'status'
  state: TaskSyncFieldState
}

export interface TaskSyncStatus {
  provider: IntegrationProvider
  taskId: string
  state: TaskSyncOverallState
  fields: TaskSyncFieldDiff[]
  comparedAt: string
}

export interface PushTaskInput {
  taskId: string
  provider: IntegrationProvider
  force?: boolean
}

export interface PushTaskResult {
  pushed: boolean
  status: TaskSyncStatus
  message?: string
}

export interface PullTaskInput {
  taskId: string
  provider: IntegrationProvider
  force?: boolean
}

export interface PullTaskResult {
  pulled: boolean
  status: TaskSyncStatus
  message?: string
}

export interface LinearIssueSummary {
  id: string
  identifier: string
  title: string
  description: string | null
  priority: number
  updatedAt: string
  state: {
    id: string
    name: string
    type: string
  }
  assignee: {
    id: string
    name: string
  } | null
  team: {
    id: string
    key: string
    name: string
  }
  project: {
    id: string
    name: string
  } | null
  url: string
  linkedTaskId?: string | null
}

export interface GithubRepositorySummary {
  id: string
  owner: string
  name: string
  fullName: string
  private: boolean
}

export interface GithubProjectSummary {
  id: string
  number: number
  title: string
  owner: {
    login: string
    type: 'user' | 'organization'
  }
  url: string
  closed: boolean
  updatedAt: string
}

export interface GithubIssueSummary {
  id: string
  number: number
  title: string
  body: string | null
  updatedAt: string
  state: 'open' | 'closed'
  assignee: {
    id: string
    login: string
  } | null
  labels: Array<{
    id: string
    name: string
  }>
  repository: {
    owner: string
    name: string
    fullName: string
  }
  url: string
  linkedTaskId?: string | null
  linkedProjectId?: string | null
  linkedProjectName?: string | null
}

export interface ListGithubIssuesInput {
  connectionId: string
  projectId?: string
  githubProjectId?: string
  limit?: number
  cursor?: string | null
}

export interface ImportGithubIssuesInput {
  projectId: string
  connectionId: string
  githubProjectId?: string
  selectedIssueIds?: string[]
  limit?: number
  cursor?: string | null
}

export interface ImportGithubIssuesResult {
  imported: number
  linked: number
  created: number
  updated: number
  skippedAlreadyLinked: number
  nextCursor: string | null
}

export interface ListGithubRepositoryIssuesInput {
  connectionId: string
  projectId?: string
  repositoryFullName: string
  limit?: number
  cursor?: string | null
}

export interface ImportGithubRepositoryIssuesInput {
  projectId: string
  connectionId: string
  repositoryFullName: string
  selectedIssueIds?: string[]
  limit?: number
  cursor?: string | null
}

export interface ImportGithubRepositoryIssuesResult {
  imported: number
  linked: number
  created: number
  updated: number
  skippedAlreadyLinked: number
  nextCursor: string | null
}

// --- Status Sync ---

export function slugifyStatusName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
}

export interface ProviderStatus {
  id: string
  name: string
  color: string
  type?: string
  position?: number
}

export interface FetchProviderStatusesInput {
  connectionId: string
  provider: IntegrationProvider
  externalTeamId: string
  externalProjectId?: string
}

export interface ApplyStatusSyncInput {
  projectId: string
  provider: IntegrationProvider
  statuses: ProviderStatus[]
  categoryOverrides?: Record<string, string>
  taskRemapping?: Record<string, string>
}

export interface StatusDiff {
  added: ProviderStatus[]
  removed: import('@slayzone/workflow').ColumnConfig[]
  renamed: Array<{ old: import('@slayzone/workflow').ColumnConfig; new: ProviderStatus }>
}

export interface StatusResyncPreview {
  current: import('@slayzone/workflow').ColumnConfig[]
  incoming: import('@slayzone/workflow').ColumnConfig[]
  diff: StatusDiff
  providerStatuses: ProviderStatus[]
}
