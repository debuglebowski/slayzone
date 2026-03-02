import type { CodeMode, ExecutionContext } from '@slayzone/terminal/shared'

export type TerminalMode = 'claude-code' | 'codex' | 'cursor-agent' | 'gemini' | 'opencode' | 'terminal'
export type { CodeMode, ExecutionContext }

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

export interface SpawnConfig {
  shell: string
  args: string[]
  env?: Record<string, string>
  /** Command to run after shell starts (e.g., "claude --session-id X") */
  postSpawnCommand?: string
}

/** Metadata returned alongside SpawnConfig for CCS wrapping */
export interface SpawnBinaryInfo {
  /** Raw binary name (e.g. 'claude', 'codex') */
  name: string
  /** Raw args passed to the binary */
  args: string[]
}

export interface SpawnResult {
  config: SpawnConfig
  /** Present for AI modes; absent for plain terminal */
  binary?: SpawnBinaryInfo
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

  /**
   * If true, pty-manager transitions to 'working' when user presses Enter.
   * Useful for full-screen TUIs that constantly redraw (making output-based
   * detection unreliable). Paired with idleTimeoutMs for return to 'attention'.
   */
  readonly transitionOnInput?: boolean

  /** Command to run in terminal to discover session ID. Undefined = supports --session-id at creation. */
  readonly sessionIdCommand?: string

  /**
   * Build spawn configuration for this terminal mode.
   */
  buildSpawnConfig(cwd: string, conversationId?: string, resuming?: boolean, initialPrompt?: string, providerArgs?: string[], codeMode?: CodeMode): SpawnResult

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
