import type {
  AgentEvent,
  AgentPlanStep,
  ToolCallEvent,
  ToolResultEvent
} from '../shared/agent-events'
import {
  extractBgShellSpawn,
  extractShellIdFromSpawnResult,
  extractBashOutputCall,
  extractKillShellCall,
  extractBashOutputResult
} from '../shared/bg-shell-helpers'

/**
 * Render-ready item produced by the reducer. Tool calls are pre-paired with results.
 *
 * `parentToolUseId` links items emitted by a sub-agent (Task tool) back to that
 * sub-agent's tool_use_id. Items with this set live in the flat `timeline` array
 * but are rendered nested inside their parent SubAgentRow, not at the chat root.
 */
export type TimelineItem =
  | {
      kind: 'user-text'
      text: string
      timestamp: number
      parentToolUseId?: string
      optimistic?: boolean
    }
  | {
      kind: 'text'
      role: 'assistant'
      messageId: string
      text: string
      timestamp: number
      parentToolUseId?: string
    }
  | {
      kind: 'thinking'
      messageId: string
      text: string
      hasSignature: boolean
      timestamp: number
      parentToolUseId?: string
    }
  | { kind: 'tool'; invocation: ToolInvocation; timestamp: number; parentToolUseId?: string }
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
      /** Concatenated assistant-text from this turn, for the footer Copy button. */
      copyText: string | null
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
  | { kind: 'interrupted'; timestamp: number; parentToolUseId?: string }
  | {
      kind: 'plan'
      steps: AgentPlanStep[]
      explanation?: string
      timestamp: number
      parentToolUseId?: string
    }
  | { kind: 'unknown'; reason: string; timestamp: number; parentToolUseId?: string }

export interface ToolInvocation {
  id: string
  name: string
  input: unknown
  status: 'pending' | 'done' | 'error' | 'denied'
  result?: { rawContent: unknown; structured: unknown; isError: boolean }
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
   * materialized yet. Text/thinking blocks defer insertion until first delta to avoid
   * rendering empty placeholders (which look like gaps).
   */
  timelineIndex: number
  blockType: 'text' | 'thinking' | 'tool_use'
  /** Only for tool_use — remembered so we can link a deferred item to `toolIndex`. */
  toolUseId?: string
  toolName?: string
  /** Only for tool_use — used to rebuild item when the atomic `tool-call` arrives later. */
  messageId?: string
  /** Accumulating partial_json for tool_use blocks. Parsed on stream-block-stop. */
  partialJson?: string
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
   * Message ids we've already processed via streaming.
   * Atomic `assistant-text` / `assistant-thinking` events for these are suppressed as redundant.
   */
  streamedMessageIds: Set<string>
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
}

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
    streamedMessageIds: new Set(),
    permissionMode: null,
    bgShells: new Map(),
    bgShellOrder: [],
    bgShellPollIndex: new Map(),
    currentSpawnId: null,
    notStarted: true
  }
}

export type Action =
  | { type: 'event'; event: AgentEvent }
  | { type: 'user-sent'; text: string }
  | { type: 'user-send-failed' }
  | { type: 'process-exit'; sessionId: string; code: number | null; signal: string | null }
  | { type: 'turn-interrupted' }
  | { type: 'reset' }

export function reducer(state: ChatTimelineState, action: Action): ChatTimelineState {
  const next = applyAction(state, action)
  // Bg-shell tracking is a pure derived view over the same event stream, kept
  // alongside the timeline so it replays from buffered history without a second
  // subscription. We post-process AgentEvents here so the timeline pass stays
  // focused on rendering and bg-shell logic stays in one place.
  if (action.type === 'event') {
    return applyBgShellEvent(next, action.event)
  }
  if (action.type === 'process-exit') {
    // Live `chat:exit` IPC path. Mirrors the agent-event path so bg shells
    // flip to 'unknown' immediately on subprocess exit even when the
    // persisted `process-exit` event hasn't replayed yet (e.g. live session).
    if (next.sessionEnded) return invalidateActiveShells(next)
    return next
  }
  if (action.type === 'reset') {
    // initialState already cleared bg-shells; nothing more to do.
    return next
  }
  return next
}

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

