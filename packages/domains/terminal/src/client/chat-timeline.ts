import type {
  AgentEvent,
  AgentPlanStep,
  ChatAttachment,
  CliCommandDetails,
  CliCommandList,
  CommandTaskStatus,
  UserContentBlock,
  HookEffect,
  ModelUsage,
  TokenUsage,
  ToolCallEvent,
  ToolResultEvent
} from '@slayzone/terminal-contracts'
import {
  cliCommandDetailsFromList,
  cliCommandListFromTurnInit,
  conversationAttachmentBytes,
  sameCliCommandList,
  userMessageAttachments,
  type BudgetEntry
} from '@slayzone/terminal-contracts'
import {
  applyPromptEvent,
  expirePendingPrompts,
  expirePrompt,
  type ChatPrompt
} from './chat-prompts'
import { withTurnFilesChanged, type TurnFileChange } from './turn-file-changes'
import {
  extractBgShellSpawn,
  extractShellIdFromSpawnResult,
  extractBashOutputCall,
  extractKillShellCall,
  extractBashOutputResult
} from '@slayzone/terminal-contracts'

/**
 * Render-ready item produced by the reducer. Tool calls are pre-paired with results.
 *
 * `parentToolUseId` links items emitted by a sub-agent (Task tool) back to that
 * sub-agent's tool_use_id. Items with this set live in the flat `timeline` array
 * but are rendered nested inside their parent SubAgentRow, not at the chat root.
 */
/** Where a user message is on its way to the agent (see `UserMessageDeliveryEvent`). */
export type UserDeliveryState =
  | 'queued'
  | 'sending'
  | 'delivered'
  | 'answered'
  | 'failed'
  | 'cancelled'

export type TimelineItem =
  | {
      kind: 'user-text'
      text: string
      timestamp: number
      parentToolUseId?: string
      optimistic?: boolean
      /** Outbox id (absent on messages from before the outbox). */
      id?: string
      /** Delivery state; absent on messages from before the outbox. */
      delivery?: UserDeliveryState
      /** Why it failed (`delivery: 'failed'`). */
      deliveryError?: string
      /** Files attached to the message (absent when none). */
      attachments?: ChatAttachment[]
    }
  /** A turn that failed without a reply: the CLI's own error text (auth, API, …). */
  | { kind: 'turn-error'; text: string; timestamp: number; parentToolUseId?: string }
  /** The agent could not be started (not installed, refused, …) — with a fix. */
  | {
      kind: 'agent-problem'
      code: string
      message: string
      binary?: string
      timestamp: number
      parentToolUseId?: string
    }
  | {
      kind: 'text'
      role: 'assistant'
      messageId: string
      text: string
      /** n-th text block of its message (0-based): with `messageId`, the row's key. */
      blockOrdinal?: number
      /** Still streaming (see `StreamState`); undefined once the block is final. */
      stream?: StreamState
      timestamp: number
      parentToolUseId?: string
    }
  | {
      kind: 'thinking'
      messageId: string
      text: string
      hasSignature: boolean
      /** n-th thinking block of its message (0-based). */
      blockOrdinal?: number
      stream?: StreamState
      timestamp: number
      parentToolUseId?: string
    }
  | {
      kind: 'tool'
      invocation: ToolInvocation
      /** The call's input is still streaming (its live block's `json`); undefined once final. */
      inputStreaming?: true
      timestamp: number
      parentToolUseId?: string
    }
  | {
      kind: 'session-start'
      sessionId: string
      model: string
      cwd: string
      tools: string[]
      timestamp: number
      parentToolUseId?: string
    }
  | {
      kind: 'result'
      subtype: string
      isError: boolean
      durationMs: number
      totalCostUsd: number
      numTurns: number
      text: string | null
      /**
       * This turn's cost. `totalCostUsd` is the CLI's running session total, so
       * a provider that reports per-model accounting gets the delta to the
       * previous result; otherwise it equals `totalCostUsd` (Codex: 0).
       */
      turnCostUsd: number
      /** Concatenated assistant-text from this turn, for the footer Copy button. */
      copyText: string | null
      timestamp: number
      parentToolUseId?: string
    }
  | {
      /** The CLI compacted the conversation (divider), or a compaction failed. */
      kind: 'compaction'
      outcome: 'compacted' | 'failed'
      trigger?: 'manual' | 'auto'
      /** Context tokens before compaction. */
      preTokens?: number
      error?: string
      timestamp: number
      parentToolUseId?: string
    }
  | {
      /** Output of a slash command the CLI ran locally (`/context`, `/usage`, …). */
      kind: 'command-output'
      id: string
      command: string | null
      text: string
      /** The command failed; `text` is the reason. */
      isError?: boolean
      timestamp: number
      parentToolUseId?: string
    }
  | {
      /** A hook run that blocked, failed, timed out, stopped the agent, or added context. */
      kind: 'hook'
      hookId: string
      hookName: string
      hookEvent: string
      effect: HookEffect
      audience: 'agent' | 'user'
      text: string
      exitCode?: number
      timestamp: number
      parentToolUseId?: string
    }
  | {
      /**
       * A notice for the user: the CLI's (e.g. a hook's `systemMessage`), or the
       * transport's own (`code`: resume fallback, watchdog stop, untested CLI).
       */
      kind: 'notice'
      id: string
      level: string
      text: string
      code?: string
      timestamp: number
      parentToolUseId?: string
    }
  | {
      kind: 'api-retry'
      attempt: number
      maxRetries: number
      delayMs: number
      error: string
      timestamp: number
      parentToolUseId?: string
    }
  | { kind: 'rate-limit'; status: string; timestamp: number; parentToolUseId?: string }
  | {
      kind: 'sub-agent'
      /** Pairs enrichment events + the outer Task tool-result to one row. */
      toolUseId: string
      /**
       * Semantic state. `'in-flight'` while any `task_*` system event is the
       * latest signal; flips to `'completed'`/`'failed'` only when the outer
       * Task tool's `tool-result` arrives (or on interrupt / process-exit
       * heal). Decouples UI from SDK subtype strings.
       */
      phase: 'in-flight' | 'completed' | 'failed'
      description?: string
      status?: string
      summary?: string
      durationMs?: number
      toolUses?: number
      totalTokens?: number
      timestamp: number
      parentToolUseId?: string
    }
  | { kind: 'stderr'; text: string; timestamp: number; parentToolUseId?: string }
  | {
      /**
       * The conversation changed shape here (rewind, fork, switch). Nothing is
       * removed: the items `[hiddenFrom, hiddenFrom + hiddenCount)` are what the
       * conversation no longer holds, folded behind this divider by the display.
       */
      kind: 'conversation-branch'
      /** Stable within this timeline (its index when it was added). */
      id: string
      /** `fork-failed`: a `forked` row the CLI refused — it folds nothing. */
      reason: 'rewound' | 'forked' | 'switched' | 'fork-failed'
      hiddenFrom: number
      hiddenCount: number
      timestamp: number
      source?: 'sessions' | 'terminal'
      title?: string
      parentToolUseId?: string
    }
  | {
      kind: 'interrupted'
      timestamp: number
      parentToolUseId?: string
      /** Why the turn ended without a reply; absent = the user stopped it. */
      reason?: 'already-in-conversation'
    }
  | {
      kind: 'plan'
      steps: AgentPlanStep[]
      explanation?: string
      timestamp: number
      parentToolUseId?: string
    }
  | { kind: 'unknown'; reason: string; timestamp: number; parentToolUseId?: string }
  | {
      /** End of a turn: the files the agent's file tools changed in it (`withTurnFilesChanged`). */
      kind: 'files-changed'
      /** `files:<id of the turn's last file tool call>` — the row's key. */
      id: string
      files: TurnFileChange[]
      /** Shell commands the turn ran: files they changed can't be seen from the stream. */
      shellCommands: number
      timestamp: number
      parentToolUseId?: string
    }

/**
 * Where a streamed text/thinking row is:
 *   - `open` — deltas still arrive; its text so far is its live block (`liveBlockOf`);
 *   - `closed` — the block ended (its live text is now `text`) but the provider's
 *     saved block event has not replaced it yet (Codex sends it after the stop).
 * The saved block event finalizes the row in place (same index, same key).
 */
export type StreamState = 'open' | 'closed'

/** What streams into one row: text/thinking so far, or a tool call's input JSON so far. */
export interface LiveBlock {
  /** The row's key (`streamKeyOf`). */
  key: string
  text: string
  json: string
}

/**
 * The blocks streaming right now — normally one (a stream's blocks come one
 * after another). Replaced, never mutated: a delta copies this tiny array.
 */
export type LiveBlocks = readonly LiveBlock[]

/** The live block of the row keyed `key`, when that row streams. */
export function liveBlockOf(live: LiveBlocks, key: string | undefined): LiveBlock | undefined {
  if (!key) return undefined
  for (const block of live) if (block.key === key) return block
  return undefined
}

/** A command the agent runs as a CLI task (Bash, Monitor), as its card shows it. */
export interface CommandTaskView {
  taskId: string
  status: CommandTaskStatus
  /** Runs in the background (its tool call already returned). */
  backgrounded: boolean
  description?: string
  /** Host clock (ms). */
  startedAt?: number
  endedAt?: number
  /** A background command's output, read from the CLI once it ended (last 8 KiB). */
  finalOutput?: { output: string; totalBytes: number; truncated: boolean }
}

export interface ToolInvocation {
  id: string
  name: string
  input: unknown
  status: 'pending' | 'done' | 'error' | 'denied'
  result?: { rawContent: unknown; structured: unknown; isError: boolean }
  /** Set once the CLI reports the call's command as a task (plan 3.9). */
  task?: CommandTaskView
  /**
   * True when the SDK denied the tool call due to permission policy. Sourced
   * from `result.permissionDenials` (authoritative — the closing `result`
   * event lists every tool the SDK refused this turn). Distinct from generic
   * errors: denial means the tool never ran.
   */
  denied?: boolean
}

export interface OpenBlock {
  /**
   * Index into `timeline` where this block's item lives, or -1 if the item hasn't been
   * materialized yet. A text block defers its row to the first non-empty delta (no
   * empty placeholders); a thinking block shows at once ("Thinking…" + timer).
   */
  timelineIndex: number
  blockType: 'text' | 'thinking' | 'tool_use'
  /** Only for tool_use — remembered so we can link a deferred item to `toolIndex`. */
  toolUseId?: string
  toolName?: string
  messageId?: string
  /** Key of the row's live block in `state.live`, once the row exists. */
  liveKey?: string
}

/** Context size + cost of the session, derived from what the provider reports. */
export interface SessionUsage {
  /**
   * Prompt size (input + cache read + cache creation) of the latest
   * main-thread API call. Null when none was reported yet or right after a
   * compaction (the next call reports the new size).
   */
  contextTokens: number | null
  /** Context window of the session's model; null when not reported. */
  contextWindow: number | null
  /** Sum of per-turn costs; null until a result reports per-model accounting. */
  sessionCostUsd: number | null
  /** The latest result's cumulative `totalCostUsd` — base for the next turn's delta. */
  lastTotalCostUsd: number
}

export type BgShellStatus = 'pending' | 'running' | 'completed' | 'killed' | 'failed' | 'unknown'

