import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type RefObject
} from 'react'
import {
  hubSupportsToolPreviews,
  useDirectLease,
  useHubReopen,
  useScopedHubConnection,
  useSubscription
} from '@slayzone/transport/client'
import {
  chatViaDirect,
  noteDirectChatEvent,
  noteDirectChatLink,
  readReplayPages,
  readInitialChatHistory,
  wantedTimelinePages,
  PAGES_PER_REQUEST,
  timelinePagesAll,
  type ChatPaging,
  type OpenedChatHistory
} from './chat-direct'
import {
  readCompleteTextDetail,
  readCompleteToolDetail,
  shareToolDetailReads,
  type ChatTextDetailReader,
  type ChatToolDetailReader
} from './chat-tool-details'
import { useQueryClient } from '@tanstack/react-query'
import { useTRPC, useTRPCClient } from './trpc'
import { safeRandomUUID, useStableCallback } from '@slayzone/ui'
import type {
  AgentEvent,
  ChatBlobChunk,
  ChatHistoryDisplay,
  ChatToolSearchResult,
  PermissionDecision,
  RewindFilesPreview,
  RewindResult,
  RewindScope,
  StopResult,
  UserContentBlock
} from '@slayzone/terminal-contracts'
import {
  CHAT_HISTORY_DISPLAY_VERSION,
  chatCapabilitiesForMode,
  userMessageText,
  userMessageAttachments
} from '@slayzone/terminal-contracts'
import type { ChatPrompt } from '../shared/chat-prompts'
import { summarizeRows } from '../shared/timeline-summary'
import { SessionReadyGate } from '../shared/chat-session-ready'
import {
  afterNextPaint,
  createChatOpenTimer,
  reportChatOpenTiming,
  type ChatOpenTimer
} from '../shared/chat-open-timing'
import { ChatStreamPosition } from '../shared/chat-stream-position'
import {
  initialState,
  reducer,
  type Action as ChatTimelineAction,
  isTurnOpen,
  type ChatTimelineState,
  type TimelineItem,
  type TimelineRows
} from '../shared/chat-timeline'

export type { ChatPaging } from './chat-direct'

export interface UseChatSessionResult {
  state: ChatTimelineState
  /**
   * One chunk of an image / file a saved event references (`chat-blobs`), read over
   * the tab's direct link or the hub. Stable identity.
   */
  readBlob: (sha256: string, offset: number) => Promise<ChatBlobChunk>
  readToolDetail: ChatToolDetailReader
  readTextDetail: ChatTextDetailReader
  /** The rows; `undefined` = not loaded here (paged history). */
  timeline: TimelineRows
  inFlight: boolean
  /** True until the initial buffer replay resolves (on mount / tab reopen). */
  hydrating: boolean
  /** Loaded, but reconnecting or catching up: the turn state shown is the last known one. */
  reconnecting: boolean
  /**
   * This tab's hub socket is down and tRPC is reconnecting it (sleep/wake, a hub
   * freeze, a restart). A load it failed reopens by itself once it is back.
   */
  hubReconnecting: boolean
  loadError: string | null
  /**
   * The tab's chat session could not be opened (`chat.hydrate` rejected). History
   * may still have loaded; this is shown beside it, never as a timeline row.
   */
  hydrateError: string | null
  /** Retry loading history without dropping locally unsent messages. */
  reload: () => void
  /** Paged history (null: the whole history was replayed — every row is here). */
  paging: ChatPaging | null
  /** Load these pages' rows (as of this state's events); already here or loading: skipped. */
  loadPages: (pages: readonly number[]) => void
  /** Drop these pages' rows from memory (any the reducer needs again load again). */
  unloadPages: (pages: readonly number[]) => void
  /** Pages that may hold `query` (paged history; load them to search them). */
  searchPages: (query: string, caseSensitive?: boolean) => Promise<number[] | ChatToolSearchResult>
  /**
   * Live permission mode reported by the running subprocess (raw CLI value,
   * e.g. 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default').
   * Null until the first turn-init has been observed. Subprocess is the source
   * of truth — UI mode pill should follow this when it differs from the cached
   * DB value.
   */
  permissionMode: string | null
  /**
   * The agent's questions to the user (permission requests, AskUserQuestion,
   * plan approval) with their state, derived from the event log — a reload
   * rebuilds them. See `chat-prompts.ts`.
   */
  prompts: ChatPrompt[]
  /** Request ids whose answer is on its way to the server (buttons disabled). */
  submittingPrompts: ReadonlySet<string>
  /**
   * Send a user message (text, or content blocks). It shows at once with its
   * delivery state; it never silently disappears — a failure stays on screen
   * with Retry.
   */
  sendMessage: (input: string | UserContentBlock[], opts?: SendMessageOptions) => Promise<void>
  /**
   * Every agent event this panel applies (live fragments and saved events,
   * deduplicated, after the initial replay) — the same stream the timeline
   * reduces. For consumers that react to the reply as it streams (voice mode).
   * Returns the unsubscribe.
   */
  subscribeEvents: (listener: (event: AgentEvent) => void) => () => void
  /** Send a failed message again (same id, so it is never delivered twice). */
  retryMessage: (id: string) => Promise<void>
  /**
   * Resolve a pending `tool_use_id` (e.g. AskUserQuestion) with a `tool_result`
   * content block instead of a plain user message. Returns true when the
   * adapter accepted the structured result, false when it lacks a structured-
   * input channel — caller should fall back to `sendMessage`.
   */
  sendToolResult: (args: {
    toolUseId: string
    content: string
    isError?: boolean
  }) => Promise<boolean>
  /**
   * Answer a pending prompt. `decision.behavior:'allow'` may carry
   * `updatedInput` (AskUserQuestion answers) and `updatedPermissions` (a
   * "don't ask again" / mode-switch row); `deny` blocks the tool (`interrupt`
   * also stops the turn). `optionId` names the row picked. Resolves false when
   * the request is no longer pending (shown expired), or when an answer for it
   * is already on its way.
   */
  respondPermission: (args: {
    requestId: string
    decision: PermissionDecision
    optionId?: string
  }) => Promise<boolean>
  interrupt: () => Promise<void>
  /**
   * Stop the current turn. If no assistant progress arrived since the user's
   * last message, that message is cancelled instead of leaving an `interrupted`
   * marker — Claude CLI parity. Returns `popped: true` + the cancelled message
   * (`id`, `content` with its attachments, `text`) so the caller can restore it
   * to the chat input field.
   */
  abortAndPop: () => Promise<StopResult>
  kill: () => Promise<void>
  /**
   * The agent was refused because the terminal runs this conversation: stop the
   * terminal (its exit awaited) and start the agent here.
   */
  takeOver: () => Promise<void>
  /**
   * What restoring the files to a past message would change (a dry run; may
   * start the agent). `scope` as in `rewind`.
   */
  rewindPreview: (messageId: string, scope: RewindScope) => Promise<RewindFilesPreview>
  /**
   * Edit & resend (`before`) or rewind to here (`after`): the conversation, the
   * files, or both — live, the agent keeps running. Rejects with why it could not.
   */
  rewind: (args: {
    messageId: string
    scope: RewindScope
    conversation: boolean
    files: boolean
  }) => Promise<RewindResult>
  /**
   * Fork from a past message, in this tab: a new conversation up to the end of
   * that message's turn (the original stays in Sessions). Rejects with why not.
   */
  fork: (messageId: string) => Promise<void>
  /** Clear timeline + ended-state immediately (UX). New turn-init refills on next session. */
  reset: () => void
}

