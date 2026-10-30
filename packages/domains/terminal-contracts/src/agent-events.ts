/**
 * Normalized event shape produced by AgentAdapter.parseLine().
 * UI and transport manager speak this union, never raw provider JSON.
 *
 * Discovered during Spike B (2026-04-18, Claude Code 2.1.114).
 * See packages/domains/terminal/test/fixtures/claude-stream/SPIKE.md.
 */

export type AgentEvent =
  | TurnInitEvent
  | UserMessageEvent
  | AssistantTextEvent
  | AssistantThinkingEvent
  | ToolCallEvent
  | ToolResultEvent
  | ResultEvent
  | RateLimitEvent
  | ApiRetryEvent
  | CompactBoundaryEvent
  | CompactStatusEvent
  | CommandOutputEvent
  | HookOutputEvent
  | NoticeEvent
  | SubAgentEvent
  | StderrEvent
  | ProcessExitEvent
  | InterruptedEvent
  | UserMessagePoppedEvent
  | ErrorEvent
  | UnknownEvent
  | StreamMessageStartEvent
  | StreamBlockStartEvent
  | StreamBlockDeltaEvent
  | StreamBlockStopEvent
  | StreamMessageStopEvent
  | ControlResponseEvent
  | PermissionRequestEvent
  | PermissionCancelledEvent
  | PermissionResolvedEvent
  | PermissionModeChangedEvent
  | HostControlRequestEvent
  | SessionSpawnEvent
  | AgentPlanEvent
  | UserMessageDeliveryEvent
  | HeartbeatEvent
  | CommandLifecycleEvent
  | UserReplayEvent
  | CliTaskEvent
  | CommandTaskEvent
  | CommandTaskOutputEvent

/**
 * Agent task plan, emitted by Codex `turn/plan/updated`. Codex pushes this
 * repeatedly as the plan evolves within a turn; the reducer collapses
 * consecutive updates in the same turn into one timeline card. Claude's
 * nearest analog is the `TodoWrite` tool — kept as a first-class event so
 * Codex plans render without depending on tool-call shape.
 */
export interface AgentPlanEvent {
  kind: 'agent-plan'
  /** Optional one-line rationale from the agent. */
  explanation?: string
  steps: AgentPlanStep[]
}

export interface AgentPlanStep {
  step: string
  status: 'pending' | 'inProgress' | 'completed'
}

/**
 * Streaming events from Claude Code's `--verbose` stream-json output.
 * Wrap Anthropic API SSE events (message_start, content_block_*, message_stop).
 * Adapter is stateless — reducer tracks `currentStreamMessageId` and resolves blocks via `blockIndex`.
 */
export interface StreamMessageStartEvent {
  kind: 'stream-message-start'
  messageId: string
  /** Set when this message belongs to a sub-agent spawned by a Task tool call. */
  parentToolUseId?: string
}

export type StreamBlockType = 'text' | 'thinking' | 'tool_use'

export interface StreamBlockStartEvent {
  kind: 'stream-block-start'
  blockIndex: number
  blockType: StreamBlockType
  /** Only for tool_use blocks. */
  toolUseId?: string
  toolName?: string
  parentToolUseId?: string
}

export type StreamDeltaType = 'text' | 'thinking' | 'signature' | 'input_json'

export interface StreamBlockDeltaEvent {
  kind: 'stream-block-delta'
  blockIndex: number
  deltaType: StreamDeltaType
  /** For text/thinking: the chunk. For signature: signature string. For input_json: partial JSON. */
  text: string
  parentToolUseId?: string
}

export interface StreamBlockStopEvent {
  kind: 'stream-block-stop'
  blockIndex: number
  parentToolUseId?: string
}

export interface StreamMessageStopEvent {
  kind: 'stream-message-stop'
  parentToolUseId?: string
}

/**
 * One block of a user message. Text today; images and documents (plan item 3.5)
 * join this union without changing how a message travels.
 */
export type UserContentBlock = { type: 'text'; text: string }

/** A user message as the outbox carries it: a client-minted id + its content. */
export interface OutgoingUserMessage {
  /** Minted by the client; sent to the CLI as the stdin message `uuid`. */
  id: string
  content: UserContentBlock[]
}

