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
  /** True while the job's content is gone from live rows and files and it waits for
   *  the scheduled database compaction (free pages and WAL). Not complete until then. */
  compactionPending?: boolean
}

/**
 * Nothing the user must act on: complete, or only the scheduled compaction remains
 * (no failure, every recorded computer confirmed). Receipts still say `incomplete`
 * until that compaction ran.
 */
export function isErasureDoneOrCompacting(report: ErasureReport): boolean {
  return (
    report.state === 'complete' ||
    (report.compactionPending === true &&
      report.failures.length === 0 &&
      report.computers.every((computer) => computer.deleted))
  )
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