export interface SendMessageOptions {
  /**
   * The outbox id to send under (default: a fresh one). The agent's turn for it
   * carries it as `execution.messageId`, so a caller can tell its reply apart.
   */
  id?: string
}

export interface UseChatSessionOpts {
  /** An admitted history open holds the renderer's startup slot until it settles. */
  trackHistory?: <T>(work: Promise<T>) => Promise<T>
  /** How long the panel waited for its restoration slot (open-timing diagnostic). */
  restoreQueuedMs?: () => number | null
  display?: ChatHistoryDisplay
  tabId: string
  taskId: string
  mode: string
  cwd: string
  /** Optional override. Defaults to falling back to task mode defaults on the main side. */
  providerFlagsOverride?: string | null
}

type ChatIo = ReturnType<typeof chatViaDirect<ReturnType<typeof useTRPCClient>>>

interface HydrateChatCtx {
  trpcClient: ReturnType<typeof useTRPCClient>
  /** History reads: over the direct link when the tab has one, else the hub. */
  reads: Pick<ChatIo, 'openTimeline' | 'getReplay'>
  historyDisplay: () => ChatHistoryDisplay | undefined
  target: {
    tabId: string
    taskId: string
    mode: string
    cwd: string
    providerFlagsOverride: string | null
  }
  gen: number
  genRef: RefObject<number>
  /** Holds sends until this load's hydrate answered (either way). */
  sessionReady: SessionReadyGate
  hydratedRef: RefObject<boolean>
  /** True once any load of this hook finished — the next one is a reload. */
  loadedOnceRef: RefObject<boolean>
  liveQueueRef: RefObject<Array<{ event: AgentEvent; seq: number; live?: number; at?: number }>>
  applyLive: (event: AgentEvent, seq: number, live?: number, at?: number) => void
  /** Apply saved events (seq order) as ONE reducer batch. */
  applySaved: (saved: ReadonlyArray<{ seq: number; event: AgentEvent; at?: number }>) => void
  /** Apply the stream fragments waiting for the next frame now. */
  flushLive: () => void
  /** Adopt a replay's live snapshot (blocks still streaming) at its live counter. */
  applySnapshot: (events: AgentEvent[], afterSeq: number, liveSeq: number) => void
  /** Open from the hub's projection snapshot (paged history). */
  openPaged: (opened: Extract<OpenedChatHistory, { kind: 'paged' }>) => void
  /** Opening from the full replay (no page table). */
  openFull: () => void
  dispatch: Dispatch<ChatTimelineAction>
  onHydrated: () => void
  restoreLocal: (confirmed: ReadonlySet<string>) => void
  /** This open's step timings (`chat-open-timing.ts`), reported once its rows are painted. */
  timer: ChatOpenTimer
  /** Whether reads go over the direct link right now (else the hub). */
  viaDirect: () => boolean
  report: () => void
  onError: (message: string | null) => void
  onHydrateError: (message: string | null) => void
}

/**
 * Async body of the hydrate effect. A plain function (not inline in the hook):
 * the React Compiler cannot lower `finally` clauses.
 *
 * Serialize: AWAIT hydrate, THEN replay. Hydrate inserts the session
 * skeleton into the main-side sessions map (seeded with persisted history)
 * synchronously enough for getBufferSince to return real data. Awaiting
 * guarantees session.buffer is seeded with persisted history.
 *
 * The buffer is the whole history, so a RELOAD (same tab, new folder / flags)
 * clears the timeline right before replaying it — otherwise every message shows
 * twice. The first load never clears: there is nothing to replace, and it keeps
 * an optimistic message sent while that load runs.
 */
