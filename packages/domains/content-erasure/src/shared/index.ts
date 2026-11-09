/** Erasure results contain identifiers and counts, never deleted text or paths. */
export type ErasureScope =
  | { kind: 'tasks'; ids: string[] }
  | { kind: 'projects'; ids: string[] }
  | { kind: 'artifacts'; ids: string[] }
  | { kind: 'user'; userId: string }

export interface ErasureReport {
  id: string
  state: 'incomplete' | 'complete'
  counts: { projects: number; tasks: number; artifacts: number; versions: number }
  computers: Array<{
    id: string
    name: string
    deleted: boolean
    verifiedBy?: 'computer' | 'operator'
  }>
  failures: string[]
  retainedSharedBlobs: number
  retainedBackupBlobs: number
}

export interface ComputerErasureRequest {
  version: 1
  requestId: string
  jobId: string
  computerId: string
  hubUrl: string
  hubScope: string
  tasks: Array<{ taskId: string; revision: number }>
  worktreeTaskIds: string[]
}
export interface ComputerErasureReceipt {
  request: ComputerErasureRequest
  verifiedAt: string
  managedContentErased: true
  worktreesVerified: boolean
}

export interface ErasureReceipt {
  version: 1
  jobId: string
  scope: ErasureScope
  completedAt: string | null
  report: ErasureReport
}
