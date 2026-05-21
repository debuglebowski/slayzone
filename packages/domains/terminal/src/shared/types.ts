export type TerminalMode = string
export type TerminalState = 'starting' | 'running' | 'idle' | 'error' | 'dead'

/**
 * True when state represents a session whose backing process is still around.
 * `dead` = process exited (kill, natural exit, crash). All other states still
 * have a live PTY/child. Use to derive "is this task active" affordances —
 * `pty.list()` returns rows during the ~100 ms post-exit cleanup window, so
 * consumers must filter by state, not just existence.
 */
export function isAliveTerminalState(state: TerminalState): boolean {
  return state !== 'dead'
}

export const BuiltinTerminalMode = {
  ClaudeCode: 'claude-code',
  ClaudeChat: 'claude-chat',
  Codex: 'codex',
  CodexChat: 'codex-chat',
  Gemini: 'gemini',
  Antigravity: 'antigravity',
  CursorAgent: 'cursor-agent',
  OpenCode: 'opencode',
  QwenCode: 'qwen-code',
  Copilot: 'copilot'
} as const

/**
 * Single source of truth for chat-capable modes. The main-process registry
 * (`terminal/main/agents/registry.ts`) is typed against this list — adding a
 * mode here forces a corresponding adapter entry at compile time.
 */
export const CHAT_SUPPORTED_MODES = ['claude-chat', 'codex-chat'] as const
export type ChatSupportedMode = (typeof CHAT_SUPPORTED_MODES)[number]
export function isChatSupported(mode: string): mode is ChatSupportedMode {
  return (CHAT_SUPPORTED_MODES as readonly string[]).includes(mode)
}

export interface TerminalModeInfo {
  id: string
  label: string
  type: string
  initialCommand?: string | null
  resumeCommand?: string | null
  /**
   * Non-interactive invocation template w/ `{prompt}` + `{flags}` slots.
   * Null = mode has no headless capability (e.g. plain `terminal`).
   * Powers automations' AI action — see @slayzone/automations/shared `buildAiHeadlessCommand`.
   */
  headlessCommand?: string | null
  defaultFlags?: string | null
  enabled: boolean
  isBuiltin: boolean
  order: number
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
  headlessCommand?: string | null
  defaultFlags?: string | null
  enabled?: boolean
  order?: number
  patternWorking?: string | null
  patternError?: string | null
  usageConfig?: UsageProviderConfig | null
}

export interface UpdateTerminalModeInput {
  label?: string
  type?: string
  initialCommand?: string | null
  resumeCommand?: string | null
  headlessCommand?: string | null
  defaultFlags?: string | null
  enabled?: boolean
  order?: number
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
  { type: 'antigravity', label: 'Antigravity' },
  { type: 'cursor-agent', label: 'Cursor' },
  { type: 'opencode', label: 'OpenCode' },
  { type: 'qwen-code', label: 'Qwen Code' },
  { type: 'copilot', label: 'Copilot' }
]