/** The message's plain text — what replay, search, copy and pop compare. */
export function userMessageText(content: UserContentBlock[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
}

/** Synthetic event emitted by the main process when the user sends a message. Buffered so it survives replay. */
export interface UserMessageEvent {
  kind: 'user-message'
  /** Plain text of the message (rows written before `content` existed carry only this). */
  text: string
  /** The outbox id (= CLI `uuid`); absent on rows from before the outbox. */
  id?: string
  content?: UserContentBlock[]
}

/**
 * Where a user message is on its way to the agent:
 *   - `sending` — written to the agent, not yet confirmed (live only, never saved);
 *   - `delivered` — the agent confirmed it has the message;
 *   - `answered` — the agent finished the turn for it;
 *   - `failed` — it did not reach the agent (`error` says why); can be retried;
 *   - `cancelled` — withdrawn before it was answered (Stop on an unanswered turn).
 * A message with no delivery event yet is queued (accepted, waiting for the agent).
 */
export type UserMessageDeliveryState = 'sending' | 'delivered' | 'answered' | 'failed' | 'cancelled'

export interface UserMessageDeliveryEvent {
  kind: 'user-message-delivery'
  id: string
  state: UserMessageDeliveryState
  error?: string
}

/**
 * Why the chat TRANSPORT itself shows a notice (a `NoticeEvent` with a `code`;
 * the CLI's own notices have none).
 */
export type NoticeCode =
  /** The stored conversation could not be resumed; a fresh one was started. */
  | 'resume-failed-fresh-start'
  /** The agent stopped responding and was stopped by the watchdog. */
  | 'watchdog-killed'
  /** The agent's CLI version has not been tested with chat. */
  | 'cli-version-untested'
  /** The agent's CLI refused an optional option; it is left out from now on. */
  | 'cli-option-refused'

/**
 * TRANSPORT-INTERNAL (never saved or broadcast): the agent is alive and working
 * without visible output (thinking-token counts, an API request starting).
 * Counts as progress for the watchdog.
 */
export interface HeartbeatEvent {
  kind: 'heartbeat'
  source: string
}

/**
 * TRANSPORT-INTERNAL: the CLI's own delivery state for a user message that
 * carried a `uuid` (Claude `command_lifecycle`). Feeds the outbox.
 */
export interface CommandLifecycleEvent {
  kind: 'command-lifecycle'
  commandUuid: string
  state: 'queued' | 'started' | 'completed' | 'cancelled'
}

/**
 * TRANSPORT-INTERNAL: the CLI echoed a user message back (`--replay-user-messages`)
 * — proof it received the message with that `uuid`.
 */
export interface UserReplayEvent {
  kind: 'user-replay'
  uuid: string
}

export interface TurnInitEvent {
  kind: 'turn-init'
  sessionId: string
  model: string
  cwd: string
  tools: string[]
  permissionMode?: string
  /**
   * Slash commands the CLI runs from raw `/name args` user text (built-ins,
   * skills, custom + plugin commands). Undefined when the provider doesn't
   * advertise a list (Codex, older Claude CLIs).
   */
  slashCommands?: string[]
  /** Subset of `slashCommands` whose UX is bound to a terminal — hide from chat menus. */
  terminalSlashCommands?: string[]
  /** Subset of `slashCommands` that are skills. */
  skills?: string[]
  /** CLI version that emitted this init (e.g. `2.1.312`). */
  cliVersion?: string
}

export interface AssistantTextEvent {
  kind: 'assistant-text'
  messageId: string
  text: string
  /** Set when this text was emitted by a sub-agent spawned by a Task tool call. */
  parentToolUseId?: string
  /** Token usage of the API call that produced this message (see `TokenUsage`). */
  usage?: TokenUsage
}

export interface AssistantThinkingEvent {
  kind: 'assistant-thinking'
  messageId: string
  text: string
  hasSignature: boolean
  parentToolUseId?: string
  usage?: TokenUsage
}

export interface ToolCallEvent {
  kind: 'tool-call'
  id: string
  name: string
  input: unknown
  parentToolUseId?: string
  usage?: TokenUsage
}

export interface ToolResultEvent {
  kind: 'tool-result'
  toolUseId: string
  isError: boolean
  rawContent: unknown
  structured: unknown
  parentToolUseId?: string
}

export interface ResultEvent {
  kind: 'result'
  subtype: string
  isError: boolean
  durationMs: number
  durationApiMs: number
  numTurns: number
  /**
   * Claude: cost of the whole CLI session so far (cumulative across turns, and
   * restored on `--resume`), NOT this turn's cost. Codex reports no cost (0).
   */
  totalCostUsd: number
  stopReason: string | null
  terminalReason: string | null
  text: string | null
  /** Per-model accounting for the whole session (cumulative). Empty when the provider reports none. */
  modelUsage: Record<string, ModelUsage>
  /** This turn's main-loop usage summed over its API calls — not the context size. */
  usage: TokenUsage
  permissionDenials: unknown[]
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUsd: number
  /** Context window of this model in tokens, when the provider reports it. */
  contextWindow?: number
  maxOutputTokens?: number
}

/**
 * Token counts of one API call (assistant events) or a sum of calls (`result.usage`).
 * For one call, input + cache read + cache creation = the prompt size, i.e. how
 * much of the context window the conversation occupied at that call.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

export interface RateLimitEvent {
  kind: 'rate-limit'
  status: string
  rateLimitType: string
  resetsAt: number | null
  overageStatus: string | null
}

export interface ApiRetryEvent {
  kind: 'api-retry'
  attempt: number
  maxRetries: number
  delayMs: number
  error: string
}

/** The CLI finished compacting the conversation (manual `/compact` or automatic). */
export interface CompactBoundaryEvent {
  kind: 'compact-boundary'
  trigger?: 'manual' | 'auto'
  /** Context tokens just before compaction. */
  preTokens?: number
  /**
   * CLI-reported tokens kept after compaction. Excludes the system prompt and
   * tools, so it is NOT the context size the next call will use.
   */
  postTokens?: number
  durationMs?: number
}

/**
 * Compaction progress from the CLI's `system/status` frames: `started` when it
 * begins summarizing, then `succeeded` or `failed` (with the CLI's reason).
 */
export interface CompactStatusEvent {
  kind: 'compact-status'
  phase: 'started' | 'succeeded' | 'failed'
  error?: string
}

/**
 * Output of a slash command the CLI ran locally (`/context`, `/usage`, a failed
 * `/compact`, …) — no model call. Rendered as a command-output block, not as
 * an assistant reply.
 */
export interface CommandOutputEvent {
  kind: 'command-output'
  /** Stable id of the CLI message (its uuid). */
  id: string
  /** Command name without the slash, when the CLI reports it. */
  command: string | null
  text: string
  /** The command failed (e.g. a custom command's refused `!shell` line); `text` is the reason. */
  isError?: boolean
}

/**
 * What a hook's run did, for hooks that matter in chat: it blocked an action,
 * failed, timed out / was cancelled, stopped the agent, or added context for
 * the model. Hooks that did none of these are never emitted.
 */
export type HookEffect = 'blocked' | 'failed' | 'cancelled' | 'stopped' | 'context'

/**
 * A hook (from the user's settings, plugins or SlayZone) whose run changed what
 * happened or told the model something. Claude Code `system/hook_response`.
 */
export interface HookOutputEvent {
  kind: 'hook-output'
  hookId: string
  /** e.g. `PreToolUse:Bash`, `SessionStart:startup`, `Stop`. */
  hookName: string
  /** e.g. `PreToolUse`. */
  hookEvent: string
  effect: HookEffect
  /** Who `text` reached: the model, or only the user. */
  audience: 'agent' | 'user'
  /** The hook's message: block / failure reason, stop reason, or the added context. */
  text: string
  exitCode?: number
}

/**
 * A notice for the user: one the CLI shows (e.g. a hook's `systemMessage`,
 * Claude Code `system/informational`), or one the chat transport adds about
 * what it did (`code` set: a failed resume, a watchdog stop, an untested CLI).
 */
export interface NoticeEvent {
  kind: 'notice'
  id: string
  /** CLI level, e.g. `notice`, `warning`. */
  level: string
  text: string
  /** Set on the transport's own notices. */
  code?: NoticeCode
  detail?: Record<string, unknown>
}

export interface SubAgentEvent {
  kind: 'sub-agent'
  /**
   * Semantic state, decoupled from CLI subtype names. Adapter maps every
   * `task_*` system event → `'in-flight'`; the reducer flips to `'completed'`
   * or `'failed'` only when the outer `Task` tool's `tool-result` arrives
   * (the contract-guaranteed completion signal). Interrupt / process-exit
   * heal paths also flip to `'failed'`.
   */
  phase: 'in-flight' | 'completed' | 'failed'
  /** SDK tool_use_id of the parent Task call. Pairs `started` with subsequent enrichment events + the outer tool-result. */
  toolUseId: string
  /** Set when this sub-agent was spawned by another sub-agent (nested Task). */
  parentToolUseId?: string
  /** Human-readable label from `task_started` (e.g. "Find chat history parsing logic"). */
  description?: string
  /** From `task_notification` — e.g. 'completed', 'failed'. */
  status?: string
  /** From `task_notification` — short result summary. */
  summary?: string
  /** From `task_notification.usage`. Aggregated work the sub-agent did. */
  usage?: {
    totalTokens: number
    toolUses: number
    durationMs: number
  }
  raw: unknown
}

export interface StderrEvent {
  kind: 'stderr'
  text: string
}

export interface ProcessExitEvent {
  kind: 'process-exit'
  code: number | null
  signal: string | null
}

/**
 * Synthetic event emitted when the user interrupts an in-flight turn (Stop
 * button without pop, `chat:interrupt` IPC). Persisted alongside other events
 * so timeline replay sees the turn boundary even though the original turn
 * never produced a `result`.
 */
export interface InterruptedEvent {
  kind: 'interrupted'
}

/**
 * Synthetic event emitted when the user aborts an in-flight turn BEFORE any
 * assistant progress arrived. Cancels the trailing `user-message` so the chat
 * input field can re-receive the message for editing — Claude CLI parity.
 * Persisted into the event log so replay sees the same cancellation.
 */
export interface UserMessagePoppedEvent {
  kind: 'user-message-popped'
  /** Text of the cancelled user-message (for replay matching). */
  text: string
}

export interface ErrorEvent {
  kind: 'error'
  message: string
  detail?: unknown
}

export interface UnknownEvent {
  kind: 'unknown'
  reason: 'parse-error' | 'unknown-type' | 'shape-mismatch'
  raw: unknown
}

/**
 * Reply to a control_request the SDK sent on stdin (e.g. set_permission_mode,
 * interrupt, set_model). Transport intercepts these by `requestId` to resolve
 * the pending sender promise — they are NOT broadcast or buffered as chat
 * timeline events.
 */
export interface ControlResponseEvent {
  kind: 'control-response'
  requestId: string
  isError: boolean
  data?: unknown
  error?: string
}

/**
 * Inbound control_request from the CLI asking the host (us) to make a
 * decision (`subtype: 'can_use_tool'`). Surfaces when running with
 * `--permission-prompt-tool stdio`. Renderer responds via
 * `chat:respondPermission(tabId, requestId, decision)`. Carries the
 * originating tool's `tool_use_id` so the renderer can correlate the
 * incoming prompt with the on-screen tool card (e.g. AskUserQuestion).
 */
export interface PermissionRequestEvent {
  kind: 'permission-request'
  requestId: string
  toolName: string
  toolUseId: string
  input: unknown
  permissionSuggestions?: unknown
  // Display fields of Claude's `can_use_tool` (absent when the CLI omits them).
  /** Tool name for humans (`Echo` for `mcp__spike__echo`). */
  displayName?: string
  title?: string
  /** What the call does (Bash: the command's description; Edit/Write: the file name). */
  description?: string
  /** Why the CLI asks (`This command requires approval`). */
  decisionReason?: string
  decisionReasonType?: string
  /** Path outside the allowed directories that triggered the prompt. */
  blockedPath?: string
  /** Set when a subagent raised the prompt. */
  agentId?: string
  mcpServer?: { name: string; source?: string }
  /** Omit the "don't ask again" row. */
  suppressAlwaysAllow?: boolean
  /** Don't pre-select an approving row. */
  defaultToNo?: boolean
  /** The tool exists to ask the user (AskUserQuestion, ExitPlanMode). */
  requiresUserInteraction?: boolean
  serverPolicyAskOnly?: boolean
}

/**
 * The host's answer to a permission request. Claude: the `can_use_tool`
 * control_response body. `deny` + `interrupt` stops the turn (the TUI's plain
 * "No"); `deny` alone hands `message` to the model and the turn continues.
 */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean }

