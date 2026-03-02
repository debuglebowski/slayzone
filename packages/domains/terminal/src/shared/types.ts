export type TerminalMode = 'claude-code' | 'codex' | 'cursor-agent' | 'gemini' | 'opencode' | 'terminal'
export type TerminalState = 'starting' | 'running' | 'attention' | 'error' | 'dead'
export type CodeMode = 'normal' | 'plan' | 'accept-edits' | 'bypass'

// Duplicated from @slayzone/projects/shared — neither domain can depend on the
// other, so both define the same structural type. Keep in sync.
export type ExecutionContext =
  | { type: 'host' }
  | { type: 'docker'; container: string; workdir?: string; shell?: string }
  | { type: 'ssh'; target: string; workdir?: string; shell?: string }

// CLI activity states (more granular than TerminalState)
export type ActivityState = 'attention' | 'working' | 'unknown'

// CLI error info
export interface ErrorInfo {
  code: string
  message: string
  recoverable: boolean
}

// Full CLI state
export interface CLIState {
  alive: boolean
  activity: ActivityState
  error: ErrorInfo | null
}

export interface PtyInfo {
  sessionId: string
  taskId: string
  lastOutputTime: number
  state: TerminalState
}

// Buffer chunk with sequence number for ordering
export interface BufferChunk {
  seq: number
  data: string
}

// Result from getBufferSince
export interface BufferSinceResult {
  chunks: BufferChunk[]
  currentSeq: number
}

export interface PromptInfo {
  type: 'permission' | 'question' | 'input'
  text: string
  position: number
}

export interface ValidationResult {
  check: string
  ok: boolean
  detail: string
  fix?: string
}


// Provider usage / rate limiting
export interface UsageWindow {
  utilization: number // 0-100
  resetsAt: string    // ISO timestamp
}

export interface ProviderUsage {
  provider: string
  label: string
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  sevenDayOpus: UsageWindow | null
  sevenDaySonnet: UsageWindow | null
  error: string | null
  fetchedAt: number
}

/** Command to discover session ID for providers that don't support --session-id at creation. */
export const SESSION_ID_COMMANDS: Partial<Record<TerminalMode, string>> = {
  'codex': '/status',
  'gemini': '/stats',
}

/** Providers where session ID detection is not possible — no --session-id flag and no detection command. */
export const SESSION_ID_UNAVAILABLE: readonly TerminalMode[] = ['cursor-agent', 'opencode']
