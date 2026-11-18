export interface ComputerMoveAgent {
  tabId: string
  label: string
  canResume: boolean
  reason?: string
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
