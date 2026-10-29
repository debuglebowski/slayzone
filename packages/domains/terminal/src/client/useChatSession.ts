import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type RefObject
} from 'react'
import { useSubscription } from '@slayzone/transport/client'
import { useTRPC, useTRPCClient } from './trpc'
import { useStableCallback } from '@slayzone/ui'
import type { AgentEvent, PermissionDecision } from '@slayzone/terminal-contracts'
import type { ChatPrompt } from './chat-prompts'
import {
  initialState,
  reducer,
  type Action as ChatTimelineAction,
  isInFlight,
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
  sendMessage: (text: string) => Promise<void>
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
   * marker — Claude CLI parity. Returns `popped: true` + the cancelled text so
   * the caller can restore it to the chat input field.
   */
  abortAndPop: () => Promise<{ popped: boolean; text: string | null }>
  kill: () => Promise<void>
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
  liveQueueRef: RefObject<Array<{ event: AgentEvent; seq: number }>>
  applyLive: (event: AgentEvent, seq: number) => void
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
    const buffered = await trpcClient.chat.getBufferSince.query({
      tabId: target.tabId,
      afterSeq: -1
    })
    if (gen !== genRef.current) return
    if (loadedOnceRef.current) dispatch({ type: 'reset' })
    // Replay through applyLive so the seq dedup applies. Prompt state is part
    // of the reducer, so a pending prompt comes back from the replay.
    for (const { seq, event } of buffered) applyLive(event as AgentEvent, seq)
  } catch {
    /* ignore replay failures */
  } finally {
    if (gen === genRef.current) {
      // Drain live events queued during hydration. Dedup via lastSeqRef
      // so anything already covered by the replay buffer is skipped.
      hydratedRef.current = true
      loadedOnceRef.current = true
      for (const { event, seq } of liveQueueRef.current) applyLive(event, seq)
      liveQueueRef.current = []
      onHydrated()
    }
  }
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
  const [state, dispatch] = useReducer(reducer, undefined, initialState)
  const lastSeqRef = useRef<number>(-1)
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
  const liveQueueRef = useRef<Array<{ event: AgentEvent; seq: number }>>([])

  // Stable: only reads refs + stable setters. Applies one event to the reducer.
  const applyLive = useCallback((event: AgentEvent, seq: number): void => {
    if (seq <= lastSeqRef.current) return
    lastSeqRef.current = seq
    dispatch({ type: 'event', event })
  }, [])

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
    ({ tabId, event, seq }: { tabId: string; event: unknown; seq: number }) => {
      if (tabId !== opts.tabId) return
      if (!hydratedRef.current) {
        liveQueueRef.current.push({ event: event as AgentEvent, seq })
        return
      }
      applyLive(event as AgentEvent, seq)
    }
  )
  useSubscription(
    trpc.chat.onEvent.subscriptionOptions(undefined, {
      enabled: !!opts.tabId,
      onData: handleEvent
    })
  )

  useSubscription(
    trpc.chat.onExit.subscriptionOptions(undefined, {
      enabled: !!opts.tabId,
      onData: ({ tabId, sessionId, code, signal }) => {
        if (tabId !== opts.tabId) return
        dispatch({ type: 'process-exit', sessionId, code, signal })
      }
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
    lastSeqRef.current = -1
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
    async (text: string): Promise<void> => {
      // Optimistic: paint the user-text immediately so the UI doesn't lag the
      // roundtrip. Main still emits the canonical `user-message` event and the
      // reducer confirms-in-place (FIFO) when it arrives — single source of truth
      // for replay. `user-sent` is renderer-only; never persisted.
      dispatch({ type: 'user-sent', text })
      try {
        const ok = await trpcClient.chat.send.mutate({ tabId: opts.tabId, text })
        if (!ok) dispatch({ type: 'user-send-failed' })
      } catch (err) {
        dispatch({ type: 'user-send-failed' })
        throw err
      }
    },
    [opts.tabId, trpcClient]
  )

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

  const abortAndPop = async (): Promise<{ popped: boolean; text: string | null }> => {
    // Main is authoritative: walks its own buffer to decide pop vs marker. The
    // synthetic event (`user-message-popped` or `interrupted`) flows back via
    // `chat:event`; reducer mutates the timeline. Return value tells the caller
    // whether to restore the popped text to the chat input field.
    return trpcClient.chat.abortAndPop.mutate(createOpts())
  }

  const kill = async (): Promise<void> => {
    await trpcClient.chat.kill.mutate({ tabId: opts.tabId })
  }

  const reset = (): void => {
    dispatch({ type: 'reset' })
    lastSeqRef.current = -1
  }

  return {
    state,
    timeline: state.timeline,
    inFlight: isInFlight(state),
    hydrating,
    permissionMode: state.permissionMode,
    prompts: state.prompts,
    submittingPrompts,
    sendMessage,
    sendToolResult,
    respondPermission,
    interrupt,
    abortAndPop,
    kill,
    reset
  }
}