export const DEFAULT_TERMINAL_MODES: TerminalModeInfo[] = [
  {
    id: BuiltinTerminalMode.ClaudeCode,
    label: 'Claude',
    type: 'claude-code',
    initialCommand: 'claude --session-id {id} {flags}',
    resumeCommand: 'claude --resume {id} {flags}',
    headlessCommand: 'claude -p {prompt} {flags}',
    defaultFlags: '--allow-dangerously-skip-permissions',
    enabled: true,
    isBuiltin: true,
    order: 0
  },
  {
    id: BuiltinTerminalMode.ClaudeChat,
    label: 'Claude Chat',
    type: 'claude-code',
    initialCommand: null,
    resumeCommand: null,
    headlessCommand: 'claude -p {prompt} {flags}',
    defaultFlags: '--allow-dangerously-skip-permissions',
    enabled: true,
    isBuiltin: true,
    order: 0.5
  },
  {
    id: BuiltinTerminalMode.Codex,
    label: 'Codex',
    type: 'codex',
    initialCommand: 'codex {flags}',
    resumeCommand: 'codex {flags} resume {id}',
    headlessCommand: 'codex exec {flags} {prompt}',
    defaultFlags: '--sandbox workspace-write',
    enabled: true,
    isBuiltin: true,
    order: 1
  },
  {
    // Codex Chat — structured (non-PTY) chat backed by `codex app-server`'s
    // JSON-RPC protocol. Coexists with the PTY `codex` mode above.
    // `initialCommand`/`resumeCommand` are null: chat is spawned by the
    // chat-transport-manager, not the PTY manager.
    id: BuiltinTerminalMode.CodexChat,
    label: 'Codex Chat',
    type: 'codex',
    initialCommand: null,
    resumeCommand: null,
    headlessCommand: 'codex exec {flags} {prompt}',
    defaultFlags: '',
    enabled: true,
    isBuiltin: true,
    order: 1.5
  },
  {
    id: BuiltinTerminalMode.Gemini,
    label: 'Gemini',
    type: 'gemini',
    initialCommand: 'gemini {flags}',
    resumeCommand: 'gemini --resume latest {flags}',
    headlessCommand: 'gemini -p {prompt} {flags}',
    defaultFlags: '--yolo',
    enabled: true,
    isBuiltin: true,
    order: 2
  },
  {
    // Antigravity CLI — Google's successor to Gemini CLI (Gemini CLI stops
    // serving free/Pro/Ultra requests 2026-06-18). Binary is `agy`. Commands
    // confirmed against `agy --help` (v1.0.0):
    //   resume     `agy --conversation=<id>`              (short `-c` = most-recent)
    //   headless   `-p` / `--print`                      (single non-interactive prompt)
    //   auto-approve `--dangerously-skip-permissions`     (skip tool permission prompts)
    //
    // `resumeCommand` uses `{id}`: the SessionStart hook captures the CLI
    // session_id into provider_config.antigravity (see agent-hook.ts
    // `persistConversationId`), and `{id}` is only ever interpolated when a
    // captured id exists — pty-manager picks `resumeCommand` solely when
    // `resuming = !!existingConversationId`. No id → `initialCommand` (fresh
    // session).
    id: BuiltinTerminalMode.Antigravity,
    label: 'Antigravity',
    type: 'antigravity',
    initialCommand: 'agy {flags}',
    resumeCommand: 'agy --conversation={id} {flags}',
    headlessCommand: 'agy -p {prompt} {flags}',
    defaultFlags: '--dangerously-skip-permissions',
    enabled: true,
    isBuiltin: true,
    order: 2.5
  },
  {
    id: BuiltinTerminalMode.CursorAgent,
    label: 'Cursor',
    type: 'cursor-agent',
    initialCommand: 'cursor-agent {flags}',
    resumeCommand: 'cursor-agent --resume {id} {flags}',
    headlessCommand: 'cursor-agent -p {prompt} {flags}',
    defaultFlags: '--force',
    enabled: true,
    isBuiltin: true,
    order: 3
  },
  {
    id: BuiltinTerminalMode.OpenCode,
    label: 'OpenCode',
    type: 'opencode',
    initialCommand: 'opencode {flags}',
    resumeCommand: 'opencode --session {id} {flags}',
    headlessCommand: 'opencode run {flags} {prompt}',
    defaultFlags: '',
    enabled: true,
    isBuiltin: true,
    order: 4
  },
  {
    id: BuiltinTerminalMode.QwenCode,
    label: 'Qwen',
    type: 'qwen-code',
    initialCommand: 'qwen --session-id {id} {flags}',
    resumeCommand: 'qwen --resume {id} {flags}',
    headlessCommand: 'qwen -p {prompt} {flags}',
    defaultFlags: '--yolo',
    enabled: true,
    isBuiltin: true,
    order: 6
  },
  {
    id: BuiltinTerminalMode.Copilot,
    label: 'Copilot',
    type: 'copilot',
    initialCommand: 'copilot --resume={id} {flags}',
    resumeCommand: 'copilot --resume={id} {flags}',
    headlessCommand: 'copilot -p {prompt} {flags}',
    defaultFlags: '--allow-all-tools',
    enabled: true,
    isBuiltin: true,
    order: 7
  },
  {
    id: 'terminal',
    label: 'Terminal',
    type: 'terminal',
    initialCommand: null,
    resumeCommand: null,
    headlessCommand: null,
    defaultFlags: null,
    enabled: true,
    isBuiltin: true,
    order: 8
  }
]

// Duplicated from @slayzone/projects/shared — neither domain can depend on the
// other, so both define the same structural type. Keep in sync.
export type ExecutionContext =
  | { type: 'host' }
  | { type: 'docker'; container: string; workdir?: string; shell?: string }
  | { type: 'ssh'; target: string; workdir?: string; shell?: string }

