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
import { useSubscription } from '@slayzone/transport/client'
import { useTRPC, useTRPCClient } from './trpc'
import { safeRandomUUID, useStableCallback } from '@slayzone/ui'
import type {
  AgentEvent,
  PermissionDecision,
  RewindFilesPreview,
  RewindResult,
  RewindScope,
  StopResult,
  UserContentBlock
} from '@slayzone/terminal-contracts'
import { chatCapabilitiesForMode, userMessageText } from '@slayzone/terminal-contracts'
import type { ChatPrompt } from './chat-prompts'
import {
  initialState,
  reducer,
  type Action as ChatTimelineAction,
  isTurnOpen,
  type ChatTimelineState,
  type TimelineItem
} from './chat-timeline'

export interface UseChatSessionResult {
  state: ChatTimelineState
  timeline: TimelineItem[]
  inFlight: boolean
  /** True until the initial buffer replay resolves (on mount / tab reopen). */
  hydrating: boolean
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
  sendMessage: (input: string | UserContentBlock[]) => Promise<void>
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

export interface UseChatSessionOpts {
  tabId: string
  taskId: string
  mode: string
  cwd: string
  /** Optional override. Defaults to falling back to task mode defaults on the main side. */
  providerFlagsOverride?: string | null
}

interface HydrateChatCtx {
  trpcClient: ReturnType<typeof useTRPCClient>
  target: {
    tabId: string
    taskId: string
    mode: string
    cwd: string
    providerFlagsOverride: string | null
  }
  gen: number
  genRef: RefObject<number>
  hydratedRef: RefObject<boolean>
  /** True once any load of this hook finished — the next one is a reload. */
  loadedOnceRef: RefObject<boolean>
  liveQueueRef: RefObject<Array<{ event: AgentEvent; seq: number; live?: number }>>
  applyLive: (event: AgentEvent, seq: number, live?: number) => void
  /** Apply saved events (seq order) as ONE reducer batch. */
  applySaved: (saved: ReadonlyArray<{ seq: number; event: AgentEvent }>) => void
  /** Apply the stream fragments waiting for the next frame now. */
  flushLive: () => void
  /** Adopt a replay's live snapshot (blocks still streaming) at its live counter. */
  applySnapshot: (events: AgentEvent[], afterSeq: number, liveSeq: number) => void
  dispatch: Dispatch<ChatTimelineAction>
  onHydrated: () => void
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
  target,
  gen,
  genRef,
  hydratedRef,
  loadedOnceRef,
  liveQueueRef,
  applyLive,
  applySaved,
  flushLive,
  applySnapshot,
  dispatch,
  onHydrated
}: HydrateChatCtx): Promise<void> {
  try {
    await trpcClient.chat.hydrate.mutate(target)
  } catch (e) {
    // Surface hydrate failure but still attempt replay (e.g. session may
    // exist from a previous reattach despite this hydrate rejecting).
    dispatch({
      type: 'event',
      event: { kind: 'error', message: (e as Error).message ?? String(e) }
    })
  }
  if (gen !== genRef.current) return
  try {
    // Saved history + what is streaming right now, in one snapshot.
    const replay = await trpcClient.chat.getReplay.query({
      tabId: target.tabId,
      afterSeq: -1
    })
    if (gen !== genRef.current) return
    if (loadedOnceRef.current) dispatch({ type: 'reset' })
    // The whole history in ONE reducer batch (one render, linear time), with the
    // seq dedup every saved event gets. Prompt state is part of the reducer, so
    // a pending prompt comes back from the replay.
    applySaved(replay.events as Array<{ seq: number; event: AgentEvent }>)
    // A reply mid-stream: its fragments are live-only (never saved) — redraw them.
    applySnapshot(replay.live.events as AgentEvent[], replay.live.afterSeq, replay.live.liveSeq)
  } catch {
    /* ignore replay failures */
  } finally {
    if (gen === genRef.current) {
      // Drain live events queued during hydration. Dedup via lastSeqRef
      // so anything already covered by the replay buffer is skipped.
      hydratedRef.current = true
      loadedOnceRef.current = true
      for (const { event, seq, live } of liveQueueRef.current) applyLive(event, seq, live)
      liveQueueRef.current = []
      // The loaded state is complete at once, not a frame later.
      flushLive()
      onHydrated()
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
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
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
  const lastSeqRef = useRef<number>(-1)
  // Newest live event applied (live events carry their own counter; see applyLive).
  const lastLiveRef = useRef<number>(0)
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
  const hydratedRef = useRef(false)
  const loadedOnceRef = useRef(false)
  const liveQueueRef = useRef<Array<{ event: AgentEvent; seq: number; live?: number }>>([])

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
  // Otherwise it is stale (the saved event it led to is already applied).
  const applyLive = useCallback(
    (event: AgentEvent, seq: number, live?: number): void => {
      if (live !== undefined) {
        if (seq !== lastSeqRef.current || live <= lastLiveRef.current) return
        lastLiveRef.current = live
        pendingLiveRef.current.push(event)
        if (frameRef.current === null) {
          frameRef.current = requestFrame(() => {
            frameRef.current = null
            flushLive()
          })
        }
        return
      }
      if (seq <= lastSeqRef.current) return
      lastSeqRef.current = seq
      flushLive()
      dispatch({ type: 'event', event })
    },
    [flushLive]
  )
  // Stable: refs + dispatch only. Saved events in seq order as one batch — the
  // same as applying each through `applyLive` (fragments waiting for a frame
  // still go first), in one reducer call and one render.
  const applySaved = useCallback(
    (saved: ReadonlyArray<{ seq: number; event: AgentEvent }>): void => {
      const events: AgentEvent[] = []
      for (const { seq, event } of saved) {
        if (seq <= lastSeqRef.current) continue
        lastSeqRef.current = seq
        events.push(event)
      }
      if (events.length === 0) return
      flushLive()
      dispatch({ type: 'events', events })
    },
    [flushLive]
  )
  useEffect(() => discardPendingLive, [discardPendingLive])

  // Subscribe (always-on; mounted on first render, BEFORE the hydrate effect
  // runs) so we don't miss events emitted between session spawn and the
  // getBufferSince replay below. While hydrating, queue events instead of
  // dispatching — `session-spawn` (and other events from the fresh subprocess)
  // can race ahead of getBufferSince, advance lastSeqRef, and make the replay
  // loop's `seq > lastSeqRef` filter drop the entire historical buffer. Drained
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
      live
    }: {
      tabId: string
      event: unknown
      seq: number
      live?: number
    }) => {
      if (tabId !== opts.tabId) return
      if (!hydratedRef.current) {
        liveQueueRef.current.push({ event: event as AgentEvent, seq, live })
        return
      }
      applyLive(event as AgentEvent, seq, live)
    }
  )
  // Stable: refs + dispatch only.
  const applySnapshot = useCallback(
    (events: AgentEvent[], afterSeq: number, liveSeq: number): void => {
      if (afterSeq !== lastSeqRef.current) return
      lastLiveRef.current = Math.max(lastLiveRef.current, liveSeq)
      if (events.length > 0) dispatch({ type: 'events', events })
    },
    []
  )
  useSubscription(
    trpc.chat.onEvent.subscriptionOptions(undefined, {
      enabled: !!opts.tabId,
      onData: handleEvent
    })
  )

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

  useEffect(() => {
    const gen = ++genRef.current
    hydratedRef.current = false
    liveQueueRef.current = []
    discardPendingLive()
    lastSeqRef.current = -1
    lastLiveRef.current = 0
    const inputs = {
      tabId: opts.tabId,
      taskId: opts.taskId,
      mode: opts.mode,
      cwd: opts.cwd,
      providerFlagsOverride: opts.providerFlagsOverride ?? null,
      trpcClient
    }

    void hydrateAndReplay({
      trpcClient,
      target: {
        tabId: opts.tabId,
        taskId: opts.taskId,
        mode: opts.mode,
        cwd: opts.cwd,
        providerFlagsOverride: opts.providerFlagsOverride ?? null
      },
      gen,
      genRef,
      hydratedRef,
      loadedOnceRef,
      liveQueueRef,
      applyLive,
      applySaved,
      flushLive,
      applySnapshot,
      dispatch,
      onHydrated: () => setLoadedInputs(inputs)
    })

    return () => {
      // Bump the generation so the subscriptions + any in-flight async work for
      // this session become no-ops (matches the old `cancelled = true`).
      genRef.current = gen + 1
    }
  }, [
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
    trpcClient
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
    async (input: string | UserContentBlock[]): Promise<void> => {
      const content: UserContentBlock[] =
        typeof input === 'string' ? [{ type: 'text', text: input }] : input
      // The client mints the id: the optimistic bubble, the server's
      // `user-message`, its delivery states and the CLI's message `uuid` all
      // carry it — and re-sending it can never deliver it twice.
      const id = safeRandomUUID()
      // Optimistic: paint the user-text immediately so the UI doesn't lag the
      // roundtrip. Main still emits the canonical `user-message` event and the
      // reducer confirms it in place by id — single source of truth for replay.
      // `user-sent` is renderer-only; never persisted.
      dispatch({ type: 'user-sent', id, text: userMessageText(content), content })
      try {
        await trpcClient.chat.send.mutate({ tabId: opts.tabId, message: { id, content } })
      } catch (err) {
        dispatch({
          type: 'user-send-failed',
          id,
          error: err instanceof Error ? err.message : String(err)
        })
        throw err
      }
    },
    [opts.tabId, trpcClient]
  )

  // Read the failed message's text from the reducer; `state` is read via a
  // stable callback so this stays stable for renderers.
  const retryMessage = useStableCallback(async (id: string): Promise<void> => {
    const item = state.timeline.find((it) => it.kind === 'user-text' && it.id === id)
    if (!item || item.kind !== 'user-text') return
    dispatch({ type: 'user-retry', id })
    // The whole message, files included (attachments first, as it was sent).
    const content: UserContentBlock[] = [
      ...(item.attachments ?? []).map((attachment) => ({
        type: 'attachment' as const,
        attachment
      })),
      ...(item.text ? [{ type: 'text' as const, text: item.text }] : [])
    ]
    try {
      // Same id: the server retries it (or takes it, if it never got it).
      await trpcClient.chat.send.mutate({ tabId: opts.tabId, message: { id, content } })
    } catch (err) {
      dispatch({
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
    return trpcClient.chat.sendToolResult.mutate({ tabId: opts.tabId, args })
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
    return trpcClient.chat.respondPermission.mutate({ tabId: opts.tabId, args }).then(
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
    lastLiveRef.current = 0
    lastSeqRef.current = -1
  }

  return {
    state,
    timeline: state.timeline,
    // A user's turn, or one the agent started by itself (TUI parity).
    inFlight: isTurnOpen(state),
    hydrating,
    permissionMode: state.permissionMode,
    prompts: state.prompts,
    submittingPrompts,
    sendMessage,
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
