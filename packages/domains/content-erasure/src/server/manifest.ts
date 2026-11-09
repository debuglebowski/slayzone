import type { ErasureReport, ErasureScope } from '../shared'

export interface ErasureManifest {
  dependencies: string[]
  scope: ErasureScope
  ownerUserId: string | null
  projectIds: string[]
  taskIds: string[]
  artifactIds: string[]
  tabIds: string[]
  conversationIds: string[]
  blobHashes: string[]
  artifactTasks: Array<{ artifactId: string; taskId: string }>
  tabTasks: Array<{ tabId: string; taskId: string }>
  computers: Array<{ id: string; taskIds: string[] }>
  worktrees: Array<{
    taskId: string
    computerId: string | null
    repoPath: string | null
    path: string
    deleted: boolean
  }>
  counts: ErasureReport['counts']
}

export interface ErasureJob {
  id: string
  scope: string
  owner_user_id: string | null
  actor_user_id: string | null
  manifest: string
  db_erased: number
  local_erased: number
  gc_generation: number
  state: ErasureReport['state']
  failure_codes: string
  retained_shared_blobs: number
  retained_backup_blobs: number
  created_at: string
  completed_at: string | null
}
