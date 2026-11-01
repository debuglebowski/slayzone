/** Observed workspace changes, not a claim about which agent authored them. */
export interface WorkspaceCaptureRequest {
  id: string
  scope: string
  rootPath: string
}

export interface WorkspaceFileDiff {
  path: string
  oldPath?: string
  kind: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number | null
  deletions: number | null
  binary: boolean
  diff: string | null
  hasDiff?: boolean
  omitted?: 'binary' | 'size-limit' | 'capture-failed'
}

export interface WorkspaceCaptureResult {
  status: 'complete' | 'partial' | 'unavailable'
  reason?: string
  files: WorkspaceFileDiff[]
}

export interface WorkspaceCaptureBegin {
  status: 'ready' | 'unavailable'
  reason?: string
}

export interface WorkspaceChangesEvent {
  kind: 'workspace-changes'
  tabId: string
  captureId: string
  /** The user message that opened the observation window. */
  messageId: string
  status: 'pending' | WorkspaceCaptureResult['status']
  fileCount: number
  reason?: string
}

export interface WorkspaceChangesRecord extends WorkspaceCaptureResult {
  id: string
  tabId: string
  messageId: string
  computerId: string | null
  rootPath: string
}
