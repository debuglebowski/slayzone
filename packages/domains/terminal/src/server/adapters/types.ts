import type { ExecutionContext } from '@slayzone/terminal/shared'

export type TerminalMode = string
export type { ExecutionContext }

// Activity states for CLI tools.
// `'idle'` is an EXPLICIT done-signal an adapter can emit to flip
// running→idle immediately (e.g. claude completion stamp), bypassing
// the silence-timer fallback in `shouldFlipToIdle`.
export type ActivityState = 'working' | 'idle' | 'unknown'

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
   * Controls how the idle clock + state-on-input behaves. **Default: true**.
   *
   * `true` (default — full-screen TUI):
   *   - On user Enter, pty-manager flips state to 'running'.
   *   - `lastOutputTime` is refreshed ONLY when `detectActivity` returns a
   *     truthy activity. Raw output chunks (cursor blink, status redraws) do
   *     not pin the idle clock open. After `idleTimeoutMs` of no detected
   *     activity, the inactivity checker flips 'running' → 'idle'.
   *
   * `false` (output-driven idle — plain shell, dumb pipes):
   *   - User Enter does NOT flip state.
   *   - `lastOutputTime` is refreshed on EVERY output chunk. Suitable for
   *     adapters whose `detectActivity` doesn't fire reliably (or at all),
   *     e.g. tailing logs in a plain shell.
   *
   * Set `false` only for non-TUI adapters. The wrong-side-of-safe failure mode
   * is the bug we hit historically: leaving this unset on a full-screen TUI
   * → idle clock never closes → state stuck on 'running' indefinitely.
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

  /**
   * Encode a user-submitted prompt into PTY wire bytes.
   *
   * Scope: "submit" = fire the prompt (CLI `slay pty submit`, loop-mode
   * replay, future MCP submit tool). NOT for raw keystrokes, NOT for clipboard
   * paste — paste is staged via xterm bracketed-paste then user fires Enter
   * separately, a different semantic handled by the renderer.
   *
   * Trailing CR/LF MUST be stripped from `text` before encoding (callers may
   * pass stdin with trailing newline). Final byte must trigger Enter on the
   * target TUI — typically `\r` (LF/`\n` is Ctrl+J on raw stdin and treated
   * as newline-in-input by most readline-style libraries).
   *
   * REQUIRED — no default fallback. Each adapter MUST pick a strategy:
   *   - Plain shell: bind `defaultEncodeSubmit` (strip trailing, append \r)
   *   - Ink TUI w/ Kitty protocol: replace internal \n with KITTY_SHIFT_ENTER
   *   - Other multi-line strategies (bracketed paste, etc.): implement here
   */
  encodeSubmit(text: string): string
}

/** Default submit encoding: strip trailing CR/LF, append CR. Internal newlines
 *  pass through unchanged — adapters whose TUI mishandles raw \n should
 *  override (see ClaudeAdapter for Kitty Shift+Enter example). */
export function defaultEncodeSubmit(text: string): string {
  return text.replace(/[\r\n]+$/, '') + '\r'
}