export interface BgShell {
  /** tool_use_id of the original Bash spawn (`run_in_background: true`). Stable key. */
  spawnToolUseId: string
  /** Claude-assigned shell id (e.g. `bash_1`). Null until spawn's tool_result arrives. */
  shellId: string | null
  command: string
  description?: string
  status: BgShellStatus
  exitCode: number | null
  /** Wall-clock ms when the spawn tool-call entered the timeline. */
  spawnedAt: number
  /** Wall-clock ms of the most recent BashOutput poll, or null. */
  lastPolledAt: number | null
  /** Most recent stdout/stderr chunks observed via BashOutput. Truncated by caller if large. */
  latestStdout: string
  latestStderr: string
  /**
   * Opaque `spawnId` of the OS subprocess that owned this bg shell at spawn
   * time, or null when the spawning process never emitted a `session-spawn`
   * (legacy persisted history before the spawn-token landed). On any new
   * `session-spawn` with a different id, active shells from prior spawnIds
   * are flipped to 'unknown' — bg shells are children of the OS process, so
   * they cannot outlive it.
   */
  spawnedInSpawnId: string | null
}

export interface ChatTimelineState {
  timeline: TimelineItem[]
  /** tool_use_id → index into `timeline` for paired mutation. */
  toolIndex: Map<string, number>
  /** Sub-agent tool_use_id → timeline index. Lets `notification` merge into the row started by `task_started`. */
  subAgentIndex: Map<string, number>
  /**
   * Parent sub-agent tool_use_id → ordered list of timeline indices for items
   * emitted while that sub-agent ran. Built incrementally during reducer
   * insertion so replay rebuilds it deterministically. Read by SubAgentRow to
   * render nested children when expanded.
   */
  childIndex: Map<string, number[]>
  /** True once first turn-init seen. Subsequent turn-inits are treated as turn boundaries (ignored in timeline). */
  sessionStarted: boolean
  sessionId: string | null
  model: string | null
  lastResult: Extract<TimelineItem, { kind: 'result' }> | null
  sessionEnded: boolean
  exitCode: number | null
  exitSignal: string | null
  /** Monotonic count of user messages sent since session start. Drives inFlight. */
  userMessagesSent: number
  /** Count of 'result' events received. */
  resultCount: number
  /** Message id currently streaming (between stream-message-start and stream-message-stop). */
  currentStreamMessageId: string | null
  /** blockIndex → OpenBlock for the currently streaming message. Cleared at message-stop. */
  openBlocks: Map<number, OpenBlock>
  /**
   * What is streaming right now, by row key. A delta changes only this — never
   * `timeline` — so it re-renders the one row that reads it (see `LiveBlocks`).
   */
  live: LiveBlocks
  /**
   * Command tasks by tool_use_id (latest snapshot). Mirrored into the tool row's
   * `invocation.task`; kept here too for a row that arrives after its task.
   */
  commandTasks: Map<string, CommandTaskView>
  /**
   * Live permission mode reported by the running subprocess. Sourced from
   * `turn-init.permissionMode` (one per session start / kill+respawn).
   * Subprocess is the source of truth — DB caches it via main-side persistence.
   * Raw CLI value: 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk'.
   */
  permissionMode: string | null
  /**
   * Background shells spawned via the Bash tool with `run_in_background: true`.
   * Keyed by the SPAWN tool_use_id (stable across the lifecycle); shell_id is
   * filled in on the spawn's tool_result. Order of insertion is preserved by
   * `bgShellOrder` so the UI can render newest-first or oldest-first cheaply.
   */
  bgShells: Map<string, BgShell>
  bgShellOrder: string[]
  /**
   * Maps a `BashOutput`/`KillShell` tool_use_id back to the spawn tool_use_id
   * (and the kind of poll) so the poll's tool_result can be attributed to the
   * right shell, and a successful KillShell can flip status to 'killed' even
   * when the result payload has no explicit status field.
   */
  bgShellPollIndex: Map<string, { spawnToolUseId: string; kind: 'output' | 'kill' }>
  /**
   * Opaque id of the most recent OS subprocess that emitted a `session-spawn`
   * event. Used to scope bg shells to the lifetime of the spawning OS process
   * — bg shells inherit this id at creation; a new `session-spawn` with a
   * different id invalidates any active shells from prior spawns. Null until
   * the first `session-spawn` arrives (legacy buffers without the event).
   */
  currentSpawnId: string | null
  /**
   * True when the session has never spawned a subprocess in this tab's
   * lifetime (lazy-mount or post-reset state). Flipped to false on the first
   * `session-spawn` event — i.e. the kernel has started a real process.
   * Distinct from `sessionEnded` which marks an exited process: `notStarted`
   * is "never began", `sessionEnded` is "ran and then died". Drives the
   * ChatPanel indicator so a fresh tab with persisted history doesn't show
   * "Session ended, click to restart" — there's nothing to restart yet.
   */
  notStarted: boolean
  /**
   * Latest CLI-advertised slash command list (Claude only); null when never
   * reported. Same reference while the content is unchanged, so consumers can
   * memoize on it.
   */
  cliCommands: CliCommandList | null
  /**
   * Description + argument hint per CLI command, from the CLI's `initialize`
   * reply (live only — a reload gets them from the stored snapshot). Describes
   * the CLI, not the conversation, so a new conversation keeps them.
   */
  cliCommandDetails: CliCommandDetails | null
  /** True between a compaction start and its outcome (or the turn's end). */
  compacting: boolean
  usage: SessionUsage
  /** The agent's questions to the user, in arrival order (see `chat-prompts.ts`). */
  prompts: ChatPrompt[]
  /**
   * The previous conversation could not be resumed; the next new session starts
   * BELOW the existing history (a divider), instead of replacing it.
   */
  freshStartPending: boolean
}

const EMPTY_LIVE: LiveBlocks = Object.freeze([])

export function initialState(): ChatTimelineState {
  return {
    timeline: [],
    toolIndex: new Map(),
    subAgentIndex: new Map(),
    childIndex: new Map(),
    sessionStarted: false,
    sessionId: null,
    model: null,
    lastResult: null,
    sessionEnded: false,
    exitCode: null,
    exitSignal: null,
    userMessagesSent: 0,
    resultCount: 0,
    currentStreamMessageId: null,
    openBlocks: new Map(),
    live: EMPTY_LIVE,
    commandTasks: new Map(),
    permissionMode: null,
    bgShells: new Map(),
    bgShellOrder: [],
    bgShellPollIndex: new Map(),
    currentSpawnId: null,
    notStarted: true,
    cliCommands: null,
    cliCommandDetails: null,
    compacting: false,
    usage: { contextTokens: null, contextWindow: null, sessionCostUsd: null, lastTotalCostUsd: 0 },
    prompts: [],
    freshStartPending: false
  }
}

export type Action =
  | { type: 'event'; event: AgentEvent }
  /** Several events in order — one dispatch for a frame's worth of stream deltas. */
  | { type: 'events'; events: AgentEvent[] }
  | { type: 'user-sent'; text: string; id?: string; content?: UserContentBlock[] }
  | { type: 'user-send-failed'; id?: string; error?: string }
  /** Send a failed message again (same id). */
  | { type: 'user-retry'; id: string }
  | { type: 'process-exit'; sessionId: string; code: number | null; signal: string | null }
  | { type: 'turn-interrupted' }
  /**
   * Renderer-only: the server refused an answer because the request is no
   * longer pending (answered elsewhere, or its process is gone). Shown expired.
   */
  | { type: 'prompt-refused'; requestId: string }
  | { type: 'reset' }

export function reducer(state: ChatTimelineState, action: Action): ChatTimelineState {
  if (action.type === 'events') return reduceEvents(state, action.events)
  // A turn's end (or its process's) ends every stream it left open: those rows
  // keep the text they got. The splitter saved them first, so this only heals.
  const kind = action.type === 'event' ? action.event.kind : null
  const base =
    kind === 'result' || kind === 'interrupted' || kind === 'process-exit'
      ? settleStreams(state)
      : state
  const next = applyAction(base, action)
  // Bg-shell tracking is a pure derived view over the same event stream, kept
  // alongside the timeline so it replays from buffered history without a second
  // subscription. We post-process AgentEvents here so the timeline pass stays
  // focused on rendering and bg-shell logic stays in one place.
  if (action.type === 'event') {
    return applyPromptEvent(
      applyBgShellEvent(applyContextUsage(next, action.event), action.event),
      action.event
    )
  }
  if (action.type === 'process-exit') {
    // Live `chat:exit` IPC path. Mirrors the agent-event path so bg shells
    // flip to 'unknown' immediately on subprocess exit even when the
    // persisted `process-exit` event hasn't replayed yet (e.g. live session).
    if (next.sessionEnded) {
      return expirePendingPrompts(invalidateActiveShells(endRunningCommandTasks(next)))
    }
    return next
  }
  if (action.type === 'turn-interrupted') return expirePendingPrompts(next)
  if (action.type === 'prompt-refused') return expirePrompt(next, action.requestId)
  if (action.type === 'reset') {
    // initialState already cleared bg-shells; nothing more to do.
    return next
  }
  return next
}

/** A frame's worth of events, in order — the same as dispatching them one by one. */
function reduceEvents(state: ChatTimelineState, events: AgentEvent[]): ChatTimelineState {
  let acc = state
  for (const event of events) acc = reducer(acc, { type: 'event', event })
  return acc
}

type SingleAction = Exclude<Action, { type: 'events' }>

/**
 * Append `newIdx` to the children list keyed by `parentId`, returning a new map.
 * No-op when `parentId` is undefined (item is a top-level row, not a sub-agent child).
 */
function registerChild(
  state: ChatTimelineState,
  newIdx: number,
  parentId: string | undefined
): Map<string, number[]> {
  if (!parentId) return state.childIndex
  const next = new Map(state.childIndex)
  const arr = next.get(parentId) ?? []
  next.set(parentId, [...arr, newIdx])
  return next
}

