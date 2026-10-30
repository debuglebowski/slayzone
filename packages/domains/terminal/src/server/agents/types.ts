import type {
  AgentEvent,
  CommandTaskOutput,
  OutgoingUserMessage,
  PermissionDecision
} from '@slayzone/terminal-contracts'
import type { ChatWriteOptions } from '../runtime/chat-proc-handle'

export interface AgentSpawnOpts {
  /** Session ID — either a fresh UUID (new session) or existing conversationId for --resume. */
  sessionId: string
  /** True if resuming an existing conversation. Adapter decides flag translation. */
  resume: boolean
  /** Working directory for the agent process. */
  cwd: string
  /** Shell-parsed provider flags (e.g. --allow-dangerously-skip-permissions). */
  providerFlags: string[]
  /**
   * The CLI version this spawn will most likely run (the last one this tab or
   * project saw); absent = unknown. Gates options an older CLI would reject.
   */
  cliVersion?: string
  /**
   * Start `sessionId` as a NEW conversation branched off `fromSessionId` at the
   * message `atMessageUuid` (its history up to and including that record). The
   * source conversation is never written. Used for one spawn only.
   */
  fork?: { fromSessionId: string; atMessageUuid: string }
}

/**
 * A content block as it goes to the agent on stdin (Messages API shapes): text,
 * or an attached file read into an image / document block.
 */
export type WireUserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | {
      type: 'document'
      source:
        | { type: 'base64'; media_type: 'application/pdf'; data: string }
        | { type: 'text'; media_type: 'text/plain'; data: string }
      title: string
    }

/** What `prepareUserTurn` built for one message: the line to write. Opaque to the transport. */
export interface PreparedUserTurn {
  readonly id: string
  readonly line: string
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
   * ONE NDJSON line for an outbox message: its content blocks (attachments
   * already read — see `prepareUserTurn`), and its id as the CLI's message
   * `uuid` (Claude reports delivery against it). Absent: the transport falls
   * back to `serializeUserMessage` with the plain text.
   */
  serializeUserTurn?(message: { id: string; content: ReadonlyArray<WireUserContentBlock> }): string

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
 * renderer via `chat:respondPermission` (defined in the event contract, which
 * persists it on `permission-resolved`). The shape mirrors Claude Code's
 * `control_response` for `can_use_tool`; provider drivers translate it to
 * their own approval vocabulary.
 */
export type { PermissionDecision }

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
  /**
   * Write one line and learn whether it arrived: resolves once it reached the
   * process, rejects (`ChatWriteError`) when it did not. The transport always
   * supplies it; optional only so a driver test can hand-roll a context.
   */
  send?(line: string, opts?: ChatWriteOptions): Promise<void>
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
  /**
   * Start as a new conversation branched off `fromSessionId` at `atMessageUuid`
   * (see `AgentSpawnOpts.fork`): for a CLI forking over its protocol (Codex).
   */
  fork?: { fromSessionId: string; atMessageUuid: string }
  /**
   * The tab switched to this conversation (Sessions picker) and has none of its
   * past: the driver reads it from the CLI (Codex `thread/turns/list`) and hands
   * it over with `addHistory`. Claude's history is read from its session file
   * by the host instead.
   */
  importHistory?: boolean
  /**
   * Commit a conversation's past to the tab as history (user messages marked
   * `history: true`), in order, before anything the process says next.
   */
  addHistory?(events: AgentEvent[]): void
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
  /** Dispatch a user message to the provider (plain text). */
  sendUserMessage(text: string): void
  /**
   * Build what an outbox message is written as — reading its attached files.
   * The transport awaits it BEFORE the message counts as sending, so a file
   * that can't be read fails the message without starting a turn. Absent: the
   * driver takes text only.
   */
  prepareUserTurn?(message: OutgoingUserMessage): Promise<PreparedUserTurn>
  /**
   * Dispatch an outbox message (id + content blocks), as `prepared` when given.
   * Resolves once it was written, rejects when it could not be; throws/rejects
   * — never silently drops — before `start`, or for attachments that were not
   * prepared. Absent: the transport uses `sendUserMessage`.
   */
  sendUserTurn?(message: OutgoingUserMessage, prepared?: PreparedUserTurn): Promise<void>
  /**
   * The provider confirms each message itself (Claude: `command_lifecycle` /
   * replay for the message `uuid`), so a written message is only `sending`
   * until it does. Absent/false: a confirmed write counts as delivered.
   */
  readonly confirmsDelivery?: boolean
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
  /**
   * Reply to an inbound permission request. Return false when unsupported, or
   * when the request is not (or no longer) pending. `optionId` names the prompt
   * row the user picked (display only).
   */
  respondPermission?(args: {
    requestId: string
    decision: PermissionDecision
    optionId?: string
  }): boolean
  /** Extract a session/conversation id from an event for resume persistence. */
  extractSessionId(event: AgentEvent): string | null
  /**
   * The output so far of a command the agent runs as a task (`command-task`).
   * Absent: the provider reports no task output.
   */
  commandTaskOutput?(taskId: string): Promise<CommandTaskOutput>
  /** Kill a running command task. Rejects when it is not running. */
  stopCommandTask?(taskId: string): Promise<void>
  /** Move a running foreground command to the background; false when it is not one. */
  backgroundCommandTask?(toolUseId: string): Promise<boolean>
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
  /** The agent's name in chat's own notices ("Claude Code", "Codex"). */
  readonly displayName: string
  /** The command that updates the CLI, for notices (`claude update`). */
  readonly updateCommand: string
  /**
   * The CLI mints the conversation id itself (Codex `thread/start`): the first
   * id a fresh or forked spawn reports becomes the tab's conversation. Without
   * it the host picks the id up front (`--session-id`) and any other id the CLI
   * reports is foreign.
   */
  readonly mintsConversationId?: boolean
  /**
   * Where a fork is made: `assistant-record` (default; Claude's
   * `--resume-session-at <uuid>`) or `message` — through the user message's
   * whole turn (Codex `thread/fork {lastTurnId}`, the turn found by the
   * message id). `AgentSpawnOpts.fork.atMessageUuid` is then the message id.
   */
  readonly forkAt?: 'assistant-record' | 'message'
  /**
   * Oldest CLI version chat is tested with. An older one still runs; the chat
   * shows an "untested version" notice. One constant per provider, easy to lower.
   */
  readonly minTestedCliVersion?: string
  /** Env every spawn of this agent gets (under the per-spawn overlay). */
  readonly spawnEnv?: Readonly<Record<string, string>>
  buildSpawnArgs(opts: AgentSpawnOpts): SpawnArgs
  createDriver(): ChatSessionDriver
  /**
   * The option a starting CLI refused (its stderr), when it is one the backend
   * adds only for a CLI version it believes accepts it; else null. The transport
   * then spawns that tab without version-gated options.
   */
  refusedOptionalFlag?(stderr: string): string | null
}