/**
 * The CLI withdrew a pending permission request (`control_cancel_request`),
 * e.g. because the turn was interrupted. A late answer would be ignored.
 */
export interface PermissionCancelledEvent {
  kind: 'permission-cancelled'
  requestId: string
}

/**
 * The host answered a permission request (written to the CLI). Persisted so
 * prompt state is derived from the event log and survives a reload.
 */
export interface PermissionResolvedEvent {
  kind: 'permission-resolved'
  requestId: string
  decision: PermissionDecision
  /** Which prompt row the user picked (display only, e.g. `yes-always`). */
  optionId?: string
}

/** The CLI reports a new permission mode mid-session (`system/status.permissionMode`). Raw CLI value. */
export interface PermissionModeChangedEvent {
  kind: 'permission-mode-changed'
  mode: string
}

/**
 * Inbound control_request the host does not implement (`hook_callback`,
 * `mcp_message`, …). Transport-internal like `control-response`: the driver
 * answers it with an error at once (an unanswered request stalls the CLI) and
 * never emits it.
 */
export interface HostControlRequestEvent {
  kind: 'host-control-request'
  requestId: string
  subtype: string
}

/**
 * Synthetic event emitted by the transport whenever a fresh OS subprocess is
 * spawned for a chat tab. Carries an opaque `spawnId` (uuid per OS process)
 * that scopes child resources — bg shells especially — to the lifetime of the
 * spawning subprocess. Persisted into the event log as the FIRST event of each
 * subprocess's contribution so replay rebuilds the same scoping.
 *
 * Why a separate token from `turn-init.sessionId`: --resume keeps the same
 * Claude session id across kill+respawn cycles, but bg shells are children of
 * the OS process and die with it. spawnId tracks OS-process identity, which
 * is the actual lifetime of process-children resources.
 */