// CLI activity states (more granular than TerminalState).
// `'idle'` is an EXPLICIT done-signal an adapter can emit to flip
// running→idle immediately (e.g. claude completion stamp), bypassing
// the silence-timer fallback.
export type ActivityState = 'working' | 'idle' | 'unknown'

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
  tabId: string
  label: string | null
  lastOutputTime: number
  createdAt: number
  mode: TerminalMode
  state: TerminalState
}

/**
 * Discriminated union of any session that broadcasts on `pty:state-change` —
 * PTY (`pty-manager`) or chat-transport (`chat-transport-manager`). Used by
 * the renderer to rehydrate tab state on reload regardless of transport.
 */
export interface SessionInfo {
  /** Broadcast key: `${taskId}` (PTY main), `${taskId}:${tabId}` (PTY pane / chat). */
  sessionId: string
  state: TerminalState
  kind: 'pty' | 'chat'
}

/** Snapshot of one live chat session (transport: streaming JSON to subprocess). */
export interface ChatSessionStateEntry {
  /** Broadcast format `${taskId}:${tabId}`. */
  sessionId: string
  taskId: string
  mode: TerminalMode
  /** Last event flow timestamp (ms). Same semantics as PtyInfo.lastOutputTime. */
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

// Loop mode configuration (stored as JSON in tasks.loop_config)
export type CriteriaType = 'contains' | 'not-contains' | 'regex'

export interface LoopConfig {
  prompt: string
  criteriaType: CriteriaType
  criteriaPattern: string
  maxIterations: number
}

export interface ValidationResult {
  check: string
  ok: boolean
  detail: string
  fix?: string
}

// Provider usage / rate limiting
export interface UsageWindow {
  key: string // unique within provider, e.g. "fiveHour"
  label: string // display label, e.g. "5h", "7d", "Opus"
  utilization: number // 0-100
  resetsAt: string // ISO timestamp
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
  key?: string // dot-path to key field, or omit for auto-index
  label: string // dot-path or literal prefixed with "="
  labelMap?: Record<string, string> // rename map, e.g. { "TIME_LIMIT": "30d" }
  utilization: string // dot-path, e.g. "used_percent"
  resetsAt: string // dot-path, e.g. "reset_at"
  resetsAtFormat?: 'iso' | 'unix-s' | 'unix-ms'
}

export interface UsageProviderConfig {
  enabled: boolean
  url: string
  method?: 'GET' | 'POST'
  authType: 'none' | 'bearer-env' | 'file-json' | 'keychain'
  authEnvVar?: string
  authFilePath?: string
  authFileTokenPath?: string | string[] // single path or fallback chain
  authKeychainService?: string // macOS Keychain service name
  authKeychainTokenPath?: string // dot-path into parsed JSON value, e.g. "claudeAiOauth.accessToken"
  authHeaderName?: string
  authHeaderTemplate?: string
  extraHeaders?: Record<string, string>
  windowsPath?: string // dot-path to array in response
  windowMapping: UsageWindowMapping
  singleWindow?: boolean // map root object directly (no array)
}

/** Command to discover session ID for providers that don't support --session-id at creation. */
export const SESSION_ID_COMMANDS: Partial<Record<TerminalMode, string>> = {
  codex: '/status',
  gemini: '/stats'
}

/** Providers where session ID detection is not possible — no --session-id flag and no detection command. */
export const SESSION_ID_UNAVAILABLE: readonly TerminalMode[] = ['ccs', 'cursor-agent', 'opencode']

export type SkillSource = 'user' | 'project' | 'agents'

export interface SkillInfo {
  name: string
  description: string
  source: SkillSource
  path: string
}

export type CommandSource = 'user' | 'project'

export interface CommandInfo {
  name: string
  description: string
  source: CommandSource
  path: string
  /** Raw markdown body (frontmatter stripped) — injected as user msg on accept. */
  body: string
}

export type AgentSource = 'user' | 'project'

export interface AgentInfo {
  name: string
  description: string
  source: AgentSource
  path: string
}

export interface FileMatch {
  /** Project-relative path. Directories end with `/`. */
  path: string
  isDirectory: boolean
}

/**
 * Backend-persisted "Up next" chat queue row. Source-of-truth for messages
 * the user has lined up while a turn is in flight. Survives reload + sync'd
 * across windows. Drained main-side on state→idle.
 *
 * `send` is the wire-ready text (post `transformSubmit`); `original` is the
 * raw composer input retained so usage bumps see the user's `/cmd` token.
 */
export interface QueuedChatMessage {
  id: string
  tabId: string
  send: string
  original: string
  position: number
  createdAt: string
}
