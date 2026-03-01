import type { ColumnConfig } from '@slayzone/workflow'

export {
  WORKFLOW_CATEGORIES,
  DEFAULT_COLUMNS,
  type WorkflowCategory,
  type ColumnConfig
} from '@slayzone/workflow'
export type ProjectTaskBackend = 'db'

export interface Project {
  id: string
  name: string
  color: string
  path: string | null
  task_backend: ProjectTaskBackend
  feature_repo_integration_enabled: number
  feature_repo_features_path: string
  auto_create_worktree_on_task_create: number | null
  worktree_source_branch: string | null
  columns_config: ColumnConfig[] | null
  created_at: string
  updated_at: string
}

export interface CreateProjectInput {
  name: string
  color: string
  path?: string
  columnsConfig?: ColumnConfig[]
  taskBackend?: ProjectTaskBackend
  featureRepoIntegrationEnabled?: boolean
  featureRepoFeaturesPath?: string
}

export interface UpdateProjectInput {
  id: string
  name?: string
  color?: string
  path?: string | null
  taskBackend?: ProjectTaskBackend
  featureRepoIntegrationEnabled?: boolean
  featureRepoFeaturesPath?: string
  autoCreateWorktreeOnTaskCreate?: boolean | null
  worktreeSourceBranch?: string | null
  columnsConfig?: ColumnConfig[] | null
}

export interface ProjectFeatureSyncResult {
  scanned: number
  created: number
  updated: number
  skipped: number
  errors: string[]
}

export interface ProjectFeatureSyncAggregateResult {
  projects: number
  scanned: number
  created: number
  updated: number
  skipped: number
  errors: string[]
}

export interface RepoFeatureSyncConfig {
  defaultFeaturesPath: string
  pollIntervalSeconds: number
}

export type FeatureSyncSource = 'repo' | 'task'

export interface FeatureAcceptanceItem {
  id: string
  scenario: string
  file: string | null
  resolvedFilePath: string | null
}

export interface FeatureAcceptanceInput {
  id: string
  scenario: string
  file?: string | null
}

export interface UpdateTaskFeatureInput {
  featureId?: string | null
  title: string
  description?: string | null
  acceptance: FeatureAcceptanceInput[]
}

export interface TaskFeatureDetails {
  projectId: string
  taskId: string
  featureId: string | null
  title: string
  description: string | null
  featureFilePath: string
  featureDirPath: string
  featureDirAbsolutePath: string | null
  acceptance: FeatureAcceptanceItem[]
  lastSyncAt: string
  lastSyncSource: FeatureSyncSource
}