function applyAction(state: ChatTimelineState, action: SingleAction): ChatTimelineState {
  switch (action.type) {
    case 'reset':
      return initialState()
    case 'turn-interrupted': {
      // User clicked Stop. The transport kills the subprocess + respawns with
      // --resume; the dying child's process-exit broadcast is swallowed by the
      // identity guard, so `sessionEnded` stays false. Locally we balance
      // resultCount against userMessagesSent so `isInFlight` drops, and append
      // a marker item so the timeline shows where the turn was cut.
      if (!isInFlight(state)) return state
      const item: TimelineItem = { kind: 'interrupted', timestamp: Date.now() }
      return {
        ...state,
        timeline: [...state.timeline, item],
        resultCount: state.resultCount + 1,
        compacting: false
      }
    }
    case 'user-sent': {
      // Optimistic dispatch from the renderer (useChatSession.sendMessage). The
      // matching `user-message` event flowing back from main confirms in place
      // — see the dedup branch in applyEvent('user-message').
      // Drift recovery: same rationale as the user-message branch — a fresh user
      // turn-start while counters still say in-flight means the prior turn was
      // orphaned. Heal so the new optimistic bump doesn't compound prior drift.
      const healed = healOrphanedTurn(state, Date.now())
      const item: TimelineItem = {
        kind: 'user-text',
        text: action.text,
        timestamp: Date.now(),
        optimistic: true,
        ...(action.id ? { id: action.id, delivery: 'queued' as const } : {}),
        ...attachmentsOf(action.content)
      }
      return {
        ...healed,
        timeline: [...healed.timeline, item],
        userMessagesSent: healed.userMessagesSent + 1
      }
    }
    case 'user-send-failed': {
      if (action.id) {
        // The server never took it: the bubble stays, failed, with Retry.
        return setDelivery(state, action.id, 'failed', action.error)
      }
      // Legacy (no id): revert the oldest unconfirmed optimistic user-text. CLI
      // ordering guarantees FIFO: the first user-sent that has no matching
      // user-message back is the one that failed.
      for (let i = 0; i < state.timeline.length; i++) {
        const it = state.timeline[i]
        if (it.kind === 'user-text' && it.optimistic) {
          const next = state.timeline.slice()
          next.splice(i, 1)
          return {
            ...state,
            timeline: next,
            userMessagesSent: Math.max(0, state.userMessagesSent - 1)
          }
        }
      }
      return state
    }
    case 'user-retry':
      return setDelivery(state, action.id, 'queued')
    case 'process-exit': {
      // Drop stale exits: if no session has emitted turn-init yet (sessionId=null)
      // OR the exit's sessionId belongs to a prior, already-replaced session, the
      // event is leakage from the kill+respawn race (e.g. reset). The current
      // session is still alive and will emit its own turn-init/exit.
      if (state.sessionId === null || state.sessionId !== action.sessionId) {
        return state
      }
      // Process death mid-turn → balance counters + clear stream state so the
      // typing indicator can't be stuck on. Mirrors the agent-event branch.
      const healed = healOrphanedTurn(state, Date.now())
      return {
        ...healed,
        sessionEnded: true,
        exitCode: action.code,
        exitSignal: action.signal,
        compacting: false
      }
    }
    case 'event':
      return applyEvent(state, action.event)
    case 'prompt-refused':
      // Prompt-only (post-pass in `reducer`).
      return state
  }
}

/** Start failures the chat shows as a card with a fix (`ChatSpawnFailureCode`). */
function agentProblemCode(detail: unknown): string | null {
  const code = (detail as { code?: unknown } | null | undefined)?.code
  return code === 'cli-not-installed' || code === 'spawn-refused' || code === 'spawn-failed'
    ? code
    : null
}

function findUserItem(state: ChatTimelineState, id: string): number {
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const it = state.timeline[i]
    if (it.kind === 'user-text' && it.id === id) return i
  }
  return -1
}

/**
 * Move a user message to `delivery`. A failed message is not a turn (no longer
 * in flight); leaving `failed` (retry, or a replayed later state) makes it one
 * again — so replay and live views count the same.
 */
function setDelivery(
  state: ChatTimelineState,
  id: string,
  delivery: UserDeliveryState,
  error?: string
): ChatTimelineState {
  const at = findUserItem(state, id)
  if (at < 0) return state
  const it = state.timeline[at] as Extract<TimelineItem, { kind: 'user-text' }>
  if (it.delivery === delivery && it.deliveryError === error) return state
  const wasFailed = it.delivery === 'failed'
  const isFailed = delivery === 'failed'
  const next = state.timeline.slice()
  next[at] = {
    ...it,
    delivery,
    deliveryError: isFailed ? error : undefined,
    ...(isFailed ? { optimistic: false } : {})
  }
  const delta =
    isFailed && !wasFailed ? -1 : wasFailed && !isFailed && delivery !== 'cancelled' ? 1 : 0
  return {
    ...state,
    timeline: next,
    userMessagesSent: Math.max(0, state.userMessagesSent + delta)
  }
}

/** Delivery states (outbox). */
function applyTransportEvent(
  state: ChatTimelineState,
  event: AgentEvent,
  _ts: number
): ChatTimelineState {
  if (event.kind === 'user-message-delivery') {
    return setDelivery(state, event.id, event.state, event.error)
  }
  return state
}