export interface SessionSpawnEvent {
  kind: 'session-spawn'
  spawnId: string
}

// --- Command tasks (plan 3.9: live output of running commands) ----------------

/**
 * TRANSPORT-INTERNAL (consumed by the Claude driver, never saved or broadcast):
 * one CLI `system/task_*` frame, parsed without knowing what runs it. Only
 * `task_started` names the `task_type`, and `task_updated` carries no
 * `tool_use_id`, so the per-process driver resolves each frame by `taskId` into
 * a `command-task` (a command: Bash, Monitor) or the `sub-agent` event — or
 * drops it.
 */
export interface CliTaskEvent {
  kind: 'cli-task'
  subtype: 'started' | 'updated' | 'notification'
  taskId: string
  /** The tool call the task runs (absent on `task_updated`). */
  toolUseId?: string
  /** `local_bash` (Bash, Monitor), `local_agent` (Task/Agent); only on `task_started`. */
  taskType?: string
  parentToolUseId?: string
  description?: string
  /** `task_started.is_backgrounded` / `task_updated.patch.is_backgrounded`. */
  backgrounded?: boolean
  /** `task_updated.patch.status` / `task_notification.status` (CLI vocabulary). */
  status?: string
  /** `task_updated.patch.end_time` (CLI clock, ms). */
  endTime?: number
  summary?: string
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
  raw: unknown
}

