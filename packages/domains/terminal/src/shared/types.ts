export type TerminalMode = string
export type TerminalState = 'starting' | 'running' | 'attention' | 'error' | 'dead'

export const BuiltinTerminalMode = {
  ClaudeCode: 'claude-code',
  Codex: 'codex',
  Gemini: 'gemini',
  CursorAgent: 'cursor-agent',
  OpenCode: 'opencode',
  QwenCode: 'qwen-code',
  Copilot: 'copilot',
} as const

export interface TerminalModeInfo {
  id: string
  label: string
  type: string
  initialCommand?: string | null
  resumeCommand?: string | null
  defaultFlags?: string | null
  enabled: boolean
  isBuiltin: boolean
  order: number
  patternAttention?: string | null
  patternWorking?: string | null
  patternError?: string | null
  usageConfig?: UsageProviderConfig | null
}

export interface CreateTerminalModeInput {
  id: string
  label: string
  type: string
  initialCommand?: string | null
  resumeCommand?: string | null
  defaultFlags?: string | null
  enabled?: boolean
  order?: number
  patternAttention?: string | null
  patternWorking?: string | null
  patternError?: string | null
  usageConfig?: UsageProviderConfig | null
}

export interface UpdateTerminalModeInput {
  label?: string
  type?: string
  initialCommand?: string | null
  resumeCommand?: string | null
  defaultFlags?: string | null
  enabled?: boolean
  order?: number
  patternAttention?: string | null
  patternWorking?: string | null
  patternError?: string | null
  usageConfig?: UsageProviderConfig | null
}

export interface DetectionEngine {
  type: string
  label: string
}

export const DETECTION_ENGINES: DetectionEngine[] = [
  { type: 'terminal', label: 'Custom regex' },
  { type: 'claude-code', label: 'Claude Code' },
  { type: 'codex', label: 'Codex' },
  { type: 'gemini', label: 'Gemini' },
  { type: 'cursor-agent', label: 'Cursor' },
  { type: 'opencode', label: 'OpenCode' },
  { type: 'qwen-code', label: 'Qwen Code' },
  { type: 'copilot', label: 'Copilot' },
]

export const DEFAULT_TERMINAL_MODES: TerminalModeInfo[] = [
  { id: BuiltinTerminalMode.ClaudeCode, label: 'Claude', type: 'claude-code', initialCommand: 'claude --session-id {id} {flags}', resumeCommand: 'claude --resume {id} {flags}', defaultFlags: '--allow-dangerously-skip-permissions', enabled: true, isBuiltin: true, order: 0 },
  { id: BuiltinTerminalMode.Codex, label: 'Codex', type: 'codex', initialCommand: 'codex {flags}', resumeCommand: 'codex {flags} resume {id}', defaultFlags: '--full-auto --search', enabled: true, isBuiltin: true, order: 1 },
  { id: BuiltinTerminalMode.Gemini, label: 'Gemini', type: 'gemini', initialCommand: 'gemini {flags}', resumeCommand: 'gemini --resume latest {flags}', defaultFlags: '--yolo', enabled: true, isBuiltin: true, order: 2 },
  { id: BuiltinTerminalMode.CursorAgent, label: 'Cursor', type: 'cursor-agent', initialCommand: 'cursor-agent {flags}', resumeCommand: 'cursor-agent --resume {id} {flags}', defaultFlags: '--force', enabled: true, isBuiltin: true, order: 3 },
  { id: BuiltinTerminalMode.OpenCode, label: 'OpenCode', type: 'opencode', initialCommand: 'opencode {flags}', resumeCommand: 'opencode --session {id} {flags}', defaultFlags: '', enabled: true, isBuiltin: true, order: 4 },
  { id: BuiltinTerminalMode.QwenCode, label: 'Qwen', type: 'qwen-code', initialCommand: 'qwen --session-id {id} {flags}', resumeCommand: 'qwen --resume {id} {flags}', defaultFlags: '--yolo', enabled: true, isBuiltin: true, order: 6 },
  { id: BuiltinTerminalMode.Copilot, label: 'Copilot', type: 'copilot', initialCommand: 'copilot --resume={id} {flags}', resumeCommand: 'copilot --resume={id} {flags}', defaultFlags: '--allow-all-tools', enabled: true, isBuiltin: true, order: 7 },
  { id: 'terminal', label: 'Terminal', type: 'terminal', initialCommand: null, resumeCommand: null, defaultFlags: null, enabled: true, isBuiltin: true, order: 8 },
]

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
  createdAt: number
  mode: TerminalMode
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
  key: string         // unique within provider, e.g. "fiveHour"
  label: string       // display label, e.g. "5h", "7d", "Opus"
  utilization: number // 0-100
  resetsAt: string    // ISO timestamp
}

export interface ProviderUsage {
  provider: string
  label: string
  windows: UsageWindow[]
  error: string | null
  fetchedAt: number
}

// Custom usage provider configuration (stored as JSON in terminal_modes.usage_config)
export interface UsageWindowMapping {
  key?: string                // dot-path to key field, or omit for auto-index
  label: string               // dot-path or literal prefixed with "="
  labelMap?: Record<string, string>  // rename map, e.g. { "TIME_LIMIT": "30d" }
  utilization: string         // dot-path, e.g. "used_percent"
  resetsAt: string            // dot-path, e.g. "reset_at"
  resetsAtFormat?: 'iso' | 'unix-s' | 'unix-ms'
}

export interface UsageProviderConfig {
  enabled: boolean
  url: string
  method?: 'GET' | 'POST'
  authType: 'none' | 'bearer-env' | 'file-json' | 'keychain'
  authEnvVar?: string
  authFilePath?: string
  authFileTokenPath?: string | string[]  // single path or fallback chain
  authKeychainService?: string           // macOS Keychain service name
  authKeychainTokenPath?: string         // dot-path into parsed JSON value, e.g. "claudeAiOauth.accessToken"
  authHeaderName?: string
  authHeaderTemplate?: string
  extraHeaders?: Record<string, string>
  windowsPath?: string        // dot-path to array in response
  windowMapping: UsageWindowMapping
  singleWindow?: boolean      // map root object directly (no array)
}

/** Command to discover session ID for providers that don't support --session-id at creation. */
export const SESSION_ID_COMMANDS: Partial<Record<TerminalMode, string>> = {
  'codex': '/status',
  'gemini': '/stats',
}

/** Providers where session ID detection is not possible — no --session-id flag and no detection command. */
export const SESSION_ID_UNAVAILABLE: readonly TerminalMode[] = ['ccs', 'cursor-agent', 'opencode']