function applyEvent(state: ChatTimelineState, event: AgentEvent): ChatTimelineState {
  const ts = Date.now()
  switch (event.kind) {
    case 'user-message': {
      if (event.history) {
        // Imported from the conversation's past: answered long ago, never a turn.
        const item: TimelineItem = {
          kind: 'user-text',
          text: event.text,
          timestamp: ts,
          ...(event.id ? { id: event.id, delivery: 'answered' as const } : {})
        }
        return { ...state, timeline: [...state.timeline, item] }
      }
      if (event.id) {
        // Confirm the optimistic bubble with the same id in place.
        const at = findUserItem(state, event.id)
        if (at >= 0) {
          const it = state.timeline[at] as Extract<TimelineItem, { kind: 'user-text' }>
          const next = state.timeline.slice()
          // A bubble the client had failed (its request errored) but the server
          // did take is back in flight.
          const revived = it.delivery === 'failed'
          next[at] = {
            ...it,
            text: event.text,
            ...attachmentsOf(event.content),
            timestamp: ts,
            optimistic: false,
            delivery: revived || !it.delivery ? 'queued' : it.delivery,
            deliveryError: undefined
          }
          return {
            ...state,
            timeline: next,
            userMessagesSent: state.userMessagesSent + (revived ? 1 : 0)
          }
        }
      }
      // Confirm the oldest optimistic user-text in place (FIFO — CLI processes
      // sends in order, so the first unconfirmed optimistic item is this one).
      // Only id-less (legacy) bubbles: an id'd bubble is confirmed by its id.
      // Replay path (cold reattach, no prior `user-sent` dispatch) finds none
      // and falls through to append.
      for (let i = 0; i < state.timeline.length; i++) {
        const it = state.timeline[i]
        if (it.kind === 'user-text' && it.optimistic && !it.id && !event.id) {
          const next = state.timeline.slice()
          next[i] = { ...it, text: event.text, timestamp: ts, optimistic: false }
          return { ...state, timeline: next }
        }
      }
      // Drift recovery: a fresh (non-optimistic-confirming) user-message means a new
      // turn starts here. If counters say we're still in-flight, the prior turn never
      // produced its terminator (process crashed mid-turn, app force-quit, dropped event).
      // Auto-insert synthetic `interrupted` to balance counters + clear stream state.
      // Idempotent across replays — pure reducer math, no persistence needed.
      const healed = healOrphanedTurn(state, ts)
      const item: TimelineItem = {
        kind: 'user-text',
        text: event.text,
        timestamp: ts,
        ...(event.id ? { id: event.id, delivery: 'queued' as const } : {}),
        ...attachmentsOf(event.content)
      }
      return {
        ...healed,
        timeline: [...healed.timeline, item],
        userMessagesSent: healed.userMessagesSent + 1
      }
    }
    case 'interrupted': {
      // Synthetic event persisted by main when the user clicks Stop. Mirrors
      // the legacy `'turn-interrupted'` action: balance resultCount against
      // userMessagesSent so isInFlight drops, and append a marker so the
      // timeline shows where the turn was cut. Persisted into the buffer so
      // replay reconstructs the boundary even if the renderer was offline.
      if (!isInFlight(state)) return state
      const item: TimelineItem = {
        kind: 'interrupted',
        timestamp: ts,
        ...(event.reason ? { reason: event.reason } : {})
      }
      const failed = failInFlightSubAgents(state, 'interrupted')
      return {
        ...failed,
        timeline: [...failed.timeline, item],
        resultCount: state.resultCount + 1,
        // Defensive: clear any straggling stream state so the typing indicator
        // can't read "Writing…" off a half-open block once the turn is gone.
        openBlocks: state.openBlocks.size > 0 ? new Map() : state.openBlocks,
        currentStreamMessageId: null,
        compacting: false
      }
    }
    case 'conversation-branch': {
      const len = state.timeline.length
      if (event.reason === 'fork-failed') {
        // The CLI refused the last fork: its row says so and folds nothing; the
        // original conversation goes on (no other id is coming).
        for (let i = len - 1; i >= 0; i--) {
          const it = state.timeline[i]
          if (it.kind !== 'conversation-branch' || it.reason !== 'forked') continue
          const timeline = state.timeline.slice()
          timeline[i] = { ...it, reason: 'fork-failed', hiddenCount: 0 }
          return { ...state, timeline, freshStartPending: false }
        }
        return state
      }
      let from = len
      if (event.reason === 'rewound') {
        // The forgotten message and everything after it.
        const at = event.messageId ? findUserItem(state, event.messageId) : -1
        if (at >= 0) from = at
      } else if (event.reason === 'forked') {
        // Everything after the fork point's turn: from the next user message on.
        const at = event.messageId ? findUserItem(state, event.messageId) : -1
        for (let i = at + 1; at >= 0 && i < len; i++) {
          const it = state.timeline[i]
          if (it.kind === 'user-text' && it.parentToolUseId == null) {
            from = i
            break
          }
        }
      } else {
        // The whole previous conversation: everything since the last switch.
        from = 0
        for (let i = len - 1; i >= 0; i--) {
          const it = state.timeline[i]
          if (it.kind === 'conversation-branch' && it.reason === 'switched') {
            from = i + 1
            break
          }
        }
      }
      const item: TimelineItem = {
        kind: 'conversation-branch',
        id: `branch-${len}`,
        reason: event.reason,
        hiddenFrom: from,
        hiddenCount: len - from,
        timestamp: ts,
        ...(event.source ? { source: event.source } : {}),
        ...(event.title ? { title: event.title } : {})
      }
      return {
        ...state,
        timeline: [...state.timeline, item],
        // A fork / switch runs another conversation id: its turn-init must not
        // wipe the timeline (the history above stays, a divider marks the start).
        freshStartPending: event.reason === 'rewound' ? state.freshStartPending : true
      }
    }
    case 'user-message-popped': {
      // Cancel the trailing user-text that matches the event — by id when both
      // carry one, else by text. Skip session-start (boundary, not turn
      // content); refuse if anything else sits between us and the matching
      // user-text — main side gates emission so this is defensive replay-safety.
      for (let i = state.timeline.length - 1; i >= 0; i--) {
        const it = state.timeline[i]
        if (it.kind === 'session-start') continue
        const matches =
          it.kind === 'user-text' &&
          (event.id !== undefined && it.id !== undefined
            ? it.id === event.id
            : it.text === event.text)
        if (matches) {
          const next = state.timeline.slice()
          next.splice(i, 1)
          return {
            ...state,
            timeline: next,
            userMessagesSent: Math.max(0, state.userMessagesSent - 1)
          }
        }
        return state
      }
      return state
    }
    case 'turn-init': {
      // Restart detection: session previously ended, OR sessionId changed (new process spawned).
      // Kill+create cycle (reset chat, /clear builtin) produces a fresh turn-init — clear timeline
      // and ended-state so the UI re-enables input.
      const isRestart =
        state.sessionStarted &&
        (state.sessionEnded || (state.sessionId !== null && state.sessionId !== event.sessionId))
      if (isRestart && state.freshStartPending) {
        // A failed resume started a new conversation: keep everything above (the
        // user's history and the message being re-sent), mark where it begins.
        const item: TimelineItem = {
          kind: 'session-start',
          sessionId: event.sessionId,
          model: event.model,
          cwd: event.cwd,
          tools: event.tools,
          timestamp: ts
        }
        return {
          ...state,
          timeline: [...state.timeline, item],
          freshStartPending: false,
          sessionId: event.sessionId,
          model: event.model,
          sessionEnded: false,
          exitCode: null,
          exitSignal: null,
          permissionMode: event.permissionMode ?? state.permissionMode,
          cliCommands: nextCliCommands(state.cliCommands, event)
        }
      }
      if (isRestart) {
        const item: TimelineItem = {
          kind: 'session-start',
          sessionId: event.sessionId,
          model: event.model,
          cwd: event.cwd,
          tools: event.tools,
          timestamp: ts
        }
        return {
          ...initialState(),
          timeline: [item],
          sessionStarted: true,
          sessionId: event.sessionId,
          model: event.model,
          permissionMode: event.permissionMode ?? null,
          cliCommands: nextCliCommands(null, event),
          cliCommandDetails: state.cliCommandDetails
        }
      }
      if (state.sessionStarted) {
        return {
          ...state,
          sessionId: event.sessionId,
          model: event.model,
          permissionMode: event.permissionMode ?? state.permissionMode,
          cliCommands: nextCliCommands(state.cliCommands, event)
        }
      }
      const item: TimelineItem = {
        kind: 'session-start',
        sessionId: event.sessionId,
        model: event.model,
        cwd: event.cwd,
        tools: event.tools,
        timestamp: ts
      }
      // Prepend session-start: user messages may arrive in the timeline before turn-init
      // (optimistic user-sent dispatch races the stream). Keep session-start at the top.
      // Also clear any stale end-state: a fresh turn-init means a live process, which may
      // arrive AFTER a late process-exit from a prior (already-replaced) session during reset.
      return {
        ...state,
        timeline: [item, ...state.timeline],
        sessionStarted: true,
        sessionId: event.sessionId,
        model: event.model,
        sessionEnded: false,
        exitCode: null,
        exitSignal: null,
        permissionMode: event.permissionMode ?? state.permissionMode,
        cliCommands: nextCliCommands(state.cliCommands, event)
      }
    }
    case 'assistant-text': {
      // The saved block of a streamed row finalizes that row in place (same
      // index and key: no flicker); otherwise (replay, no stream) it is a row.
      const at = findStreamingRow(state, 'text', event.messageId)
      if (at >= 0) {
        const row = state.timeline[at] as Extract<TimelineItem, { kind: 'text' }>
        return finalizeRow(state, at, { ...row, text: event.text, stream: undefined })
      }
      const item: TimelineItem = {
        kind: 'text',
        role: 'assistant',
        messageId: event.messageId,
        text: event.text,
        blockOrdinal: nextBlockOrdinal(state, 'text', event.messageId),
        timestamp: ts,
        parentToolUseId: event.parentToolUseId
      }
      const childIndex = registerChild(state, state.timeline.length, event.parentToolUseId)
      return { ...state, timeline: [...state.timeline, item], childIndex }
    }
    case 'assistant-thinking': {
      const at = findStreamingRow(state, 'thinking', event.messageId)
      if (at >= 0) {
        const row = state.timeline[at] as Extract<TimelineItem, { kind: 'thinking' }>
        return finalizeRow(state, at, {
          ...row,
          text: event.text,
          stream: undefined,
          hasSignature: event.hasSignature || row.hasSignature
        })
      }
      const item: TimelineItem = {
        kind: 'thinking',
        messageId: event.messageId,
        text: event.text,
        hasSignature: event.hasSignature,
        blockOrdinal: nextBlockOrdinal(state, 'thinking', event.messageId),
        timestamp: ts,
        parentToolUseId: event.parentToolUseId
      }
      const childIndex = registerChild(state, state.timeline.length, event.parentToolUseId)
      return { ...state, timeline: [...state.timeline, item], childIndex }
    }
    case 'tool-call': {
      // Created by its streamed block already: the saved call carries the real
      // input (the stream only had partial JSON); preserve parentToolUseId.
      const existingIdx = state.toolIndex.get(event.id)
      if (existingIdx !== undefined) {
        const target = state.timeline[existingIdx]
        if (target?.kind === 'tool') {
          const next: TimelineItem = {
            ...target,
            inputStreaming: undefined,
            invocation: {
              ...target.invocation,
              name: target.invocation.name || event.name,
              input: target.inputStreaming ? event.input : (target.invocation.input ?? event.input)
            }
          }
          const t = state.timeline.slice()
          t[existingIdx] = next
          return { ...state, timeline: t, live: dropLive(state.live, `tool:${event.id}`) }
        }
      }
      const invocation: ToolInvocation = {
        id: event.id,
        name: event.name,
        input: event.input,
        status: 'pending'
      }
      // A task reported before its call's row (rare): it applies now.
      const task = state.commandTasks.size > 0 ? state.commandTasks.get(event.id) : undefined
      if (task) invocation.task = task
      const item: TimelineItem = {
        kind: 'tool',
        invocation,
        timestamp: ts,
        parentToolUseId: event.parentToolUseId
      }
      const newIndex = new Map(state.toolIndex)
      newIndex.set(event.id, state.timeline.length)
      const childIndex = registerChild(state, state.timeline.length, event.parentToolUseId)
      return {
        ...state,
        timeline: [...state.timeline, item],
        toolIndex: newIndex,
        childIndex
      }
    }
    case 'stream-message-start': {
      return {
        ...state,
        currentStreamMessageId: event.messageId,
        openBlocks: new Map()
      }
    }
    case 'stream-block-start': {
      const messageId = state.currentStreamMessageId
      if (!messageId) return state

      // A tool call shows at once (its name is known); its input streams into live json.
      if (event.blockType === 'tool_use') {
        const toolUseId = event.toolUseId ?? ''
        const invocation: ToolInvocation = {
          id: toolUseId,
          name: event.toolName ?? '',
          input: null,
          status: 'pending'
        }
        const item: TimelineItem = {
          kind: 'tool',
          invocation,
          inputStreaming: true,
          timestamp: ts,
          parentToolUseId: event.parentToolUseId
        }
        const timelineIndex = state.timeline.length
        const liveKey = `tool:${toolUseId}`
        const nextOpen = new Map(state.openBlocks)
        nextOpen.set(event.blockIndex, {
          timelineIndex,
          blockType: 'tool_use',
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          messageId,
          liveKey
        })
        let nextToolIndex = state.toolIndex
        if (event.toolUseId) {
          nextToolIndex = new Map(state.toolIndex)
          nextToolIndex.set(event.toolUseId, timelineIndex)
        }
        const childIndex = registerChild(state, timelineIndex, event.parentToolUseId)
        return {
          ...state,
          timeline: [...state.timeline, item],
          openBlocks: nextOpen,
          toolIndex: nextToolIndex,
          childIndex,
          live: setLive(state.live, { key: liveKey, text: '', json: '' })
        }
      }

      // Thinking shows at once: summarized thinking text arrives late, in a burst.
      if (event.blockType === 'thinking') {
        const blockOrdinal = nextBlockOrdinal(state, 'thinking', messageId)
        const item: TimelineItem = {
          kind: 'thinking',
          messageId,
          text: '',
          hasSignature: false,
          blockOrdinal,
          stream: 'open',
          timestamp: ts,
          parentToolUseId: event.parentToolUseId
        }
        const timelineIndex = state.timeline.length
        const liveKey = `thinking:${messageId}:${blockOrdinal}`
        const nextOpen = new Map(state.openBlocks)
        nextOpen.set(event.blockIndex, { timelineIndex, blockType: 'thinking', messageId, liveKey })
        const childIndex = registerChild(state, timelineIndex, event.parentToolUseId)
        return {
          ...state,
          timeline: [...state.timeline, item],
          openBlocks: nextOpen,
          childIndex,
          live: setLive(state.live, { key: liveKey, text: '', json: '' })
        }
      }

      // Text: the row comes with its first non-empty delta (no empty placeholder).
      const nextOpen = new Map(state.openBlocks)
      nextOpen.set(event.blockIndex, { timelineIndex: -1, blockType: 'text', messageId })
      return { ...state, openBlocks: nextOpen }
    }
    case 'stream-block-delta': {
      const open = state.openBlocks.get(event.blockIndex)
      if (!open) return state

      if (open.timelineIndex === -1) {
        if (open.blockType !== 'text' || event.deltaType !== 'text' || !event.text) return state
        const messageId = open.messageId ?? state.currentStreamMessageId ?? ''
        const blockOrdinal = nextBlockOrdinal(state, 'text', messageId)
        const item: TimelineItem = {
          kind: 'text',
          role: 'assistant',
          messageId,
          text: '',
          blockOrdinal,
          stream: 'open',
          timestamp: ts,
          parentToolUseId: event.parentToolUseId
        }
        const liveKey = `text:${messageId}:${blockOrdinal}`
        const nextOpen = new Map(state.openBlocks)
        nextOpen.set(event.blockIndex, { ...open, timelineIndex: state.timeline.length, liveKey })
        const childIndex = registerChild(state, state.timeline.length, event.parentToolUseId)
        return {
          ...state,
          timeline: [...state.timeline, item],
          openBlocks: nextOpen,
          childIndex,
          live: setLive(state.live, { key: liveKey, text: event.text, json: '' })
        }
      }

      if (event.deltaType === 'signature') {
        // Structural, once per block: the row records that the CLI signed it.
        const target = state.timeline[open.timelineIndex]
        if (target?.kind !== 'thinking' || target.hasSignature) return state
        const t = state.timeline.slice()
        t[open.timelineIndex] = { ...target, hasSignature: true }
        return { ...state, timeline: t }
      }
      // Everything else streams into the live block only — the timeline is untouched.
      const key = open.liveKey
      const live = liveBlockOf(state.live, key)
      if (!live || !event.text) return state
      const next: LiveBlock =
        event.deltaType === 'input_json'
          ? { ...live, json: live.json + event.text }
          : { ...live, text: live.text + event.text }
      return { ...state, live: setLive(state.live, next) }
    }
    case 'stream-block-stop': {
      const open = state.openBlocks.get(event.blockIndex)
      if (!open) return state
      const nextOpen = new Map(state.openBlocks)
      nextOpen.delete(event.blockIndex)
      const settled = settleRow({ ...state, openBlocks: nextOpen }, open.timelineIndex, 'closed')
      return settled
    }
    case 'stream-message-stop':
      return { ...state, currentStreamMessageId: null, openBlocks: new Map() }
    case 'tool-result': {
      // Canonical sub-agent completion signal. Every Task tool_use → exactly
      // one tool_result by SDK contract; closing the sub-agent row here is
      // immune to optional/advisory system events being missing or renamed.
      const baseState = closeSubAgentForToolResult(state, event)
      const idx = baseState.toolIndex.get(event.toolUseId)
      if (idx === undefined) {
        const invocation: ToolInvocation = {
          id: event.toolUseId,
          name: '',
          input: null,
          status: event.isError ? 'error' : 'done',
          result: {
            rawContent: event.rawContent,
            structured: event.structured,
            isError: event.isError
          }
        }
        const item: TimelineItem = {
          kind: 'tool',
          invocation,
          timestamp: ts,
          parentToolUseId: event.parentToolUseId
        }
        const newIndex = new Map(baseState.toolIndex)
        newIndex.set(event.toolUseId, baseState.timeline.length)
        const childIndex = registerChild(
          baseState,
          baseState.timeline.length,
          event.parentToolUseId
        )
        return {
          ...baseState,
          timeline: [...baseState.timeline, item],
          toolIndex: newIndex,
          childIndex
        }
      }
      const target = baseState.timeline[idx]
      if (target.kind !== 'tool') return baseState
      const nextInvocation: ToolInvocation = {
        ...target.invocation,
        status: event.isError ? 'error' : 'done',
        result: {
          rawContent: event.rawContent,
          structured: event.structured,
          isError: event.isError
        }
      }
      const nextTimeline = baseState.timeline.slice()
      nextTimeline[idx] = { ...target, invocation: nextInvocation }
      return { ...baseState, timeline: nextTimeline }
    }
    case 'result': {
      // Collect this turn's assistant text (back to the last user-text or start) for Copy.
      const texts: string[] = []
      for (let i = state.timeline.length - 1; i >= 0; i--) {
        const it = state.timeline[i]
        if (it.kind === 'user-text') break
        if (it.kind === 'text' && it.role === 'assistant') texts.unshift(it.text)
        if (it.kind === 'command-output') texts.unshift(it.text)
      }
      const copyText = texts.length > 0 ? texts.join('\n\n') : null
      const { usage, turnCostUsd } = applyResultCost(state.usage, state.model, event)
      // The CLI's end of a turn the user stopped (Stop, or a prompt's plain "No"):
      // an end, not a failure.
      const stopped =
        typeof event.terminalReason === 'string' && event.terminalReason.startsWith('aborted')
      const item: TimelineItem = {
        kind: 'result',
        subtype: event.subtype,
        isError: event.isError && !stopped,
        durationMs: event.durationMs,
        totalCostUsd: event.totalCostUsd,
        turnCostUsd,
        numTurns: event.numTurns,
        text: event.text,
        copyText,
        timestamp: ts
      }
      // A turn that failed without any reply: its error text (an expired login,
      // an API error) must be readable, not tucked inside the result footer.
      const turnError: TimelineItem[] =
        event.isError && !stopped && event.text && texts.length === 0
          ? [{ kind: 'turn-error', text: event.text, timestamp: ts }]
          : []
      // Mark any tools the SDK denied this turn — `result.permissionDenials`
      // is the authoritative source (e.g. `ExitPlanMode` in plan mode).
      let nextTimeline = [...state.timeline, ...turnError, item]
      const denials = Array.isArray(event.permissionDenials) ? event.permissionDenials : []
      for (const denial of denials) {
        const id = (denial as { tool_use_id?: string } | null)?.tool_use_id
        if (!id) continue
        const idx = state.toolIndex.get(id)
        if (idx === undefined) continue
        const target = nextTimeline[idx]
        if (target?.kind !== 'tool' || target.invocation.denied) continue
        nextTimeline = nextTimeline.slice()
        nextTimeline[idx] = {
          ...target,
          invocation: { ...target.invocation, status: 'denied', denied: true }
        }
      }
      nextTimeline = withTurnFilesChanged(nextTimeline)
      return {
        ...state,
        timeline: nextTimeline,
        lastResult: item,
        // Capped: after Stop (or a prompt's "No") the persisted `interrupted`
        // already closed the turn, and the CLI still sends the aborted turn's
        // result — counting it would mark the NEXT turn finished at its start.
        resultCount: Math.min(state.resultCount + 1, state.userMessagesSent),
        // Defensive: a result terminates the turn. `stream-message-stop` should
        // already have cleared these, but if the SDK closes a turn without one
        // (rate-limit, error path, network drop after partial stream) the typing
        // indicator would otherwise read "Writing…" off a stranded open block.
        openBlocks: state.openBlocks.size > 0 ? new Map() : state.openBlocks,
        currentStreamMessageId: null,
        compacting: false,
        usage
      }
    }
    case 'api-retry':
      return {
        ...state,
        timeline: [
          ...state.timeline,
          {
            kind: 'api-retry',
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            delayMs: event.delayMs,
            error: event.error,
            timestamp: ts
          }
        ]
      }
    case 'rate-limit':
      // Suppress 'allowed' / 'allowed_warning' — informational, not actionable. Only surface
      // blocked / exceeded / hard-limit statuses.
      if (event.status.startsWith('allowed')) return state
      return {
        ...state,
        timeline: [...state.timeline, { kind: 'rate-limit', status: event.status, timestamp: ts }]
      }
    case 'sub-agent': {
      // No tool id = no row it could belong to (rows saved before the driver
      // resolved `task_updated` by task id carry an empty one).
      if (!event.toolUseId) return state
      // Every `task_*` system event is treated as enrichment of an in-flight
      // row. The row is closed (→ 'completed'/'failed') only by the outer Task
      // tool's `tool-result` event — see `case 'tool-result'` below. This
      // anchors completion on a contract-guaranteed signal, immune to
      // missing/renamed/reshaped `task_notification` events.
      //
      // Back-compat: persisted events from before the rename carry legacy
      // phase strings ('started'/'updated'/'notification'). Normalize to
      // 'in-flight' on intake so replay still works — tool-result events
      // were also persisted, so they re-close the row.
      const incomingPhase = normalizeSubAgentPhase(event.phase)
      const id = event.toolUseId
      const existingIdx = id ? state.subAgentIndex.get(id) : undefined
      if (existingIdx !== undefined) {
        const target = state.timeline[existingIdx]
        if (target?.kind === 'sub-agent') {
          // Don't regress a terminal state. Late notification after tool-result
          // is rare but possible (out-of-order delivery).
          const isTerminal = target.phase === 'completed' || target.phase === 'failed'
          const next: TimelineItem = {
            ...target,
            phase: isTerminal ? target.phase : incomingPhase,
            description: event.description ?? target.description,
            status: event.status ?? target.status,
            summary: event.summary ?? target.summary,
            durationMs: event.usage?.durationMs ?? target.durationMs,
            toolUses: event.usage?.toolUses ?? target.toolUses,
            totalTokens: event.usage?.totalTokens ?? target.totalTokens
          }
          const t = state.timeline.slice()
          t[existingIdx] = next
          return { ...state, timeline: t }
        }
      }
      const item: TimelineItem = {
        kind: 'sub-agent',
        toolUseId: id,
        phase: incomingPhase,
        description: event.description,
        status: event.status,
        summary: event.summary,
        durationMs: event.usage?.durationMs,
        toolUses: event.usage?.toolUses,
        totalTokens: event.usage?.totalTokens,
        timestamp: ts,
        parentToolUseId: event.parentToolUseId
      }
      const nextIdx = new Map(state.subAgentIndex)
      if (id) nextIdx.set(id, state.timeline.length)
      const childIndex = registerChild(state, state.timeline.length, event.parentToolUseId)
      return {
        ...state,
        timeline: [...state.timeline, item],
        subAgentIndex: nextIdx,
        childIndex
      }
    }
    case 'agent-plan': {
      // Codex pushes `turn/plan/updated` repeatedly as the plan evolves.
      // Collapse consecutive updates within the same turn into one card:
      // scan back from the tail; if a `plan` item precedes any turn boundary
      // (user-text / result / session-start), replace it in place — else
      // append a fresh card for this turn.
      const item: TimelineItem = {
        kind: 'plan',
        steps: event.steps,
        explanation: event.explanation,
        timestamp: ts
      }
      for (let i = state.timeline.length - 1; i >= 0; i--) {
        const it = state.timeline[i]
        if (it.kind === 'user-text' || it.kind === 'result' || it.kind === 'session-start') {
          break
        }
        if (it.kind === 'plan') {
          const next = state.timeline.slice()
          next[i] = { ...item, timestamp: it.timestamp }
          return { ...state, timeline: next }
        }
      }
      return { ...state, timeline: [...state.timeline, item] }
    }
    case 'compact-status': {
      if (event.phase === 'started')
        return state.compacting ? state : { ...state, compacting: true }
      if (event.phase === 'succeeded') {
        // The divider lands with the `compact-boundary` that follows.
        return state.compacting ? { ...state, compacting: false } : state
      }
      const item: TimelineItem = {
        kind: 'compaction',
        outcome: 'failed',
        error: event.error,
        timestamp: ts
      }
      return { ...state, timeline: [...state.timeline, item], compacting: false }
    }
    case 'compact-boundary': {
      const item: TimelineItem = {
        kind: 'compaction',
        outcome: 'compacted',
        trigger: event.trigger,
        preTokens: event.preTokens,
        timestamp: ts
      }
      return {
        ...state,
        timeline: [...state.timeline, item],
        compacting: false,
        // The CLI's post-compaction count excludes the system prompt + tools;
        // the next call's usage reports the real new size.
        usage: { ...state.usage, contextTokens: null }
      }
    }
    case 'command-output': {
      // A failed `/compact` reports its reason twice: on the status frame
      // (already shown as the failed compaction row) and as command output.
      if (event.command === 'compact' && isCurrentTurnCompactionError(state, event.text)) {
        return state
      }
      const item: TimelineItem = {
        kind: 'command-output',
        id: event.id,
        // A failed custom command doesn't name itself; the `/name …` just sent does.
        command: event.command ?? (event.isError ? lastSentCommand(state.timeline) : null),
        text: event.text,
        ...(event.isError ? { isError: true } : {}),
        timestamp: ts
      }
      return { ...state, timeline: [...state.timeline, item] }
    }
    case 'hook-output': {
      const item: TimelineItem = {
        kind: 'hook',
        hookId: event.hookId,
        hookName: event.hookName,
        hookEvent: event.hookEvent,
        effect: event.effect,
        audience: event.audience,
        text: event.text,
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        timestamp: ts
      }
      return { ...state, timeline: [...state.timeline, item] }
    }
    case 'notice': {
      const item: TimelineItem = {
        kind: 'notice',
        id: event.id,
        level: event.level,
        text: event.text,
        ...(event.code ? { code: event.code } : {}),
        timestamp: ts
      }
      return {
        ...state,
        timeline: [...state.timeline, item],
        // A failed resume: the next new session starts below the history.
        freshStartPending:
          event.code === 'resume-failed-fresh-start' ? true : state.freshStartPending
      }
    }
    case 'stderr':
      return {
        ...state,
        timeline: [...state.timeline, { kind: 'stderr', text: event.text, timestamp: ts }]
      }
    case 'process-exit': {
      // Process exited. If we were mid-turn, heal counters + clear stream state
      // so inFlight drops and the typing indicator clears. Without this, a crash
      // mid-stream leaves "Writing…" stuck forever even after the buffer replay.
      const healed = endRunningCommandTasks(healOrphanedTurn(state, ts))
      return {
        ...healed,
        sessionEnded: true,
        exitCode: event.code,
        exitSignal: event.signal,
        compacting: false
      }
    }
    case 'error': {
      const code = agentProblemCode(event.detail)
      if (code) {
        const binary = (event.detail as { binary?: unknown }).binary
        return {
          ...state,
          timeline: [
            ...state.timeline,
            {
              kind: 'agent-problem',
              code,
              message: event.message,
              ...(typeof binary === 'string' ? { binary } : {}),
              timestamp: ts
            }
          ]
        }
      }
      return {
        ...state,
        timeline: [...state.timeline, { kind: 'stderr', text: event.message, timestamp: ts }]
      }
    }
    case 'unknown':
      // Silently drop — already logged main-side as `[chat-parser] unknown event type=X`.
      // UI noise w/ no signal; wire the event in the adapter when we learn what it is.
      return state
    case 'control-response':
      // Transport intercepts these before they reach the timeline reducer to
      // resolve the matching `sendControlRequest` promise. The case here
      // exists only for exhaustive-switch type-safety; reaching it would mean
      // transport leaked a control_response — defensive no-op.
      return state
    case 'permission-request':
    case 'permission-resolved':
    case 'permission-cancelled':
      // Prompt state lives in `prompts` (post-pass `applyPromptEvent`). No
      // timeline item: the originating tool_use already has its own card, and
      // the prompt dock answers it.
      return state
    case 'permission-mode-changed':
      // Mid-session switch (plan approval, a prompt's mode row). Same field
      // turn-init feeds; the mode pill follows it.
      return { ...state, permissionMode: event.mode }
    case 'host-control-request':
      // Transport-internal (answered by the driver, never emitted).
      return state
    case 'heartbeat':
    case 'command-lifecycle':
    case 'user-replay':
    case 'cli-task':
      // Transport-internal; never broadcast. Defensive no-op.
      return state
    case 'command-task':
      return applyCommandTask(state, event)
    case 'command-task-output': {
      const view = state.commandTasks.get(event.toolUseId)
      if (!view) return state
      return setCommandTask(state, event.toolUseId, {
        ...view,
        finalOutput: {
          output: event.output,
          totalBytes: event.totalBytes,
          truncated: event.truncated
        }
      })
    }
    case 'cli-command-details':
      return { ...state, cliCommandDetails: cliCommandDetailsFromList(event.commands) }
    case 'user-message-delivery':
      return applyTransportEvent(state, event, ts)
    case 'session-spawn':
      // Bg-shell scoping bookkeeping (handled by applyBgShellEvent post-pass).
      // No timeline item — this is process-lifecycle metadata, not chat content.
      // Also clears any prior end-state: a fresh spawn means a live process,
      // even if no turn-init has fired yet (idle agent waiting for user msg).
      // Without this, "Session ended" sticks in the UI after restart until
      // the first user message triggers turn-init.
      //
      // Flip `notStarted` off — the OS subprocess is now running. ChatPanel
      // uses `notStarted` to suppress the "Session ended, click to restart"
      // banner on hydrate-only tabs (where `sessionEnded` is false but no
      // process has started yet).
      // A new process: the previous one's streams and commands are gone with it.
      return {
        ...endRunningCommandTasks(settleStreams(state)),
        currentSpawnId: event.spawnId,
        sessionEnded: false,
        exitCode: null,
        exitSignal: null,
        notStarted: false
      }
  }
}