function applyAction(state: ChatTimelineState, action: Action): ChatTimelineState {
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
        resultCount: state.resultCount + 1
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
        optimistic: true
      }
      return {
        ...healed,
        timeline: [...healed.timeline, item],
        userMessagesSent: healed.userMessagesSent + 1
      }
    }
    case 'user-send-failed': {
      // Revert the oldest unconfirmed optimistic user-text. CLI ordering
      // guarantees FIFO: the first user-sent that has no matching user-message
      // back is the one that failed.
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
        exitSignal: action.signal
      }
    }
    case 'event':
      return applyEvent(state, action.event)
  }
}

function applyEvent(state: ChatTimelineState, event: AgentEvent): ChatTimelineState {
  const ts = Date.now()
  switch (event.kind) {
    case 'user-message': {
      // Confirm the oldest optimistic user-text in place (FIFO — CLI processes
      // sends in order, so the first unconfirmed optimistic item is this one).
      // Replay path (cold reattach, no prior `user-sent` dispatch) finds none
      // and falls through to append.
      for (let i = 0; i < state.timeline.length; i++) {
        const it = state.timeline[i]
        if (it.kind === 'user-text' && it.optimistic) {
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
        timestamp: ts
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
      const item: TimelineItem = { kind: 'interrupted', timestamp: ts }
      const failed = failInFlightSubAgents(state, 'interrupted')
      return {
        ...failed,
        timeline: [...failed.timeline, item],
        resultCount: state.resultCount + 1,
        // Defensive: clear any straggling stream state so the typing indicator
        // can't read "Writing…" off a half-open block once the turn is gone.
        openBlocks: state.openBlocks.size > 0 ? new Map() : state.openBlocks,
        currentStreamMessageId: null
      }
    }
    case 'user-message-popped': {
      // Cancel the trailing user-text whose content matches `event.text`. Skip
      // session-start (boundary, not turn content); refuse if anything else
      // sits between us and the matching user-text — main side gates emission
      // so this is defensive replay-safety.
      for (let i = state.timeline.length - 1; i >= 0; i--) {
        const it = state.timeline[i]
        if (it.kind === 'session-start') continue
        if (it.kind === 'user-text' && it.text === event.text) {
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
          permissionMode: event.permissionMode ?? null
        }
      }
      if (state.sessionStarted) {
        return {
          ...state,
          sessionId: event.sessionId,
          model: event.model,
          permissionMode: event.permissionMode ?? state.permissionMode
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
        permissionMode: event.permissionMode ?? state.permissionMode
      }
    }
    case 'assistant-text': {
      // If this messageId was already streamed, the block items exist. Skip atomic to avoid dupes.
      if (state.streamedMessageIds.has(event.messageId)) return state
      const item: TimelineItem = {
        kind: 'text',
        role: 'assistant',
        messageId: event.messageId,
        text: event.text,
        timestamp: ts,
        parentToolUseId: event.parentToolUseId
      }
      const childIndex = registerChild(state, state.timeline.length, event.parentToolUseId)
      return { ...state, timeline: [...state.timeline, item], childIndex }
    }
    case 'assistant-thinking': {
      if (state.streamedMessageIds.has(event.messageId)) return state
      const item: TimelineItem = {
        kind: 'thinking',
        messageId: event.messageId,
        text: event.text,
        hasSignature: event.hasSignature,
        timestamp: ts,
        parentToolUseId: event.parentToolUseId
      }
      const childIndex = registerChild(state, state.timeline.length, event.parentToolUseId)
      return { ...state, timeline: [...state.timeline, item], childIndex }
    }
    case 'tool-call': {
      // If already created via streaming (block-start), just fill in input (stream path may have
      // failed to parse partial_json) and leave status pending. Preserve parentToolUseId on target.
      const existingIdx = state.toolIndex.get(event.id)
      if (existingIdx !== undefined) {
        const target = state.timeline[existingIdx]
        if (target?.kind === 'tool') {
          const next: TimelineItem = {
            ...target,
            invocation: {
              ...target.invocation,
              name: target.invocation.name || event.name,
              input: target.invocation.input ?? event.input
            }
          }
          const t = state.timeline.slice()
          t[existingIdx] = next
          return { ...state, timeline: t }
        }
      }
      const invocation: ToolInvocation = {
        id: event.id,
        name: event.name,
        input: event.input,
        status: 'pending'
      }
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
      // Do NOT add to `streamedMessageIds` yet — defer until a text/thinking block actually
      // materializes. This lets the atomic `assistant-*` fallback fire if stream produced no
      // content (e.g. tool-only messages, or aborted streams).
      return {
        ...state,
        currentStreamMessageId: event.messageId,
        openBlocks: new Map()
      }
    }
    case 'stream-block-start': {
      const messageId = state.currentStreamMessageId
      if (!messageId) return state

      // For tool_use we materialize immediately — the tool name/id is user-visible right away.
      if (event.blockType === 'tool_use') {
        const invocation: ToolInvocation = {
          id: event.toolUseId ?? '',
          name: event.toolName ?? '',
          input: null,
          status: 'pending'
        }
        const item: TimelineItem = {
          kind: 'tool',
          invocation,
          timestamp: ts,
          parentToolUseId: event.parentToolUseId
        }
        const timelineIndex = state.timeline.length
        const nextOpen = new Map(state.openBlocks)
        nextOpen.set(event.blockIndex, {
          timelineIndex,
          blockType: 'tool_use',
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          messageId,
          partialJson: ''
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
          childIndex
        }
      }

      // Text/thinking: defer materialization until first delta to avoid empty placeholders.
      const nextOpen = new Map(state.openBlocks)
      nextOpen.set(event.blockIndex, {
        timelineIndex: -1,
        blockType: event.blockType,
        messageId
      })
      return { ...state, openBlocks: nextOpen }
    }
    case 'stream-block-delta': {
      const open = state.openBlocks.get(event.blockIndex)
      if (!open) return state

      // Deferred text/thinking: materialize on first content delta (ignore signature-only).
      if (open.timelineIndex === -1) {
        if (event.deltaType === 'signature') return state
        const messageId = open.messageId ?? state.currentStreamMessageId ?? ''
        const nextStreamed = new Set(state.streamedMessageIds)
        if (messageId) nextStreamed.add(messageId)
        if (open.blockType === 'text' && event.deltaType === 'text') {
          const item: TimelineItem = {
            kind: 'text',
            role: 'assistant',
            messageId,
            text: event.text,
            timestamp: ts,
            parentToolUseId: event.parentToolUseId
          }
          const nextOpen = new Map(state.openBlocks)
          nextOpen.set(event.blockIndex, { ...open, timelineIndex: state.timeline.length })
          const childIndex = registerChild(state, state.timeline.length, event.parentToolUseId)
          return {
            ...state,
            timeline: [...state.timeline, item],
            openBlocks: nextOpen,
            streamedMessageIds: nextStreamed,
            childIndex
          }
        }
        if (open.blockType === 'thinking' && event.deltaType === 'thinking') {
          const item: TimelineItem = {
            kind: 'thinking',
            messageId,
            text: event.text,
            hasSignature: false,
            timestamp: ts,
            parentToolUseId: event.parentToolUseId
          }
          const nextOpen = new Map(state.openBlocks)
          nextOpen.set(event.blockIndex, { ...open, timelineIndex: state.timeline.length })
          const childIndex = registerChild(state, state.timeline.length, event.parentToolUseId)
          return {
            ...state,
            timeline: [...state.timeline, item],
            openBlocks: nextOpen,
            streamedMessageIds: nextStreamed,
            childIndex
          }
        }
        return state
      }

      const target = state.timeline[open.timelineIndex]
      if (!target) return state
      if (event.deltaType === 'text' && target.kind === 'text') {
        const next: TimelineItem = { ...target, text: target.text + event.text }
        const t = state.timeline.slice()
        t[open.timelineIndex] = next
        return { ...state, timeline: t }
      }
      if (event.deltaType === 'thinking' && target.kind === 'thinking') {
        const next: TimelineItem = { ...target, text: target.text + event.text }
        const t = state.timeline.slice()
        t[open.timelineIndex] = next
        return { ...state, timeline: t }
      }
      if (event.deltaType === 'signature' && target.kind === 'thinking') {
        const next: TimelineItem = { ...target, hasSignature: true }
        const t = state.timeline.slice()
        t[open.timelineIndex] = next
        return { ...state, timeline: t }
      }
      if (event.deltaType === 'input_json' && target.kind === 'tool') {
        const nextOpen = new Map(state.openBlocks)
        nextOpen.set(event.blockIndex, {
          ...open,
          partialJson: (open.partialJson ?? '') + event.text
        })
        return { ...state, openBlocks: nextOpen }
      }
      return state
    }
    case 'stream-block-stop': {
      const open = state.openBlocks.get(event.blockIndex)
      if (!open) return state
      const nextOpen = new Map(state.openBlocks)
      nextOpen.delete(event.blockIndex)
      if (open.blockType === 'tool_use' && open.partialJson) {
        const target = state.timeline[open.timelineIndex]
        if (target?.kind === 'tool') {
          let parsed: unknown = open.partialJson
          try {
            parsed = JSON.parse(open.partialJson)
          } catch {
            /* keep raw string as best-effort */
          }
          const next: TimelineItem = {
            ...target,
            invocation: { ...target.invocation, input: parsed }
          }
          const t = state.timeline.slice()
          t[open.timelineIndex] = next
          return { ...state, timeline: t, openBlocks: nextOpen }
        }
      }
      return { ...state, openBlocks: nextOpen }
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
      }
      const copyText = texts.length > 0 ? texts.join('\n\n') : null
      const item: TimelineItem = {
        kind: 'result',
        subtype: event.subtype,
        isError: event.isError,
        durationMs: event.durationMs,
        totalCostUsd: event.totalCostUsd,
        numTurns: event.numTurns,
        text: event.text,
        copyText,
        timestamp: ts
      }
      // Mark any tools the SDK denied this turn — `result.permissionDenials`
      // is the authoritative source (e.g. `ExitPlanMode` in plan mode).
      let nextTimeline = [...state.timeline, item]
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
      return {
        ...state,
        timeline: nextTimeline,
        lastResult: item,
        resultCount: state.resultCount + 1,
        // Defensive: a result terminates the turn. `stream-message-stop` should
        // already have cleared these, but if the SDK closes a turn without one
        // (rate-limit, error path, network drop after partial stream) the typing
        // indicator would otherwise read "Writing…" off a stranded open block.
        openBlocks: state.openBlocks.size > 0 ? new Map() : state.openBlocks,
        currentStreamMessageId: null
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
    case 'compact-boundary':
      return state
    case 'stderr':
      return {
        ...state,
        timeline: [...state.timeline, { kind: 'stderr', text: event.text, timestamp: ts }]
      }
    case 'process-exit': {
      // Process exited. If we were mid-turn, heal counters + clear stream state
      // so inFlight drops and the typing indicator clears. Without this, a crash
      // mid-stream leaves "Writing…" stuck forever even after the buffer replay.
      const healed = healOrphanedTurn(state, ts)
      return {
        ...healed,
        sessionEnded: true,
        exitCode: event.code,
        exitSignal: event.signal
      }
    }
    case 'error':
      return {
        ...state,
        timeline: [...state.timeline, { kind: 'stderr', text: event.message, timestamp: ts }]
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
      // Side-channel: inbound control_request from the CLI (e.g.
      // AskUserQuestion under `--permission-prompt-tool stdio`). Renderer
      // subscribes via a separate effect and resolves with
      // `respondPermission`. No timeline item materialized — the originating
      // tool_use already has its own card via the assistant stream.
      return state
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
      return {
        ...state,
        currentSpawnId: event.spawnId,
        sessionEnded: false,
        exitCode: null,
        exitSignal: null,
        notStarted: false
      }
  }
}

/** Derive whether we're waiting for a response. True if user sent more messages than we've seen results for. */
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
  const failed = failInFlightSubAgents(state, 'interrupted')
  return {
    ...failed,
    timeline: [...failed.timeline, item],
    resultCount: state.userMessagesSent,
    openBlocks: state.openBlocks.size > 0 ? new Map() : state.openBlocks,
    currentStreamMessageId: null
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
