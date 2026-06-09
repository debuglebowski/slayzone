import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useSubscription, useTRPC, useTRPCClient } from '@slayzone/transport/client'
import type { AgentEvent } from '../shared/agent-events'
import {
  initialState,
  reducer,
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
   * Live `can_use_tool` permission requests from the CLI, keyed by
   * `tool_use_id` (one per pending tool). Populated when the adapter is run
   * with `--permission-prompt-tool stdio` and Claude calls a tool the active
   * permission mode hasn't already auto-approved (notably AskUserQuestion).
   * Renderers correlate by `tool_use_id` from the on-screen tool card and
   * resolve via `respondPermission`. Cleared automatically when the
   * matching `tool-result` arrives (or on session exit).
   */
  permissionRequests: Map<string, { requestId: string; toolName: string; input: unknown }>
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
   * Reply to an inbound permission_request. `decision.behavior:'allow'` carries
   * `updatedInput` (e.g. AskUserQuestion answers) — the CLI runs the tool
   * with that mutated input. `behavior:'deny'` blocks the tool.
   */
  respondPermission: (args: {
    requestId: string
    decision:
      | {
          behavior: 'allow'
          updatedInput?: Record<string, unknown>
          updatedPermissions?: unknown[]
        }
      | { behavior: 'deny'; message: string; interrupt?: boolean }
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
  const [hydrating, setHydrating] = useState(true)
  const lastSeqRef = useRef<number>(-1)
  const [permissionRequests, setPermissionRequests] = useState<
    Map<string, { requestId: string; toolName: string; input: unknown }>
  >(() => new Map())

  // Per-(re)hydration mutable state shared between the always-on subscriptions
  // and the hydrate effect. `genRef` is the staleness token (replaces the old
  // `cancelled` flag): each hydrate run bumps it; subscription callbacks + async
  // continuations compare against it so a tab/opts change cleanly ignores
  // in-flight work from the previous session. `hydratedRef` gates the queue
  // (queue events until the buffer replay completes), `liveQueueRef` holds them.
  const genRef = useRef(0)
  const hydratedRef = useRef(false)
  const liveQueueRef = useRef<Array<{ event: AgentEvent; seq: number }>>([])

  // Stable: only reads refs + stable setters. Applies one event to the reducer
  // and maintains the permission-request side-channel.
  const applyLive = useCallback((event: AgentEvent, seq: number): void => {
    if (seq <= lastSeqRef.current) return
    lastSeqRef.current = seq
    dispatch({ type: 'event', event })

    // Side-channel: track inbound permission requests so renderers can
    // resolve them (e.g. AskUserQuestion answers). Drop them when the
    // originating tool resolves (its tool_result lands) — keyed by
    // tool_use_id so reload-after-answer doesn't resurface a stale prompt.
    if (event.kind === 'permission-request') {
      setPermissionRequests((prev) => {
        const next = new Map(prev)
        next.set(event.toolUseId, {
          requestId: event.requestId,
          toolName: event.toolName,
          input: event.input
        })
        return next
      })
    } else if (event.kind === 'tool-result') {
      setPermissionRequests((prev) => {
        if (!prev.has(event.toolUseId)) return prev
        const next = new Map(prev)
        next.delete(event.toolUseId)
        return next
      })
    }
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
  useSubscription(
    trpc.chat.onEvent.subscriptionOptions(undefined, {
      enabled: !!opts.tabId,
      onData: ({ tabId, event, seq }) => {
        if (tabId !== opts.tabId) return
        if (!hydratedRef.current) {
          liveQueueRef.current.push({ event: event as AgentEvent, seq })
          return
        }
        applyLive(event as AgentEvent, seq)
      }
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

  useEffect(() => {
    const gen = ++genRef.current
    hydratedRef.current = false
    liveQueueRef.current = []
    lastSeqRef.current = -1
    setHydrating(true)

    // Serialize: AWAIT hydrate, THEN replay. Hydrate inserts the session
    // skeleton into the main-side sessions map (seeded with persisted history)
    // synchronously enough for getBufferSince to return real data. Awaiting
    // guarantees session.buffer is seeded with persisted history.
    void (async () => {
      try {
        await trpcClient.chat.hydrate.mutate({
          tabId: opts.tabId,
          taskId: opts.taskId,
          mode: opts.mode,
          cwd: opts.cwd,
          providerFlagsOverride: opts.providerFlagsOverride ?? null
        })
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
          tabId: opts.tabId,
          afterSeq: -1
        })
        if (gen !== genRef.current) return
        // Route replay through applyLive (not raw dispatch) so side-channel
        // state — notably `permissionRequests` for unresolved AskUserQuestion
        // prompts — repopulates on tab reattach. Without this, hydrating a tab
        // with a pending perm-request leaves the Map empty; Submit can't find
        // the prompt → falls back to `sendMessage`, but the CLI is still
        // blocked waiting on `control_response` and never responds.
        for (const { seq, event } of buffered) applyLive(event as AgentEvent, seq)
      } catch {
        /* ignore replay failures */
      } finally {
        if (gen === genRef.current) {
          // Drain live events queued during hydration. Dedup via lastSeqRef
          // so anything already covered by the replay buffer is skipped.
          hydratedRef.current = true
          for (const { event, seq } of liveQueueRef.current) applyLive(event, seq)
          liveQueueRef.current = []
          setHydrating(false)
        }
      }
    })()

    return () => {
      // Bump the generation so the subscriptions + any in-flight async work for
      // this session become no-ops (matches the old `cancelled = true`).
      genRef.current++
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
    decision:
      | {
          behavior: 'allow'
          updatedInput?: Record<string, unknown>
          updatedPermissions?: unknown[]
        }
      | { behavior: 'deny'; message: string; interrupt?: boolean }
  }): Promise<boolean> => {
    // Optimistic local clear so the renderer un-mounts the prompt UI as soon
    // as the user clicks. The CLI's tool_result will follow shortly and
    // confirm; the buffer-replay path also drops it via the tool-result
    // listener above.
    setPermissionRequests((prev) => {
      let next: Map<string, { requestId: string; toolName: string; input: unknown }> | null = null
      for (const [toolUseId, req] of prev) {
        if (req.requestId !== args.requestId) continue
        if (next === null) next = new Map(prev)
        next.delete(toolUseId)
      }
      return next ?? prev
    })
    return trpcClient.chat.respondPermission.mutate({ tabId: opts.tabId, args })
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
    permissionRequests,
    sendMessage,
    sendToolResult,
    respondPermission,
    interrupt,
    abortAndPop,
    kill,
    reset
  }
}