// --- token streaming (plan 3.2) ------------------------------------------------

/**
 * The row's stable key: `text:<messageId>:<n>` / `thinking:<messageId>:<n>` (n-th
 * block of that kind in its message — the same live and on replay), or
 * `tool:<id>`. It also names the row's live block in `state.live`.
 */
export function streamKeyOf(item: TimelineItem): string | undefined {
  if (item.kind === 'text' || item.kind === 'thinking') {
    return item.blockOrdinal === undefined
      ? undefined
      : `${item.kind}:${item.messageId}:${item.blockOrdinal}`
  }
  if (item.kind === 'tool') return `tool:${item.invocation.id}`
  return undefined
}

function nextBlockOrdinal(
  state: ChatTimelineState,
  kind: 'text' | 'thinking',
  messageId: string
): number {
  // A message's blocks all belong to one turn: none sits before its last result.
  let n = 0
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const it = state.timeline[i]
    if (it.kind === 'result') break
    if (it.kind === kind && it.messageId === messageId) n++
  }
  return n
}

/** The newest still-streaming row of `kind` in message `messageId`, or -1. */
function findStreamingRow(
  state: ChatTimelineState,
  kind: 'text' | 'thinking',
  messageId: string
): number {
  // Every streaming row has a live block: none, no streaming row.
  if (state.live.length === 0) return -1
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const it = state.timeline[i]
    // Streams end with their turn (settled at its result).
    if (it.kind === 'result') return -1
    if (it.kind === kind && it.messageId === messageId && it.stream !== undefined) return i
  }
  return -1
}