async function hydrateAndReplay({
  trpcClient,
  reads,
  historyDisplay,
  target,
  gen,
  genRef,
  sessionReady,
  hydratedRef,
  loadedOnceRef,
  liveQueueRef,
  applyLive,
  applySaved,
  flushLive,
  applySnapshot,
  openPaged,
  openFull,
  dispatch,
  onHydrated,
  restoreLocal,
  onError,
  onHydrateError,
  timer,
  viaDirect,
  report
}: HydrateChatCtx): Promise<void> {
  timer.set('reload', loadedOnceRef.current)
  try {
    await sessionReady.track(trpcClient.chat.hydrate.mutate(target))
    timer.mark('hydrateMs')
    if (gen === genRef.current) onHydrateError(null)
  } catch (e) {
    // Surface hydrate failure but still attempt replay (e.g. session may
    // exist from a previous reattach despite this hydrate rejecting). Not a
    // timeline row: the panel's notice owns load failures, so one cause is
    // shown once, and a reload's reset cannot erase it.
    timer.set('hydrateFailed', true)
    if (gen === genRef.current) onHydrateError(e instanceof Error ? e.message : String(e))
  }
  if (gen !== genRef.current) return
  try {
    const stale = () => gen !== genRef.current
    const history = await readInitialChatHistory(
      reads,
      target.tabId,
      timer,
      stale,
      historyDisplay()
    )
    if (!history || stale()) return
    timer.set('viaDirect', viaDirect())
    const confirmed = new Set<string>()
    if (history.kind === 'paged') {
      openPaged(history)
      for (const [id] of history.state.userIndex.entries()) confirmed.add(id)
    } else {
      openFull()
      if (loadedOnceRef.current) dispatch({ type: 'reset' })
    }
    // Restore the saved history in one batch, then redraw live fragments.
    applySaved(history.events)
    applySnapshot(history.live.events as AgentEvent[], history.live.afterSeq, history.live.liveSeq)
    for (const { event } of history.events) {
      if (event.kind === 'user-message' && event.id) confirmed.add(event.id)
    }
    restoreLocal(confirmed)
    timer.mark('appliedMs')
    onError(null)
  } catch (error) {
    timer.set('failed', true)
    if (gen === genRef.current) onError(error instanceof Error ? error.message : String(error))
  } finally {
    if (gen === genRef.current) {
      // Drain live events queued during hydration. Dedup via the stream position
      // so anything already covered by the replay buffer is skipped.
      hydratedRef.current = true
      loadedOnceRef.current = true
      for (const { event, seq, live, at } of liveQueueRef.current) applyLive(event, seq, live, at)
      liveQueueRef.current = []
      // The loaded state is complete at once, not a frame later.
      flushLive()
      onHydrated()
      report()
    }
  }
}

/** The next animation frame (a timer where there is none, e.g. a non-DOM test). */
function requestFrame(cb: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(() => cb())
  return setTimeout(cb, 16) as unknown as number
}

function cancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
  else clearTimeout(id)
}

/**
 * React hook that spawns and subscribes to a chat session for one tab.
 *
 * Lifecycle:
 * 1. On mount: call chat:hydrate (main process loads persisted buffer into an
 *    in-memory skeleton; does NOT spawn a subprocess). Reattaches to a live
 *    session if one exists for the tab.
 * 2. Subscribe to chat:event and chat:exit, filter by tabId, feed into reducer.
 * 3. Replay buffered events via getBufferSince(tabId, -1) so tab re-open sees prior state.
 * 4. Subprocess starts lazily on the first chat:send (or queue drain). The
 *    explicit "Restart" button in ChatPanel calls chat.start (eager spawn).
 * 5. On unmount: unsubscribe only. Session persists (main keeps buffer). Tab close triggers chat:remove via useTaskTerminals.
 */
