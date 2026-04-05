import type { ExecutionContext } from '@slayzone/terminal/shared'

export type TerminalMode = string
export type { ExecutionContext }

// Activity states for CLI tools
export type ActivityState = 'attention' | 'working' | 'unknown'

// Error info from CLI
export interface ErrorInfo {
  code: string
  message: string
  recoverable: boolean
}

// Full CLI state (alive tracked by pty-manager via process exit)
export interface CLIState {
  alive: boolean
  activity: ActivityState
  error: ErrorInfo | null
}

/** Shell config returned by adapters */
export interface SpawnShellConfig {
  shell: string
  args: string[]
  env?: Record<string, string>
}

/** Binary metadata for command construction (pty-manager builds the final command) */
export interface SpawnBinaryInfo {
  /** Binary name (e.g. 'claude', 'codex') */
  name: string
  /** Structural args (resume, session-id) — used for direct CLI, skipped for CCS */
  args: string[]
  /** Provider-specific flags (--full-auto, --yolo, etc.) — used for direct CLI, skipped for CCS */
  providerArgs: string[]
  /** Initial prompt text — passed through to both direct CLI and CCS */
  initialPrompt?: string
}

export interface SpawnResult {
  config: SpawnShellConfig
  /** Present for AI modes; absent for plain terminal */
  binary?: SpawnBinaryInfo
}

/** Internal pty-manager type — adds postSpawnCommand constructed from binary info */
export interface SpawnConfig extends SpawnShellConfig {
  postSpawnCommand?: string
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

export interface TerminalAdapter {
  readonly mode: TerminalMode

  /** Idle timeout in ms (null = use default 60s) */
  readonly idleTimeoutMs: number | null

  /** Startup timeout in ms before PTY is killed (null/undefined = use default 10s) */
  readonly startupTimeoutMs?: number | null

  /**
   * If true, pty-manager transitions to 'working' when user presses Enter.
   * Useful for full-screen TUIs that constantly redraw (making output-based
   * detection unreliable). Paired with idleTimeoutMs for return to 'attention'.
   */
  readonly transitionOnInput?: boolean

  /** Command to run in terminal to discover session ID. Undefined = supports --session-id at creation. */
  readonly sessionIdCommand?: string

  /**
   * Detect activity state from terminal output.
   * Returns null if no change detected.
   */
  detectActivity(data: string, current: ActivityState): ActivityState | null

  /**
   * Detect errors from terminal output.
   * Returns null if no error detected.
   */
  detectError(data: string): ErrorInfo | null

  /**
   * Detect if output indicates a prompt that needs user input.
   * Returns null if no prompt detected.
   */
  detectPrompt(data: string): PromptInfo | null

  /**
   * Detect the session/conversation ID from terminal output.
   * Useful for discovery commands like /status.
   */
  detectConversationId?(data: string): string | null

  /**
   * Detect the session/conversation ID from the CLI's local files on disk.
   * Called after first output so the ID can be persisted without injecting
   * commands into the terminal. Returns null if not found.
   * @param spawnedAt - timestamp (ms) when the PTY was created
   * @param cwd - working directory the CLI was launched in (for disambiguation)
   */
  detectSessionFromDisk?(spawnedAt: number, cwd: string): Promise<string | null>

  /**
   * Validate that the CLI binary and dependencies are available.
   * Returns a list of check results with fix instructions for failed checks.
   */
  validate?(): Promise<ValidationResult[]>
}