function setLive(live: LiveBlocks, block: LiveBlock): LiveBlocks {
  for (let i = 0; i < live.length; i++) {
    if (live[i].key !== block.key) continue
    const next = live.slice()
    next[i] = block
    return next
  }
  return [...live, block]
}

function dropLive(live: LiveBlocks, key: string | undefined): LiveBlocks {
  if (!key) return live
  const at = live.findIndex((b) => b.key === key)
  if (at < 0) return live
  if (live.length === 1) return EMPTY_LIVE
  return live.filter((_, i) => i !== at)
}

/** Replace the row at `at` with its final version; its live block is done. */
function finalizeRow(state: ChatTimelineState, at: number, row: TimelineItem): ChatTimelineState {
  const t = state.timeline.slice()
  t[at] = row
  return { ...state, timeline: t, live: dropLive(state.live, streamKeyOf(row)) }
}

/** A tool call's streamed input JSON (fallback when no saved call replaced it). */
function parseToolJson(json: string): unknown {
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    return json
  }
}

/**
 * End the stream of the row at `at`, keeping what streamed into it:
 * `closed` (its block stopped; a saved event may still finalize it) or
 * `final` (its turn ended; nothing more will come).
 */
function settleRow(
  state: ChatTimelineState,
  at: number,
  mode: 'closed' | 'final'
): ChatTimelineState {
  const row = at >= 0 ? state.timeline[at] : undefined
  if (!row) return state
  const key = streamKeyOf(row)
  const live = liveBlockOf(state.live, key)
  if (row.kind === 'text' || row.kind === 'thinking') {
    if (row.stream === undefined) return state
    const text = row.stream === 'open' && live ? live.text : row.text
    const t = state.timeline.slice()
    if (mode === 'closed') {
      // Its live block stays until the saved event finalizes it: a row that
      // still streams always has one (so an empty `live` means none does).
      t[at] = { ...row, text, stream: 'closed' }
      return { ...state, timeline: t }
    }
    t[at] = { ...row, text, stream: undefined }
    return { ...state, timeline: t, live: dropLive(state.live, key) }
  }
  if (row.kind === 'tool' && row.inputStreaming) {
    const input = row.invocation.input ?? parseToolJson(live?.json ?? '')
    const t = state.timeline.slice()
    t[at] = { ...row, inputStreaming: undefined, invocation: { ...row.invocation, input } }
    return { ...state, timeline: t, live: dropLive(state.live, key) }
  }
  return state
}

/** End every stream still open (turn end, process end): rows keep what they got. */
function settleStreams(state: ChatTimelineState): ChatTimelineState {
  // Nothing streams: no live block (every streaming row has one), no open block.
  if (state.live.length === 0 && state.openBlocks.size === 0) return state
  let next = state
  // Rows of an earlier turn were settled at its end (its `result` row).
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const it = state.timeline[i]
    if (it.kind === 'result') break
    const streaming =
      ((it.kind === 'text' || it.kind === 'thinking') && it.stream !== undefined) ||
      (it.kind === 'tool' && it.inputStreaming)
    if (streaming) next = settleRow(next, i, 'final')
  }
  return {
    ...next,
    live: EMPTY_LIVE,
    openBlocks: next.openBlocks.size > 0 ? new Map() : next.openBlocks,
    currentStreamMessageId: null
  }
}

// --- command tasks (plan 3.9) --------------------------------------------------

/** Record a task's view and mirror it into its tool row. */
function setCommandTask(
  state: ChatTimelineState,
  toolUseId: string,
  view: CommandTaskView
): ChatTimelineState {
  const commandTasks = new Map(state.commandTasks)
  commandTasks.set(toolUseId, view)
  const at = state.toolIndex.get(toolUseId)
  const row = at === undefined ? undefined : state.timeline[at]
  if (at === undefined || row?.kind !== 'tool') return { ...state, commandTasks }
  const t = state.timeline.slice()
  t[at] = { ...row, invocation: { ...row.invocation, task: view } }
  return { ...state, timeline: t, commandTasks }
}

function applyCommandTask(
  state: ChatTimelineState,
  event: Extract<AgentEvent, { kind: 'command-task' }>
): ChatTimelineState {
  const prev = state.commandTasks.get(event.toolUseId)
  const view: CommandTaskView = {
    taskId: event.taskId,
    status: event.status,
    backgrounded: event.backgrounded,
    ...(event.description ? { description: event.description } : {}),
    ...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
    ...(event.endedAt !== undefined ? { endedAt: event.endedAt } : {}),
    ...(prev?.finalOutput ? { finalOutput: prev.finalOutput } : {})
  }
  return setCommandTask(state, event.toolUseId, view)
}

/** The process is gone: its running commands went with it. */
function endRunningCommandTasks(state: ChatTimelineState): ChatTimelineState {
  let next = state
  for (const [toolUseId, view] of state.commandTasks) {
    if (view.status === 'running')
      next = setCommandTask(next, toolUseId, { ...view, status: 'killed' })
  }
  return next
}

/** `{attachments}` for a message's content when it has any (spread into its item). */
function attachmentsOf(content: UserContentBlock[] | undefined): {
  attachments?: ChatAttachment[]
} {
  const files = content ? userMessageAttachments(content) : []
  return files.length > 0 ? { attachments: files } : {}
}

/** Next `cliCommands` for a turn-init: unchanged content keeps the old reference; no list keeps what was known. */
function nextCliCommands(
  prev: CliCommandList | null,
  event: Extract<AgentEvent, { kind: 'turn-init' }>
): CliCommandList | null {
  const next = cliCommandListFromTurnInit(event)
  if (!next || sameCliCommandList(prev, next)) return prev
  return next
}

/** True when the current turn (after the last user-text) holds a failed compaction with this error. */
function isCurrentTurnCompactionError(state: ChatTimelineState, text: string): boolean {
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const it = state.timeline[i]
    if (it.kind === 'user-text') return false
    if (it.kind === 'compaction' && it.outcome === 'failed') {
      return (it.error ?? '').trim() === text.trim()
    }
  }
  return false
}

/** Command name of the latest user message when it was a `/name …` command, else null. */
function lastSentCommand(timeline: TimelineItem[]): string | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const it = timeline[i]
    if (it.kind === 'user-text') return /^\/(\S+)/.exec(it.text.trim())?.[1] ?? null
  }
  return null
}

/**
 * Fold one `result` into the session usage. `totalCostUsd` is cumulative for the
 * CLI session, so this turn's cost is the delta to the previous result; a total
 * that went DOWN means a respawned CLI restarted its counter (it then counts
 * from 0). Only providers that report per-model accounting (`modelUsage`) carry
 * meaningful cost + context-window data — the rest (Codex) leave usage untouched.
 */
function applyResultCost(
  usage: SessionUsage,
  model: string | null,
  event: Extract<AgentEvent, { kind: 'result' }>
): { usage: SessionUsage; turnCostUsd: number } {
  const models = event.modelUsage ?? {}
  if (Object.keys(models).length === 0) return { usage, turnCostUsd: event.totalCostUsd }
  const total = event.totalCostUsd
  const turnCostUsd = total >= usage.lastTotalCostUsd ? total - usage.lastTotalCostUsd : total
  return {
    turnCostUsd,
    usage: {
      ...usage,
      sessionCostUsd: (usage.sessionCostUsd ?? 0) + turnCostUsd,
      lastTotalCostUsd: total,
      contextWindow: resolveContextWindow(models, model) ?? usage.contextWindow
    }
  }
}

