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

/**
 * Decision payload for an inbound permission request, surfaced from the
 * renderer via `chat:respondPermission`. The shape mirrors Claude Code's
 * `control_response` for `can_use_tool`; provider drivers translate it to
 * their own approval vocabulary.
 */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean }

/**
 * IO seam handed to a `ChatSessionDriver` once its OS subprocess is alive.
 * The driver writes protocol bytes via `write` and pushes normalized
 * `AgentEvent`s into the transport pipeline via `emit`. The transport owns
 * buffering / persistence / broadcast / the state machine — the driver never
 * touches those directly.
 */
export interface ChatDriverContext {
  /** Write one protocol line to child stdin. The transport appends the newline. */
  write(line: string): void
  /** Route one normalized event through the transport (buffer + persist + broadcast + state). */
  emit(event: AgentEvent): void
  /** Working directory the subprocess was spawned in. */
  cwd: string
  /** Resume id when `resume` is true, otherwise a fresh uuid. */
  sessionId: string
  /** True when this spawn should resume an existing conversation/thread. */
  resume: boolean
  /** Shell-parsed provider flags. */
  providerFlags: string[]
  /** Resolved chat model alias for this spawn (`null` = provider default). */
  chatModel: string | null
  /** Resolved reasoning effort for this spawn (`null` = inherit). */
  chatEffort: string | null
  /** Resolved runtime/permission mode for this spawn (`null` = provider default). */
  chatMode: string | null
  /** Resolved collaboration mode for this spawn (`null` = provider default). */
  chatCollaboration: string | null
  /** Whether Codex Fast Mode (`serviceTier: 'fast'`) is enabled for this spawn. */
  chatFastMode: boolean
}

/**
 * Stateful, per-spawn protocol driver. One instance is created by the
 * transport for each OS subprocess (`AgentBackend.createDriver`) and torn
 * down on process exit. Unlike the stateless `AgentAdapter`, a driver may
 * own a handshake, request/response correlation state, and pending promises
 * — which is what a bidirectional JSON-RPC provider (Codex) requires and a
 * one-directional stream provider (Claude) simply ignores.
 */
export interface ChatSessionDriver {
  /**
   * Called exactly once after the OS process emits `'spawn'`, before any
   * `handleLine`/`sendUserMessage` call. Receives the IO context. A JSON-RPC
   * provider runs its `initialize`/handshake here; a stream provider just
   * stores the context. May be async — the transport does not block on it.
   */
  start(ctx: ChatDriverContext): void | Promise<void>
  /** Handle one stdout line. Emits zero or more events via `ctx.emit`. Must never throw. */
  handleLine(line: string): void
  /** Dispatch a user message to the provider. */
  sendUserMessage(text: string): void
  /**
   * Resolve a pending tool call with a structured result. Return false when
   * the provider has no structured-input channel — the transport falls back
   * to `sendUserMessage`.
   */
  sendToolResult?(args: { toolUseId: string; content: string; isError?: boolean }): boolean
  /**
   * Apply a control operation (permission-mode / model / interrupt). The
   * `request` payload is provider-specific. Resolves when the provider
   * acknowledges, rejects on timeout / unsupported / session exit.
   */
  applyControl?(request: Record<string, unknown>, timeoutMs: number): Promise<unknown>
  /** Reply to an inbound permission request. Return false when unsupported. */
  respondPermission?(args: { requestId: string; decision: PermissionDecision }): boolean
  /** Extract a session/conversation id from an event for resume persistence. */
  extractSessionId(event: AgentEvent): string | null
  /** Teardown — reject pending promises, clear timers. Called on process exit. */
  dispose(): void
}

/**
 * Per-mode protocol backend. Supplies the spawn command and mints a fresh
 * stateful `ChatSessionDriver` for every OS subprocess. Replaces the old
 * singleton `AgentAdapter` as the registry value type.
 */
export interface AgentBackend {
  readonly binaryName: string
  buildSpawnArgs(opts: AgentSpawnOpts): SpawnArgs
  createDriver(): ChatSessionDriver
}