/** Where a command task is. `killed` = stopped (`stop_task`) or killed. */
export type CommandTaskStatus = 'running' | 'completed' | 'failed' | 'killed'

/**
 * A command the agent runs as a CLI task (Claude: a Bash or Monitor call with
 * `task_type: local_bash`). The CLI reports a foreground command a few seconds
 * in; a `run_in_background` one at once. Every event is the task's FULL current
 * state (a snapshot keyed by `taskId`), so applying one twice or a stale one
 * after a newer one is harmless.
 */
export interface CommandTaskEvent {
  kind: 'command-task'
  taskId: string
  /** The tool call (Bash / Monitor) running the command. */
  toolUseId: string
  status: CommandTaskStatus
  /** Runs in the background: its tool call already returned. */
  backgrounded: boolean
  description?: string
  /** Host clock (ms): when the command started (its call, or the approval of it). */
  startedAt?: number
  /** When it ended (ms; the CLI's `end_time` when it reports one). */
  endedAt?: number
}

/**
 * The final output of a BACKGROUND command task, read from the CLI once it
 * ended (a foreground command's output is its tool result). The last 8 KiB.
 */
export interface CommandTaskOutputEvent {
  kind: 'command-task-output'
  taskId: string
  toolUseId: string
  output: string
  /** Size of the whole output (bytes). */
  totalBytes: number
  /** `output` is only the tail of it. */
  truncated: boolean
}

/**
 * A poll of a command task's output (`chat.commandTaskOutput`):
 *   - `running` / `ended` — the output so far (last 8 KiB);
 *   - `gone` — no live process knows the task (it ended with its process, or
 *     the process was replaced): stop polling;
 *   - `unsupported` — the provider reports no task output (Codex).
 */
export type CommandTaskOutput =
  | { state: 'running' | 'ended'; output: string; totalBytes: number; truncated: boolean }
  | { state: 'gone' }
  | { state: 'unsupported' }