/** The session model's context window; else the window of the model that did the most work. */
function resolveContextWindow(
  models: Record<string, ModelUsage>,
  model: string | null
): number | null {
  const exact = model ? models[model]?.contextWindow : undefined
  if (exact && exact > 0) return exact
  let best: { work: number; window: number } | null = null
  for (const m of Object.values(models)) {
    if (!m.contextWindow || m.contextWindow <= 0) continue
    const work =
      m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens + m.outputTokens
    if (!best || work > best.work) best = { work, window: m.contextWindow }
  }
  return best ? best.window : null
}

/** Prompt size of one API call. */
function promptTokens(u: TokenUsage): number {
  return u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens
}

/**
 * Post-pass: the latest main-thread API call's prompt size is the context the
 * conversation occupies. Sub-agent calls (`parentToolUseId`) run in their own
 * context and are ignored.
 */
function applyContextUsage(state: ChatTimelineState, event: AgentEvent): ChatTimelineState {
  if (
    event.kind !== 'assistant-text' &&
    event.kind !== 'assistant-thinking' &&
    event.kind !== 'tool-call'
  ) {
    return state
  }
  if (!event.usage || event.parentToolUseId) return state
  const contextTokens = promptTokens(event.usage)
  if (state.usage.contextTokens === contextTokens) return state
  return { ...state, usage: { ...state.usage, contextTokens } }
}

/** What the composer's context meter can show. Null when the provider reported nothing. */
export interface UsageSummary {
  contextTokens: number | null
  contextWindow: number | null
  sessionCostUsd: number | null
}

/**
 * Encoded bytes of the files this conversation carries since its last
 * compaction (or fresh start) — the composer's view of the attachment budget
 * (the server checks it again).
 */
export function selectConversationAttachmentBytes(state: ChatTimelineState): number {
  const entries: BudgetEntry[] = []
  for (const it of state.timeline) {
    if (it.kind === 'user-text') {
      if (it.attachments)
        entries.push({
          type: 'message',
          ...(it.id ? { id: it.id } : {}),
          attachments: it.attachments
        })
    } else if (
      (it.kind === 'compaction' && it.outcome === 'compacted') ||
      (it.kind === 'notice' && it.code === 'resume-failed-fresh-start')
    ) {
      entries.push({ type: 'boundary' })
    }
  }
  return conversationAttachmentBytes(entries)
}

export function selectUsageSummary(state: ChatTimelineState): UsageSummary | null {
  const { contextTokens, contextWindow, sessionCostUsd } = state.usage
  if (contextTokens === null && contextWindow === null && sessionCostUsd === null) return null
  return { contextTokens, contextWindow, sessionCostUsd }
}

/** Derive whether we're waiting for a response. True if user sent more messages than we've seen results for. */
/**
 * Timeline indexes the conversation no longer holds: every fold of a
 * `conversation-branch` item (rewound, left behind by a fork, a previous
 * conversation).
 */
export function selectFoldedIndexes(timeline: readonly TimelineItem[]): ReadonlySet<number> {
  const folded = new Set<number>()
  for (const it of timeline) {
    if (it.kind !== 'conversation-branch') continue
    for (let i = it.hiddenFrom; i < it.hiddenFrom + it.hiddenCount; i++) folded.add(i)
  }
  return folded
}

/**
 * The user messages (with an id) the conversation still holds, oldest first —
 * what edit / rewind / fork can act on (the server resolves the same list from
 * its log). A failed message never reached the agent.
 */
export function selectActiveUserIds(timeline: readonly TimelineItem[]): string[] {
  const folded = selectFoldedIndexes(timeline)
  const ids: string[] = []
  timeline.forEach((it, i) => {
    if (it.kind !== 'user-text' || !it.id || folded.has(i) || it.parentToolUseId != null) return
    if (it.delivery === 'failed') return
    ids.push(it.id)
  })
  return ids
}

export function isInFlight(state: ChatTimelineState): boolean {
  return state.userMessagesSent > state.resultCount
}

/**
 * AskUserQuestion parks the turn on user input. The card itself surfaces the
 * prompt + answer UI, so a typing indicator below would falsely imply the
 * agent is still working. True while the latest tool in the current turn is
 * an unanswered AskUserQuestion (no later user-text yet).
 */
export function isAwaitingUserQuestion(state: ChatTimelineState): boolean {
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const item = state.timeline[i]
    if (item.kind === 'user-text') return false
    if (item.kind === 'tool' && item.invocation.name === 'AskUserQuestion') return true
  }
  return false
}

/**
 * Drift recovery: when a NEW user-turn boundary lands (user-sent / fresh
 * user-message / process-exit) while counters still say in-flight, the prior
 * turn was orphaned — its terminator (`result` / `interrupted` /
 * `user-message-popped`) never reached the buffer (process killed, app crash,
 * dropped event). Append a synthetic `interrupted` marker, balance counters,
 * and clear stream state so `inFlight` drops and the typing indicator can't
 * sit on a stranded open block.
 *
 * Pure reducer math — idempotent across replays, no persistence needed. Each
 * replay re-derives the same heal points from the buffer's gaps.
 */
function healOrphanedTurn(state: ChatTimelineState, ts: number): ChatTimelineState {
  if (!isInFlight(state)) return state
  const item: TimelineItem = { kind: 'interrupted', timestamp: ts }
  const failed = failInFlightSubAgents(settleStreams(state), 'interrupted')
  return {
    ...failed,
    timeline: [...failed.timeline, item],
    resultCount: state.userMessagesSent,
    openBlocks: state.openBlocks.size > 0 ? new Map() : state.openBlocks,
    currentStreamMessageId: null,
    compacting: false
  }
}

/**
 * If `event` is the `tool-result` for an in-flight sub-agent's outer Task
 * call, flip its phase to `'completed'`/`'failed'`. This is the canonical
 * close signal — the SDK guarantees one tool_result per tool_use.
 */
function closeSubAgentForToolResult(
  state: ChatTimelineState,
  event: ToolResultEvent
): ChatTimelineState {
  const idx = state.subAgentIndex.get(event.toolUseId)
  if (idx === undefined) return state
  const row = state.timeline[idx]
  if (row?.kind !== 'sub-agent' || row.phase !== 'in-flight') return state
  const closed: TimelineItem = {
    ...row,
    phase: event.isError ? 'failed' : 'completed',
    status: row.status ?? (event.isError ? 'failed' : 'completed')
  }
  const t = state.timeline.slice()
  t[idx] = closed
  return { ...state, timeline: t }
}

/**
 * Back-compat normalizer for stored `SubAgentEvent.phase`. Persisted events
 * from before the semantic rename carry legacy CLI subtype strings
 * (`'started'|'updated'|'notification'`). All map to `'in-flight'` on intake;
 * the canonical close signal is the outer Task tool's `tool-result`.
 */
function normalizeSubAgentPhase(phase: string): 'in-flight' | 'completed' | 'failed' {
  if (phase === 'completed' || phase === 'failed') return phase
  return 'in-flight'
}

/**
 * Flip every still-in-flight sub-agent row to `'failed'` with the given status
 * label. Used by the interrupt / process-exit / orphan-heal paths so a Stop
 * press or subprocess crash mid-Task can't leave the row spinning forever
 * (the outer `tool-result` that would normally close it never arrives).
 */
function failInFlightSubAgents(state: ChatTimelineState, statusLabel: string): ChatTimelineState {
  let nextTimeline: TimelineItem[] | null = null
  for (const idx of state.subAgentIndex.values()) {
    const row = state.timeline[idx]
    if (row?.kind !== 'sub-agent') continue
    if (row.phase !== 'in-flight') continue
    if (!nextTimeline) nextTimeline = state.timeline.slice()
    nextTimeline[idx] = { ...row, phase: 'failed', status: row.status ?? statusLabel }
  }
  return nextTimeline ? { ...state, timeline: nextTimeline } : state
}

/**
 * Derive a short status label to show next to the in-flight loading animation.
 * Returns null when there's nothing meaningful to show (caller falls back to
 * generic indicator).
 *
 * Priority (top wins):
 *  1. Latest api-retry / rate-limit in current turn — explains stalls.
 *  2. Latest open stream block — current phase (thinking / writing / tool).
 *  3. Latest meaningful timeline item in current turn — keeps the label
 *     sticky across `stream-block-stop` / `stream-message-stop` gaps so the
 *     indicator never blanks while inFlight.
 */
export function deriveLoadingLabel(state: ChatTimelineState): string | null {
  if (state.compacting) return 'Compacting conversation…'
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const item = state.timeline[i]
    if (item.kind === 'user-text') break
    if (item.kind === 'api-retry') {
      const sec = Math.max(1, Math.round(item.delayMs / 1000))
      return `Retrying (${item.attempt}/${item.maxRetries}) in ${sec}s…`
    }
    if (item.kind === 'rate-limit') {
      return `Rate limited (${item.status})`
    }
  }

  let latestOpen: OpenBlock | null = null
  let latestKey = -1
  for (const [k, v] of state.openBlocks) {
    if (k > latestKey) {
      latestKey = k
      latestOpen = v
    }
  }
  if (latestOpen) {
    if (latestOpen.blockType === 'tool_use') {
      const item = latestOpen.timelineIndex >= 0 ? state.timeline[latestOpen.timelineIndex] : null
      return formatToolLabel(latestOpen.toolName, item)
    }
    if (latestOpen.blockType === 'thinking') return 'Thinking…'
    if (latestOpen.blockType === 'text') return 'Writing…'
  }

  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const item = state.timeline[i]
    if (item.kind === 'user-text') break
    if (item.kind === 'tool') {
      return formatToolLabel(item.invocation.name, item)
    }
    if (item.kind === 'thinking') return 'Thinking…'
    if (item.kind === 'text') return 'Writing…'
    if (item.kind === 'sub-agent') return 'Sub-agent…'
  }

  return null
}

function formatToolLabel(name: string | undefined, item: TimelineItem | null): string {
  const verb = toolVerb(name)
  const target = item?.kind === 'tool' ? extractToolTarget(item.invocation.input) : null
  return target ? `${verb} ${target}` : `${verb}…`
}

function toolVerb(name: string | undefined): string {
  if (!name) return 'Working'
  switch (name) {
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'NotebookRead':
      return 'Read'
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'Edit'
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return 'Run'
    case 'WebFetch':
    case 'WebSearch':
      return 'Fetch'
    case 'Task':
      return 'Sub-agent'
    case 'TodoWrite':
      return 'Plan'
    default:
      return name
  }
}

