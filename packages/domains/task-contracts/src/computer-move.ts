export interface ComputerMoveAgent {
  tabId: string
  label: string
  canResume: boolean
  reason?: string
}
/** The destination computer's copy of the task's project, as the move needs it. */
export interface ComputerMoveDestination {
  /** The project's folder recorded there; null = none chosen yet. */
  folder: string | null
  folderExists: boolean
  /** Where the task's repository must be there (the folder, or its repo inside it). */
  repoPath: string | null
  /** The task works in a git worktree, so the repository must be there. */
  repoRequired: boolean
  repoReady: boolean
  /** The source repository's `origin`, to clone from; null = none known. */
  cloneUrl: string | null
}
export interface ComputerMovePreview {
  sourceComputerId: string
  destinationComputerId: string
  ready: boolean
  blockers: string[]
  agents: ComputerMoveAgent[]
  hasFiles: boolean
  requiresMigration: boolean
  participants?: string[]
  /** Null when the destination could not be asked (offline, unavailable). */
  destination?: ComputerMoveDestination | null
}
export interface ComputerMove {
  id: string
  taskId: string
  projectId: string
  sourceComputerId: string
  destinationComputerId: string
  binding: string | null
  participants: string[]
  allowFreshSessions: boolean
  status: 'running' | 'failed' | 'done' | 'canceled'
  step: 'stop' | 'files' | 'sessions' | 'verify' | 'activate' | 'commit' | 'finish'
  bytesDone: number
  bytesTotal: number
  error: string | null
  freshTabIds: string[]
  sourceState: {
    binding: string | null
    holder: string | null
    repoName: string | null
    hasWorktree: number
    hasBaseDir: number
    projectDefault: string | null
  }
  chats: Array<{ id: string; tabId: string; mode: string; epoch: number }>
}
