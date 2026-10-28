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
  | SessionSpawnEvent
  | AgentPlanEvent

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

/** Synthetic event emitted by the main process when the user sends a message. Buffered so it survives replay. */
export interface UserMessageEvent {
  kind: 'user-message'
  text: string
}

export interface TurnInitEvent {
  kind: 'turn-init'
  sessionId: string
  model: string
  cwd: string
  tools: string[]
  permissionMode?: string
}

export interface AssistantTextEvent {
  kind: 'assistant-text'
  messageId: string
  text: string
  /** Set when this text was emitted by a sub-agent spawned by a Task tool call. */
  parentToolUseId?: string
}

export interface AssistantThinkingEvent {
  kind: 'assistant-thinking'
  messageId: string
  text: string
  hasSignature: boolean
  parentToolUseId?: string
}

export interface ToolCallEvent {
  kind: 'tool-call'
  id: string
  name: string
  input: unknown
  parentToolUseId?: string
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
  totalCostUsd: number
  stopReason: string | null
  terminalReason: string | null
  text: string | null
  modelUsage: Record<string, ModelUsage>
  usage: TokenUsage
  permissionDenials: unknown[]
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUsd: number
}

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

export interface CompactBoundaryEvent {
  kind: 'compact-boundary'
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