function extractToolTarget(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  if (typeof obj.file_path === 'string') return basename(obj.file_path)
  if (typeof obj.path === 'string') return basename(obj.path)
  if (typeof obj.command === 'string') return truncate(obj.command, 32)
  if (typeof obj.pattern === 'string') return truncate(obj.pattern, 32)
  if (typeof obj.url === 'string') return truncate(obj.url, 32)
  if (typeof obj.query === 'string') return truncate(obj.query, 32)
  if (typeof obj.description === 'string') return truncate(obj.description, 32)
  return null
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx === -1 ? p : p.slice(idx + 1)
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(1, max - 1))}…`
}

/** Cap kept stdout/stderr to bound memory under chatty bg processes. */
const BG_OUTPUT_KEEP = 4_000

/**
 * Soft cap on retained terminal-status (completed/killed/failed/unknown)
 * shells. Active shells (pending/running) are always kept. Long sessions can
 * accumulate dozens of one-shot bg jobs — without eviction the map grows
 * unboundedly. Oldest terminal entries are evicted first (FIFO over
 * `bgShellOrder`).
 */
const BG_TERMINAL_HISTORY_KEEP = 30

const TERMINAL_BG_STATUSES: ReadonlySet<BgShellStatus> = new Set([
  'completed',
  'killed',
  'failed',
  'unknown'
])

function tail(s: string, max: number): string {
  return s.length > max ? s.slice(s.length - max) : s
}

function evictTerminalShells(
  shells: Map<string, BgShell>,
  order: string[],
  pollIndex: Map<string, { spawnToolUseId: string; kind: 'output' | 'kill' }>
): {
  shells: Map<string, BgShell>
  order: string[]
  pollIndex: Map<string, { spawnToolUseId: string; kind: 'output' | 'kill' }>
} {
  let terminalCount = 0
  for (const s of shells.values()) {
    if (TERMINAL_BG_STATUSES.has(s.status)) terminalCount++
  }
  if (terminalCount <= BG_TERMINAL_HISTORY_KEEP) {
    return { shells, order, pollIndex }
  }
  let toEvict = terminalCount - BG_TERMINAL_HISTORY_KEEP
  const evicted = new Set<string>()
  for (const id of order) {
    if (toEvict <= 0) break
    const shell = shells.get(id)
    if (shell && TERMINAL_BG_STATUSES.has(shell.status)) {
      evicted.add(id)
      toEvict--
    }
  }
  if (evicted.size === 0) return { shells, order, pollIndex }
  const nextShells = new Map<string, BgShell>()
  for (const [k, v] of shells) if (!evicted.has(k)) nextShells.set(k, v)
  const nextOrder = order.filter((id) => !evicted.has(id))
  const nextPollIndex = new Map<string, { spawnToolUseId: string; kind: 'output' | 'kill' }>()
  for (const [pollId, ref] of pollIndex) {
    if (!evicted.has(ref.spawnToolUseId)) nextPollIndex.set(pollId, ref)
  }
  return { shells: nextShells, order: nextOrder, pollIndex: nextPollIndex }
}

function setBgShell(state: ChatTimelineState, shell: BgShell): ChatTimelineState {
  const isNew = !state.bgShells.has(shell.spawnToolUseId)
  const shellMap = new Map(state.bgShells)
  shellMap.set(shell.spawnToolUseId, shell)
  const order = isNew ? [...state.bgShellOrder, shell.spawnToolUseId] : state.bgShellOrder
  // Eviction runs on every setBgShell so terminal-history bound holds across
  // both new spawns AND status transitions (running→completed bumps count).
  const evicted = evictTerminalShells(shellMap, order, state.bgShellPollIndex)
  return {
    ...state,
    bgShells: evicted.shells,
    bgShellOrder: evicted.order,
    bgShellPollIndex: evicted.pollIndex
  }
}

function applyBgShellEvent(state: ChatTimelineState, event: AgentEvent): ChatTimelineState {
  if (event.kind === 'command-task') return applyBgShellCommandTask(state, event)
  if (event.kind === 'command-task-output') {
    const shell = state.bgShells.get(event.toolUseId)
    if (!shell) return state
    return setBgShell(state, { ...shell, latestStdout: tail(event.output, BG_OUTPUT_KEEP) })
  }
  if (event.kind === 'tool-call') return applyBgShellToolCall(state, event)
  if (event.kind === 'tool-result') return applyBgShellToolResult(state, event)
  if (event.kind === 'session-spawn') return invalidateForeignSpawnShells(state, event.spawnId)
  if (event.kind === 'process-exit') return invalidateActiveShells(state)
  return state
}

const ACTIVE_BG_STATUSES: ReadonlySet<BgShellStatus> = new Set(['pending', 'running'])

/**
 * On a fresh `session-spawn`, drop any active (`pending`/`running`) bg shells
 * whose `spawnedInSpawnId` differs from the new id. Bg shells are children of
 * the OS process, so a new spawn implies the prior process (and its shells)
 * are dead — and we have no exit code, no output, no actionable state to
 * preserve. Removing them entirely keeps the banner free of orphan rows the
 * user can't dismiss or act on. Handles app-restart, force-quit, and resume —
 * all of which produce a new spawn even when `sessionId` is preserved.
 */
function invalidateForeignSpawnShells(
  state: ChatTimelineState,
  newSpawnId: string
): ChatTimelineState {
  return dropActiveShells(state, (shell) => shell.spawnedInSpawnId !== newSpawnId)
}

/**
 * On `process-exit` for the current subprocess, drop any active bg shells.
 * The OS reaped them with the parent — they are no longer running, and no
 * useful exit/output state survived. Complements
 * `invalidateForeignSpawnShells` for the in-session graceful-exit case (no
 * follow-up spawn until the user reopens the chat).
 */
function invalidateActiveShells(state: ChatTimelineState): ChatTimelineState {
  return dropActiveShells(state, () => true)
}

function dropActiveShells(
  state: ChatTimelineState,
  predicate: (shell: BgShell) => boolean
): ChatTimelineState {
  const toDrop = new Set<string>()
  for (const [id, shell] of state.bgShells) {
    if (!ACTIVE_BG_STATUSES.has(shell.status)) continue
    if (!predicate(shell)) continue
    toDrop.add(id)
  }
  if (toDrop.size === 0) return state
  const nextShells = new Map<string, BgShell>()
  for (const [id, shell] of state.bgShells) {
    if (!toDrop.has(id)) nextShells.set(id, shell)
  }
  const nextOrder = state.bgShellOrder.filter((id) => !toDrop.has(id))
  const nextPollIndex = new Map<string, { spawnToolUseId: string; kind: 'output' | 'kill' }>()
  for (const [pollId, ref] of state.bgShellPollIndex) {
    if (!toDrop.has(ref.spawnToolUseId)) nextPollIndex.set(pollId, ref)
  }
  return {
    ...state,
    bgShells: nextShells,
    bgShellOrder: nextOrder,
    bgShellPollIndex: nextPollIndex
  }
}

/**
 * A background command task (a `run_in_background` call, or one moved there)
 * is a background job: its task id is the shell id, its status the CLI's.
 */
function applyBgShellCommandTask(
  state: ChatTimelineState,
  event: Extract<AgentEvent, { kind: 'command-task' }>
): ChatTimelineState {
  const existing = state.bgShells.get(event.toolUseId)
  if (!existing && !event.backgrounded) return state
  const status: BgShellStatus = event.status
  if (existing) return setBgShell(state, { ...existing, shellId: event.taskId, status })
  const at = state.toolIndex.get(event.toolUseId)
  const row = at === undefined ? undefined : state.timeline[at]
  const input =
    row?.kind === 'tool' ? ((row.invocation.input ?? {}) as Record<string, unknown>) : {}
  return setBgShell(state, {
    spawnToolUseId: event.toolUseId,
    shellId: event.taskId,
    command: typeof input.command === 'string' ? input.command : '',
    description:
      event.description ?? (typeof input.description === 'string' ? input.description : undefined),
    status,
    exitCode: null,
    spawnedAt: event.startedAt ?? Date.now(),
    lastPolledAt: null,
    latestStdout: '',
    latestStderr: '',
    spawnedInSpawnId: state.currentSpawnId
  })
}

function applyBgShellToolCall(state: ChatTimelineState, event: ToolCallEvent): ChatTimelineState {
  // 1. Bash with run_in_background=true → register a new shell (status pending).
  const spawn = extractBgShellSpawn(event)
  if (spawn) {
    if (state.bgShells.has(spawn.toolUseId)) return state
    const shell: BgShell = {
      spawnToolUseId: spawn.toolUseId,
      shellId: null,
      command: spawn.command,
      description: spawn.description,
      status: 'pending',
      exitCode: null,
      spawnedAt: Date.now(),
      lastPolledAt: null,
      latestStdout: '',
      latestStderr: '',
      spawnedInSpawnId: state.currentSpawnId
    }
    return setBgShell(state, shell)
  }
  // 2. BashOutput / KillShell — remember which spawn this poll targets so the
  //    poll's tool_result can be attributed correctly.
  const output = extractBashOutputCall(event)
  const kill = extractKillShellCall(event)
  const poll = output ?? kill
  if (poll) {
    const owner = findShellByShellId(state, poll.shellId)
    if (!owner) return state
    const nextIdx = new Map(state.bgShellPollIndex)
    nextIdx.set(event.id, {
      spawnToolUseId: owner.spawnToolUseId,
      kind: kill ? 'kill' : 'output'
    })
    return { ...state, bgShellPollIndex: nextIdx }
  }
  return state
}

function applyBgShellToolResult(
  state: ChatTimelineState,
  event: ToolResultEvent
): ChatTimelineState {
  // 1. Spawn result → assign shell id.
  const spawnOwner = state.bgShells.get(event.toolUseId)
  if (spawnOwner && spawnOwner.shellId === null) {
    const shellId = extractShellIdFromSpawnResult(event)
    const next: BgShell = {
      ...spawnOwner,
      shellId: shellId ?? spawnOwner.shellId,
      // Spawn ack means the shell was accepted; promote pending → running.
      status: event.isError ? 'failed' : 'running'
    }
    return setBgShell(state, next)
  }
  // 2. BashOutput / KillShell result → update status/output for the owning shell.
  const ref = state.bgShellPollIndex.get(event.toolUseId)
  if (!ref) return state
  const owner = state.bgShells.get(ref.spawnToolUseId)
  if (!owner) return state
  const sig = extractBashOutputResult(event)
  // KillShell tool_results often omit explicit status. When the originating
  // call was a KillShell and the result wasn't an error, force 'killed' so
  // the UI doesn't perpetually show 'running' for a terminated shell.
  let nextStatus = pickStatus(owner.status, sig.status)
  if (ref.kind === 'kill' && !event.isError && nextStatus !== 'killed') {
    nextStatus = 'killed'
  }
  const next: BgShell = {
    ...owner,
    status: nextStatus,
    exitCode: sig.exitCode ?? owner.exitCode,
    lastPolledAt: Date.now(),
    latestStdout: sig.stdout ? tail(sig.stdout, BG_OUTPUT_KEEP) : owner.latestStdout,
    latestStderr: sig.stderr ? tail(sig.stderr, BG_OUTPUT_KEEP) : owner.latestStderr
  }
  return setBgShell(state, next)
}

function pickStatus(prev: BgShellStatus, incoming: BgShellStatusSignal): BgShellStatus {
  if (incoming) return incoming
  // No status from this result. Don't downgrade a terminal status to running.
  if (prev === 'completed' || prev === 'killed' || prev === 'failed') return prev
  return prev === 'pending' ? 'running' : prev
}

type BgShellStatusSignal = ReturnType<typeof extractBashOutputResult>['status']

function findShellByShellId(state: ChatTimelineState, shellId: string): BgShell | null {
  for (const shell of state.bgShells.values()) {
    if (shell.shellId === shellId) return shell
  }
  return null
}