export function useChatSession(opts: UseChatSessionOpts): UseChatSessionResult {
  const trackHistory = opts.trackHistory
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  // The tab's direct link to the computer holding its history (docs/direct-link.md):
  // reads, the event stream and simple commands go there; the hub otherwise.
  const { lease: directChat, lost: directChatLost } = useDirectLease(
    trpcClient,
    opts.tabId ? { kind: 'chat', tabId: opts.tabId, taskId: opts.taskId } : null
  )
  const chatIo = chatViaDirect(
    trpcClient,
    directChat?.client ?? null,
    directChatLost,
    (withDisplay) => hubSupportsToolPreviews(trpcClient, withDisplay)
  )
  // Fixed identities for the hydrate effect: they read the CURRENT path when called,
  // so a lease that comes or goes does not re-run the load.
  const openTimelineRead = useStableCallback((input: Parameters<typeof chatIo.openTimeline>[0]) =>
    chatIo.openTimeline(input)
  )
  const getReplayRead = useStableCallback((input: Parameters<typeof chatIo.getReplay>[0]) =>
    chatIo.getReplay(input)
  )
  const readsViaDirect = useStableCallback(() => directChat !== null)
  const restoreQueuedMs = useStableCallback(() => opts.restoreQueuedMs?.() ?? null)
  const readToolDetailOnce = useStableCallback<
    Parameters<ChatToolDetailReader>,
    ReturnType<ChatToolDetailReader>
  >((ref, signal) => readCompleteToolDetail(chatIo, opts.tabId, ref, signal))
  const readTextDetailOnce = useStableCallback<
    Parameters<ChatTextDetailReader>,
    ReturnType<ChatTextDetailReader>
  >((ref, signal) => readCompleteTextDetail(chatIo, opts.tabId, ref, signal))
  const [readTextDetail] = useState(() => shareToolDetailReads(readTextDetailOnce))
  const historyDisplay = useStableCallback(() => opts.display)
  const readBlob = useStableCallback(
    (sha256: string, offset: number) =>
      chatIo.readBlob({ tabId: opts.tabId, sha256, offset }) as Promise<ChatBlobChunk>
  )
  const [readToolDetail] = useState(() => shareToolDetailReads(readToolDetailOnce))
  // Whether the provider starts turns by itself decides what reads as working.
  const [state, dispatch] = useReducer(reducer, opts.mode, (mode: string) =>
    initialState({ agentStartedTurns: chatCapabilitiesForMode(mode).agentStartedTurns })
  )
  useLayoutEffect(() => {
    dispatch({
      type: 'configure',
      agentStartedTurns: chatCapabilitiesForMode(opts.mode).agentStartedTurns
    })
  }, [opts.mode])
  const stateRef = useRef(state)
  useLayoutEffect(() => {
    stateRef.current = state
  }, [state])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [hydrateError, setHydrateError] = useState<string | null>(null)
  // The same, synchronously: a socket reopen can come before the failure renders.
  const loadFailedRef = useRef({ load: false, hydrate: false })
  const noteLoadError = useStableCallback((message: string | null) => {
    loadFailedRef.current.load = message !== null
    setLoadError(message)
  })
  const noteHydrateError = useStableCallback((message: string | null) => {
    loadFailedRef.current.hydrate = message !== null
    setHydrateError(message)
  })
  // Where this panel stands in the tab's stream: newest saved event, live counter,
  // server instance (`ChatStreamPosition`, the rule mobile shares).
  const positionRef = useRef(new ChatStreamPosition())
  // A catch-up (assigned below: it needs `applyLive`). `shown`: the panel says it is
  // reconnecting meanwhile (not for the routine one when the stream first starts).
  const resyncRef = useRef<(shown: boolean) => void>(() => undefined)
  // Answers on their way to the server: the ref is the synchronous double-click
  // guard, the state drives the disabled buttons.
  const submittingRef = useRef<Set<string>>(new Set())
  const [submittingPrompts, setSubmittingPrompts] = useState<ReadonlySet<string>>(() => new Set())

  // Per-(re)hydration mutable state shared between the always-on subscriptions
  // and the hydrate effect. `genRef` is the staleness token (replaces the old
  // `cancelled` flag): each hydrate run bumps it; subscription callbacks + async
  // continuations compare against it so a tab/opts change cleanly ignores
  // in-flight work from the previous session. `hydratedRef` gates the queue
  // (queue events until the buffer replay completes), `liveQueueRef` holds them.
  const genRef = useRef(0)
  // The current load's hydrate: the computer holds the tab's session only once it
  // ran there, and a command that overtakes it is refused ("No chat session for
  // tab"). Commands that need the session wait on it.
  const [sessionReady] = useState(() => new SessionReadyGate())
  const hydratedRef = useRef(false)
  const loadedOnceRef = useRef(false)
  const liveQueueRef = useRef<
    Array<{ event: AgentEvent; seq: number; live?: number; at?: number }>
  >([])

  // Live events (stream fragments) wait for the next animation frame and go to
  // the reducer together: a burst of deltas is one render, not one per message
  // (plan 3.2). A saved event first flushes what waits, so order is kept.
  const pendingLiveRef = useRef<AgentEvent[]>([])
  const frameRef = useRef<number | null>(null)
  const flushLive = useCallback((): void => {
    if (frameRef.current !== null) {
      cancelFrame(frameRef.current)
      frameRef.current = null
    }
    const events = pendingLiveRef.current
    if (events.length === 0) return
    pendingLiveRef.current = []
    dispatch({ type: 'events', events })
  }, [])
  /** A new load (or unmount): fragments of the old one must never apply. */
  const discardPendingLive = useCallback((): void => {
    if (frameRef.current !== null) {
      cancelFrame(frameRef.current)
      frameRef.current = null
    }
    pendingLiveRef.current = []
  }, [])

  // Stable: only reads refs + stable setters. Applies one event to the reducer.
  //
  // A LIVE event (`live` set: a streaming fragment, a `sending` state — never
  // saved) belongs right after saved event `seq`: it applies only if that is
  // still the newest saved event here and it is newer than the last live one.
  // Otherwise it is stale (the saved event it led to is already applied). A
  // saved event's rows show `at`, when it was saved.
  const applyCliMetadata = useStableCallback((event: AgentEvent) => {
    if (event.kind !== 'cli-models') return
    const queryKey = trpc.chat.getModels.queryKey({ taskId: opts.taskId, mode: opts.mode })
    // Initialize can beat both the subscription and an older empty metadata query.
    void queryClient.cancelQueries({ queryKey }).then(() => {
      queryClient.setQueryData(queryKey, event.models)
    })
  })
  // Event-tap listeners (`subscribeEvents`). Only events applied once hydrated:
  // the initial replay is history, not something happening now.
  const tapRef = useRef(new Set<(event: AgentEvent) => void>())
  const tapEvent = useCallback((event: AgentEvent): void => {
    if (!hydratedRef.current) return
    for (const listener of tapRef.current) listener(event)
  }, [])
  const subscribeEvents = useCallback((listener: (event: AgentEvent) => void) => {
    const taps = tapRef.current
    taps.add(listener)
    return () => {
      taps.delete(listener)
    }
  }, [])
  const applyLive = useCallback(
    (event: AgentEvent, seq: number, live?: number, at?: number): void => {
      if (live !== undefined) {
        const verdict = positionRef.current.live(event, seq, live)
        // Missed something while connected (a dropped event, the computer
        // restarted): read what is new — the server's current turn status with it.
        if (verdict === 'resync') resyncRef.current(true)
        if (verdict !== 'apply') return
        applyCliMetadata(event)
        tapEvent(event)
        pendingLiveRef.current.push(event)
        if (frameRef.current === null) {
          frameRef.current = requestFrame(() => {
            frameRef.current = null
            flushLive()
          })
        }
        return
      }
      if (positionRef.current.saved(seq) === 'duplicate') return
      flushLive()
      tapEvent(event)
      dispatch({ type: 'event', event, at, seq })
    },
    [flushLive, applyCliMetadata, tapEvent]
  )
  // Stable: refs + dispatch only. Saved events in seq order as one batch — the
  // same as applying each through `applyLive` (fragments waiting for a frame
  // still go first), in one reducer call and one render.
  const applySaved = useCallback(
    (saved: ReadonlyArray<{ seq: number; event: AgentEvent; at?: number }>): void => {
      const events: AgentEvent[] = []
      const at: Array<number | undefined> = []
      const seq: number[] = []
      for (const b of saved) {
        if (positionRef.current.saved(b.seq) === 'duplicate') continue
        tapEvent(b.event)
        events.push(b.event)
        at.push(b.at)
        seq.push(b.seq)
      }
      if (events.length === 0) return
      flushLive()
      dispatch({ type: 'events', events, at, seq })
    },
    [flushLive, tapEvent]
  )
  useEffect(() => discardPendingLive, [discardPendingLive])

  // Paged history (`openTimeline`): the page table, and the pages on their way.
  const [paging, setPaging] = useState<ChatPaging | null>(null)
  // Bumped to open the tab again (pages asked for no longer fit: rows moved).
  const [reopenToken, setReopenToken] = useState(0)
  const loadingPagesRef = useRef<Set<number>>(new Set())
  // Renderer actions (a message sent) while a load runs: a paged open replaces
  // the state, so they are applied again on top of it.
  const localActionsRef = useRef<ChatTimelineAction[]>([])
  const keepLocalRef = useRef<Array<Extract<TimelineItem, { kind: 'user-text' }>>>([])
  const loadedTargetRef = useRef<string | null>(null)
  const restoreLocal = useCallback((confirmed: ReadonlySet<string>) => {
    dispatch({ type: 'restore-local-messages', messages: keepLocalRef.current })
    for (const action of localActionsRef.current) {
      if (
        (action.type === 'user-sent' || action.type === 'user-send-failed') &&
        action.id &&
        confirmed.has(action.id)
      )
        continue
      if (action.type === 'user-sent' && action.id) {
        const attachments = userMessageAttachments(action.content ?? [])
        dispatch({
          type: 'restore-local-messages',
          messages: [
            {
              kind: 'user-text',
              id: action.id,
              text: action.text,
              timestamp: Date.now(),
              optimistic: true,
              delivery: 'queued',
              ...(attachments.length ? { attachments } : {})
            }
          ]
        })
      } else dispatch(action)
    }
    localActionsRef.current = []
    keepLocalRef.current = []
  }, [])

  // Stable: refs + dispatch only.
  const dispatchLocal = useCallback((action: ChatTimelineAction): void => {
    if (!hydratedRef.current) localActionsRef.current.push(action)
    dispatch(action)
  }, [])
  // Stable: refs + dispatch + setters only.
  const openPaged = useCallback((opened: Extract<OpenedChatHistory, { kind: 'paged' }>): void => {
    dispatch({ type: 'restore', state: opened.state })
    positionRef.current.seq = opened.seq
    loadingPagesRef.current.clear()
    setPaging(opened.paging)
  }, [])
  const openFull = useCallback((): void => {
    loadingPagesRef.current.clear()
    setPaging(null)
  }, [])

  // Rows of pages, as of the events this state applied (a stall's queued ones
  // are not in it yet). Rows that moved since they were asked for: open again.
  const requestPages = useStableCallback(
    (wanted: number[], gen: number, epoch: number, asOfSeq: number): void => {
      const settings =
        paging?.displaySettings === CHAT_HISTORY_DISPLAY_VERSION || paging?.displaySettings === 2
          ? historyDisplay()
          : undefined
      const display = paging?.windowed ? { ...settings, windowed: true as const } : settings
      timelinePagesAll(
        chatIo,
        {
          tabId: opts.tabId,
          pages: wanted,
          asOfSeq,
          epoch,
          pageRows: paging?.pageRows ?? 0,
          ...(paging?.toolPreviews ? { toolPreviews: true } : {}),
          ...(display ? { display } : {})
        },
        () => gen !== genRef.current
      ).then(
        (res) => {
          if (gen !== genRef.current) return
          for (const page of wanted) loadingPagesRef.current.delete(page)
          if (!res) return
          if (res.expired) {
            setReopenToken((t) => t + 1)
            return
          }
          for (const page of res.pages) {
            dispatch({
              type: 'rows-loaded',
              from: page.from,
              rows: page.rows as TimelineItem[],
              epoch
            })
          }
        },
        () => {
          if (gen !== genRef.current) return
          for (const page of wanted) loadingPagesRef.current.delete(page)
          // Without those rows the reducer can't go on: open again.
          setReopenToken((t) => t + 1)
        }
      )
    }
  )
  const loadPages = useStableCallback((pages: readonly number[]): void => {
    if (!paging) return
    const wanted = wantedTimelinePages(pages, state.timeline, paging, loadingPagesRef.current)
    if (wanted.length === 0) return
    for (const page of wanted) loadingPagesRef.current.add(page)
    const gen = genRef.current
    const epoch = state.rowsEpoch
    const asOfSeq = state.appliedSeq
    // A request at most this many pages (a whole history loads in several).
    for (let at = 0; at < wanted.length; at += PAGES_PER_REQUEST) {
      requestPages(wanted.slice(at, at + PAGES_PER_REQUEST), gen, epoch, asOfSeq)
    }
  })
  const searchPages = useStableCallback(
    (query: string, caseSensitive?: boolean): Promise<number[] | ChatToolSearchResult> =>
      paging
        ? chatIo.searchTimeline({ tabId: opts.tabId, query, caseSensitive }).then(
            (matches) =>
              paging.windowed && !Array.isArray(matches) && matches.windowedPages
                ? { ...matches, pages: matches.windowedPages }
                : matches,
            () => []
          )
        : Promise.resolve([])
  )
  const unloadPages = useStableCallback((pages: readonly number[]): void => {
    if (!paging) return
    const summaries = paging.summaries.slice()
    let changed = false
    for (const page of pages) {
      if (page < 0 || page >= paging.sealed) continue
      const from = page * paging.pageRows
      const rows = state.timeline.slice(from, from + paging.pageRows)
      if (rows.some((r) => r === undefined)) continue
      // What the page holds NOW (a late event may have changed it since the
      // hub's summary): the summary stands in for it while it is not loaded.
      summaries[page] = summarizeRows(rows as TimelineItem[], from)
      changed = true
      dispatch({ type: 'rows-unloaded', from, to: from + paging.pageRows })
    }
    if (changed) setPaging({ ...paging, summaries })
  })
  // The reducer waits for a row: load its page. Not a page row (a tail row
  // never leaves): open again, from scratch.
  const onStalled = useStableCallback((need: number): void => {
    if (!paging || need >= paging.sealed * paging.pageRows) setReopenToken((t) => t + 1)
    else loadPages([Math.floor(need / paging.pageRows)])
  })
  const stalledNeed = state.stalled?.need ?? null
  useEffect(() => {
    if (stalledNeed !== null) onStalled(stalledNeed)
  }, [stalledNeed, onStalled])

  // Subscribe (always-on; mounted on first render, BEFORE the hydrate effect
  // runs) so we don't miss events emitted between session spawn and the
  // getBufferSince replay below. While hydrating, queue events instead of
  // dispatching — `session-spawn` (and other events from the fresh subprocess)
  // can race ahead of getBufferSince, advance the stream position, and make the
  // replay's seq dedup drop the entire historical buffer. Drained
  // after replay. Server fan-out is global; filter by tabId here. The chat
  // event payload is the domain's own AgentEvent vocabulary (router types it as
  // `unknown` so the boundary stays vocabulary-agnostic) — cast at the seam.
  // Stable handler (reads refs + the latest tabId) — refs must not be touched
  // from a closure built during render.
  const handleEvent = useStableCallback(
    ({
      tabId,
      event,
      seq,
      live,
      at
    }: {
      tabId: string
      event: unknown
      seq: number
      live?: number
      at?: number
    }) => {
      if (tabId !== opts.tabId) return
      const agentEvent = event as AgentEvent
      if (!hydratedRef.current) {
        applyCliMetadata(agentEvent)
        liveQueueRef.current.push({ event: event as AgentEvent, seq, live, at })
        return
      }
      applyLive(event as AgentEvent, seq, live, at)
    }
  )
  // Stable: refs + dispatch only.
  const applySnapshot = useCallback(
    (events: AgentEvent[], afterSeq: number, liveSeq: number): void => {
      if (positionRef.current.snapshot({ afterSeq, liveSeq, events }) === 'skip') return
      for (const event of events) applyCliMetadata(event)
      if (events.length > 0) dispatch({ type: 'events', events })
    },
    [applyCliMetadata]
  )
  // The lease whose computer stream has started (onStarted). Make-before-break: the
  // hub stream stays on until then, so an event saved while the direct subscription
  // is being set up arrives on the hub stream (seq dedupe drops the overlap).
  const [directStartedFor, setDirectStartedFor] = useState<typeof directChat>(null)
  const directLive = directChat !== null && directStartedFor === directChat
  // The hub stream was down since the panel loaded (`connecting`: tRPC reconnects).
  const streamDroppedRef = useRef(false)
  const hubStreamStarted = useStableCallback(() => {
    const dropped = streamDroppedRef.current
    streamDroppedRef.current = false
    resyncRef.current(dropped)
  })
  // The hub relays this tab — and asks its computer for the full events — only
  // while the tab is not live on the direct link (docs/direct-link.md).
  const hubStream = useSubscription(
    trpc.chat.onEvent.subscriptionOptions(opts.tabId ? { tabIds: [opts.tabId] } : undefined, {
      enabled: !!opts.tabId && !directLive,
      // Each (re)start — a reconnect drops what was sent meanwhile — catches up.
      onStarted: hubStreamStarted,
      onData: handleEvent
    })
  )
  // The same events straight from the computer while linked. The seq / live
  // counters drop what the hub stream also delivers.
  useEffect(() => {
    if (!directChat || !opts.tabId) return
    const tabId = opts.tabId
    noteDirectChatLink(tabId, true)
    const sub = directChat.client.chat.onEvent.subscribe(
      { tabId },
      {
        onStarted: () => setDirectStartedFor(directChat),
        onData: (event) => {
          noteDirectChatEvent()
          handleEvent(event)
        },
        onError: directChatLost,
        onComplete: directChatLost
      }
    )
    return () => {
      noteDirectChatLink(tabId, false)
      sub.unsubscribe()
    }
  }, [directChat, directChatLost, handleEvent, opts.tabId])

  // Stable (reads refs: fragments still waiting for their frame go first).
  const handleExit = useStableCallback(
    ({
      tabId,
      sessionId,
      code,
      signal
    }: {
      tabId: string
      sessionId: string
      code: number | null
      signal: string | null
    }) => {
      if (tabId !== opts.tabId) return
      flushLive()
      dispatch({ type: 'process-exit', sessionId, code, signal })
    }
  )
  useSubscription(
    trpc.chat.onExit.subscriptionOptions(undefined, {
      enabled: !!opts.tabId,
      onData: handleExit
    })
  )

  // Loading = no load has finished for the CURRENT inputs. Derived during render
  // (not set in the effect) so the first frame for new inputs already shows it.
  // Any input change clears the finished marker, so switching away and back still
  // waits for the new load; a stale load can't set it (genRef gate).
  const loadInputs = {
    tabId: opts.tabId,
    taskId: opts.taskId,
    mode: opts.mode,
    cwd: opts.cwd,
    providerFlagsOverride: opts.providerFlagsOverride ?? null,
    trpcClient
  }
  const [seenInputs, setSeenInputs] = useState(loadInputs)
  const [loadedInputs, setLoadedInputs] = useState<typeof loadInputs | null>(null)
  const reload = useCallback(() => {
    setLoadedInputs(null)
    setReopenToken((n) => n + 1)
  }, [])
  // The hub socket reopened: a load that failed — in flight when the socket closed
  // (sleep/wake, a hub freeze), or queued past the connect deadline — can succeed
  // now. Without this the chat stayed "Couldn't open" until Retry. Nothing failed:
  // the hub stream's restart catches up instead (`hubStreamStarted`).
  useHubReopen(() => {
    const failed = loadFailedRef.current
    if (failed.load || failed.hydrate) reload()
  })
  const hubReconnecting = useScopedHubConnection()?.status === 'connecting'
  // Read what this panel missed — the saved events after its newest and what
  // streams now, the server's current turn status with it — without a reload:
  // on every (re)start of the hub stream (a reconnect) and when a live event
  // shows a gap. What streams meanwhile waits, as during a load. A server behind
  // this panel (its log restarted, or it lost the tab) needs the full reload.
  const catchingUpRef = useRef(false)
  const [resyncing, setResyncing] = useState(false)
  const catchUp = useStableCallback((shown: boolean) => {
    // A load runs: it reads what is new itself.
    if (!opts.tabId || !hydratedRef.current || catchingUpRef.current) return
    const gen = genRef.current
    const tabId = opts.tabId
    const position = positionRef.current
    catchingUpRef.current = true
    if (shown) setResyncing(true)
    hydratedRef.current = false
    readReplayPages({ getReplay: getReplayRead }, tabId, position.seq, () => gen !== genRef.current)
      .then((replay) => {
        if (!replay || gen !== genRef.current) return
        if (position.catchUpNeedsReload(replay.live)) {
          reload()
          return
        }
        applySaved(replay.events as Array<{ seq: number; event: AgentEvent; at?: number }>)
        applySnapshot(replay.live.events as AgentEvent[], replay.live.afterSeq, replay.live.liveSeq)
      })
      // Unreadable now: the availability check reloads a tab it cannot read.
      .catch(() => undefined)
      .finally(() => {
        catchingUpRef.current = false
        setResyncing(false)
        if (gen !== genRef.current) return
        hydratedRef.current = true
        const queued = liveQueueRef.current
        liveQueueRef.current = []
        for (const { event, seq, live, at } of queued) applyLive(event, seq, live, at)
        flushLive()
      })
  })
  useEffect(() => {
    resyncRef.current = catchUp
  }, [catchUp])
  // Back from the direct link to the hub: events saved between the end of the
  // direct stream and the hub's first relayed one are not on either stream, so load
  // the tab again (rare: the link dropped). Going direct needs nothing: the hub stream
  // stops only once the direct one has started (`directLive`).
  const wasDirectRef = useRef(false)
  useEffect(() => {
    if (directChat) {
      wasDirectRef.current = true
      return
    }
    if (!wasDirectRef.current) return
    wasDirectRef.current = false
    reload()
  }, [directChat, reload])

  const inputsChanged = (a: typeof loadInputs, b: typeof loadInputs): boolean =>
    a.tabId !== b.tabId ||
    a.taskId !== b.taskId ||
    a.mode !== b.mode ||
    a.cwd !== b.cwd ||
    a.providerFlagsOverride !== b.providerFlagsOverride ||
    a.trpcClient !== b.trpcClient
  if (inputsChanged(seenInputs, loadInputs)) {
    setSeenInputs(loadInputs)
    setLoadedInputs(null)
  }
  const hydrating = loadedInputs === null || inputsChanged(loadedInputs, loadInputs)
  // The hub stream is reconnecting (the direct link, while live, has its own loss
  // handling: a reload).
  const streamDown = !!opts.tabId && !directLive && hubStream.status === 'connecting'
  useEffect(() => {
    if (streamDown && !hydrating) streamDroppedRef.current = true
  }, [streamDown, hydrating])

  useEffect(() => {
    const gen = ++genRef.current
    hydratedRef.current = false
    liveQueueRef.current = []
    const targetKey = JSON.stringify([opts.tabId, opts.taskId, opts.mode])
    const sameTarget = loadedTargetRef.current === null || loadedTargetRef.current === targetKey
    keepLocalRef.current = sameTarget
      ? stateRef.current.timeline.filter(
          (it): it is Extract<TimelineItem, { kind: 'user-text' }> =>
            it?.kind === 'user-text' &&
            !!it.id &&
            (it.optimistic === true || it.delivery === 'failed')
        )
      : []
    loadedTargetRef.current = targetKey
    if (loadedOnceRef.current || !sameTarget) localActionsRef.current = []
    discardPendingLive()
    positionRef.current.reset()
    const inputs = {
      tabId: opts.tabId,
      taskId: opts.taskId,
      mode: opts.mode,
      cwd: opts.cwd,
      providerFlagsOverride: opts.providerFlagsOverride ?? null,
      trpcClient
    }

    const timer = createChatOpenTimer()
    const queuedMs = restoreQueuedMs()
    if (queuedMs !== null) timer.set('queuedMs', queuedMs)
    let cancelPaintTiming: (() => void) | undefined
    const work = hydrateAndReplay({
      trpcClient,
      reads: { openTimeline: openTimelineRead, getReplay: getReplayRead },
      historyDisplay,
      target: {
        tabId: opts.tabId,
        taskId: opts.taskId,
        mode: opts.mode,
        cwd: opts.cwd,
        providerFlagsOverride: opts.providerFlagsOverride ?? null
      },
      gen,
      genRef,
      sessionReady,
      hydratedRef,
      loadedOnceRef,
      liveQueueRef,
      applyLive,
      applySaved,
      flushLive,
      applySnapshot,
      openPaged,
      openFull,
      dispatch,
      restoreLocal,
      onError: noteLoadError,
      onHydrateError: noteHydrateError,
      onHydrated: () => setLoadedInputs(inputs),
      timer,
      viaDirect: readsViaDirect,
      report: () => {
        cancelPaintTiming = afterNextPaint(() => {
          timer.mark('paintedMs')
          reportChatOpenTiming(
            trpcClient,
            { taskId: opts.taskId, tabId: opts.tabId, mode: opts.mode, client: 'desktop' },
            timer
          )
        })
      }
    })
    void (trackHistory ? trackHistory(work) : work)

    return () => {
      // Bump the generation so the subscriptions + any in-flight async work for
      // this session become no-ops (matches the old `cancelled = true`).
      genRef.current = gen + 1
      cancelPaintTiming?.()
    }
  }, [
    trackHistory,
    opts.tabId,
    opts.taskId,
    opts.mode,
    opts.cwd,
    opts.providerFlagsOverride,
    applyLive,
    applySaved,
    flushLive,
    discardPendingLive,
    applySnapshot,
    openPaged,
    openFull,
    restoreLocal,
    trpcClient,
    reopenToken,
    openTimelineRead,
    getReplayRead,
    readsViaDirect,
    historyDisplay,
    restoreQueuedMs,
    sessionReady,
    noteLoadError,
    noteHydrateError
  ])

  const createOpts = (): {
    tabId: string
    taskId: string
    mode: string
    cwd: string
    providerFlagsOverride: string | null
  } => ({
    tabId: opts.tabId,
    taskId: opts.taskId,
    mode: opts.mode,
    cwd: opts.cwd,
    providerFlagsOverride: opts.providerFlagsOverride ?? null
  })

  // Stable ref so consumers (autocomplete `sources` useMemo, ChatPanel chatApi)
  // don't reinitialize on every parent render. dispatch is stable from useReducer.
  const sendMessage = useCallback(
    async (input: string | UserContentBlock[], sendOpts?: SendMessageOptions): Promise<void> => {
      const content: UserContentBlock[] =
        typeof input === 'string' ? [{ type: 'text', text: input }] : input
      // The client mints the id: the optimistic bubble, the server's
      // `user-message`, its delivery states and the CLI's message `uuid` all
      // carry it — and re-sending it can never deliver it twice.
      const id = sendOpts?.id ?? safeRandomUUID()
      // Optimistic: paint the user-text immediately so the UI doesn't lag the
      // roundtrip. Main still emits the canonical `user-message` event and the
      // reducer confirms it in place by id — single source of truth for replay.
      // `user-sent` is renderer-only; never persisted.
      dispatchLocal({ type: 'user-sent', id, text: userMessageText(content), content })
      try {
        await sessionReady.ready()
        await trpcClient.chat.send.mutate({
          tabId: opts.tabId,
          message: { id, content },
          operationId: safeRandomUUID()
        })
      } catch (err) {
        dispatchLocal({
          type: 'user-send-failed',
          id,
          error: err instanceof Error ? err.message : String(err)
        })
        throw err
      }
    },
    [opts.tabId, trpcClient, dispatchLocal, sessionReady]
  )

  // Read the failed message's text from the reducer; `state` is read via a
  // stable callback so this stays stable for renderers.
  const retryMessage = useStableCallback(async (id: string): Promise<void> => {
    // The message's row (by id; it is the newest one — the one Retry is on).
    const rows = state.userIndex.get(id)
    const item = rows ? state.timeline[rows[rows.length - 1]] : undefined
    if (!item || item.kind !== 'user-text') return
    dispatchLocal({ type: 'user-retry', id })
    // The whole message, files included (attachments first, as it was sent).
    const content: UserContentBlock[] = [
      ...(item.attachments ?? []).map((attachment) => ({
        type: 'attachment' as const,
        attachment
      })),
      ...(item.text ? [{ type: 'text' as const, text: item.text }] : [])
    ]
    try {
      await sessionReady.ready()
      // Same id: the server retries it (or takes it, if it never got it).
      await trpcClient.chat.send.mutate({
        tabId: opts.tabId,
        message: { id, content },
        operationId: safeRandomUUID()
      })
    } catch (err) {
      dispatchLocal({
        type: 'user-send-failed',
        id,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })

  const sendToolResult = async (args: {
    toolUseId: string
    content: string
    isError?: boolean
  }): Promise<boolean> => {
    return chatIo.sendToolResult({ tabId: opts.tabId, args })
  }

  const respondPermission = async (args: {
    requestId: string
    decision: PermissionDecision
    optionId?: string
  }): Promise<boolean> => {
    const { requestId } = args
    if (submittingRef.current.has(requestId)) return false
    submittingRef.current.add(requestId)
    setSubmittingPrompts(new Set(submittingRef.current))
    const settle = (): void => {
      submittingRef.current.delete(requestId)
      setSubmittingPrompts(new Set(submittingRef.current))
    }
    // The prompt flips to answered when the server's `permission-resolved`
    // event lands — no optimistic state to undo. A refusal means the request
    // is no longer pending server-side.
    return chatIo.respondPermission({ tabId: opts.tabId, args }).then(
      (ok) => {
        settle()
        if (!ok) dispatch({ type: 'prompt-refused', requestId })
        return ok
      },
      (err: unknown) => {
        settle()
        throw err
      }
    )
  }

  const interrupt = async (): Promise<void> => {
    // Main records an `interrupted` event into the session buffer before kill+respawn;
    // the broadcast flows back via `chat:event` and the reducer appends the timeline
    // marker. Single source of truth → replay sees the same boundary.
    await trpcClient.chat.interrupt.mutate(createOpts())
  }

  const abortAndPop = async (): Promise<StopResult> => {
    // Main is authoritative: walks its own buffer to decide pop vs marker. The
    // synthetic event (`user-message-popped` or `interrupted`) flows back via
    // `chat:event`; reducer mutates the timeline. Return value tells the caller
    // whether to restore the popped text to the chat input field.
    return trpcClient.chat.abortAndPop.mutate(createOpts())
  }

  const kill = async (): Promise<void> => {
    await trpcClient.chat.kill.mutate({ tabId: opts.tabId })
  }

  const takeOver = async (): Promise<void> => {
    await trpcClient.chat.takeOver.mutate(createOpts())
  }

  // The marker (`conversation-branch`) and any notice arrive as events; these
  // return only what the caller acts on (the dry run, the text to edit).
  const rewindPreview = (messageId: string, scope: RewindScope): Promise<RewindFilesPreview> =>
    trpcClient.chat.rewindPreview.mutate({ ...createOpts(), messageId, scope })

  const rewind = (args: {
    messageId: string
    scope: RewindScope
    conversation: boolean
    files: boolean
  }): Promise<RewindResult> => trpcClient.chat.rewind.mutate({ ...createOpts(), ...args })

  const fork = (messageId: string): Promise<void> =>
    trpcClient.chat.fork.mutate({ ...createOpts(), messageId }).then(() => undefined)

  const reset = (): void => {
    discardPendingLive()
    dispatch({ type: 'reset' })
    positionRef.current.reset()
  }

  return {
    state,
    readBlob,
    readToolDetail,
    readTextDetail,
    timeline: state.timeline,
    // A user's turn, or one the agent started by itself (TUI parity).
    inFlight: isTurnOpen(state),
    hydrating,
    /**
     * Loaded, but not in step with the server right now: its stream is
     * reconnecting, or catching up with what it missed. The turn state shown is
     * the last known one, not the server's.
     */
    reconnecting: !hydrating && (streamDown || resyncing),
    hubReconnecting,
    loadError,
    hydrateError,
    reload,
    paging,
    loadPages,
    unloadPages,
    searchPages,
    permissionMode: state.permissionMode,
    prompts: state.prompts,
    submittingPrompts,
    sendMessage,
    subscribeEvents,
    retryMessage,
    sendToolResult,
    respondPermission,
    interrupt,
    abortAndPop,
    kill,
    takeOver,
    rewindPreview,
    rewind,
    fork,
    reset
  }
}
