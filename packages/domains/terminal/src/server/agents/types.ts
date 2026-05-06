import type { AgentEvent } from '../../shared/agent-events'

export interface AgentSpawnOpts {
  /** Session ID — either a fresh UUID (new session) or existing conversationId for --resume. */
  sessionId: string
  /** True if resuming an existing conversation. Adapter decides flag translation. */
  resume: boolean
  /** Working directory for the agent process. */
  cwd: string
  /** Shell-parsed provider flags (e.g. --allow-dangerously-skip-permissions). */
  providerFlags: string[]
}

export interface SpawnArgs {
  /** Command-line arguments (no binary prefix). Binary resolved separately via whichBinary. */
  args: string[]
}

/**
 * Normalizes one CLI provider's stream into the AgentEvent union.
 * v1: only ClaudeCodeAdapter. Future: Codex, Gemini ACP.
 *
 * Contract:
 * - `parseLine` is stateless per-line (caller handles buffering via readline).
 * - Must never throw. On malformed/unknown input, return UnknownEvent.
 * - `serializeUserMessage` produces ONE NDJSON line (no trailing newline — caller appends).
 * - `serializeToolResult` is optional — adapters that lack a structured-input
 *   channel return null, and the transport falls back to a plain user-message
 *   path. Resolves a pending `tool_use_id` (e.g. AskUserQuestion) instead of
 *   leaving it orphaned in the SDK's turn machinery.
 */
export interface AgentAdapter {
  readonly id: string
  readonly binaryName: string

  buildSpawnArgs(opts: AgentSpawnOpts): SpawnArgs

  parseLine(line: string): AgentEvent | null

  serializeUserMessage(text: string, sessionId: string): string

  /**
   * Produce ONE NDJSON line (no trailing newline) carrying a `tool_result`
   * content block keyed by the original `tool_use_id`. Return null when the
   * adapter's CLI doesn't support a structured-input channel — the transport
   * uses that signal to fall back to `serializeUserMessage`.
   */
  serializeToolResult?(args: {
    toolUseId: string
    content: string
    isError?: boolean
    sessionId: string
  }): string | null

  /**
   * Produce ONE NDJSON `control_request` envelope. Wraps the adapter-specific
   * `request` payload (e.g. `{subtype:'set_permission_mode', mode:'acceptEdits'}`)
   * with the routing fields (`type`, `request_id`) the CLI expects. Transport
   * generates `requestId` and correlates it with the matching `control-response`
   * event. Return null when the adapter lacks a control channel — transport
   * surfaces that to callers so they can fall back to a coarser path
   * (e.g. kill+respawn for mode changes).
   */
  serializeControlRequest?(args: {
    requestId: string
    request: Record<string, unknown>
  }): string | null

  /**
   * Produce ONE NDJSON `control_response` envelope replying to an inbound
   * `control_request` (e.g. `subtype:'can_use_tool'` from `--permission-prompt-tool
   * stdio`). Carries either a success payload (`response`) or an error.
   * Transport writes this on stdin so the CLI unblocks the corresponding
   * permission decision.
   */
  serializeControlResponse?(args: {
    requestId: string
    response?: Record<string, unknown>
    isError?: boolean
    error?: string
  }): string | null

  /**
   * If the event carries session/conversation id info, return it so the transport
   * can persist it via setProviderConversationId.
   */
  extractSessionId(event: AgentEvent): string | null
}
