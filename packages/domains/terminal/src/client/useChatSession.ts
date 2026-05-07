import { useEffect, useReducer, useRef, useState } from 'react'
import type { AgentEvent } from '../shared/agent-events'
import {
  initialState,
  reducer,
  isInFlight,
  type ChatTimelineState,
  type TimelineItem,
} from './chat-timeline'

// We don't import ElectronAPI types here to avoid a cycle. The `chat` namespace shape
// is duplicated as a minimal interface; the real type lives in @slayzone/types/api.ts.
interface ChatApi {
  create: (opts: {
    tabId: string
    taskId: string
    mode: string
    cwd: string
    providerFlagsOverride?: string | null
  }) => Promise<unknown>
  reset: (opts: {
    tabId: string
    taskId: string
    mode: string
    cwd: string
    providerFlagsOverride?: string | null
  }) => Promise<unknown>
  send: (tabId: string, text: string) => Promise<boolean>
  sendToolResult: (
    tabId: string,
    args: { toolUseId: string; content: string; isError?: boolean }
  ) => Promise<boolean>
  respondPermission: (
    tabId: string,
    args: {
      requestId: string
      decision:
        | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
        | { behavior: 'deny'; message: string; interrupt?: boolean }
    }
  ) => Promise<boolean>
  interrupt: (opts: {
    tabId: string
    taskId: string
    mode: string
    cwd: string
    providerFlagsOverride?: string | null
  }) => Promise<unknown>
  abortAndPop: (opts: {
    tabId: string
    taskId: string
    mode: string
    cwd: string
    providerFlagsOverride?: string | null
  }) => Promise<{ popped: boolean; text: string | null }>
  kill: (tabId: string) => Promise<void>
  remove: (tabId: string) => Promise<void>
  getBufferSince: (
    tabId: string,
    afterSeq: number
  ) => Promise<Array<{ seq: number; event: AgentEvent }>>
  inspectPermissions: (
    taskId: string,
    mode: string
  ) => Promise<{
    ok: boolean
    hasSkipPerms: boolean
    hasPermissionMode: boolean
    permissionModeValue: string | null
  }>
  onEvent: (cb: (tabId: string, event: AgentEvent, seq: number) => void) => () => void
  onExit: (
    cb: (tabId: string, sessionId: string, code: number | null, signal: string | null) => void
  ) => () => void
}

function getChatApi(): ChatApi {
  // tRPC-backed shim — replaces window.api.chat after migration.
  // Imported lazily to avoid circular dep on terminal package.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getTrpcVanillaClient } = require('@slayzone/transport/client') as typeof import('@slayzone/transport/client')
  return {
    create: (opts) => getTrpcVanillaClient().chat.create.mutate(opts),
    reset: (opts) => getTrpcVanillaClient().chat.reset.mutate(opts),
    send: (tabId, text) => getTrpcVanillaClient().chat.send.mutate({ tabId, text }) as Promise<boolean>,
    sendToolResult: (tabId, args) => getTrpcVanillaClient().chat.sendToolResult.mutate({ tabId, args }) as Promise<boolean>,
    respondPermission: (tabId, args) => getTrpcVanillaClient().chat.respondPermission.mutate({ tabId, args }) as Promise<boolean>,
    interrupt: (opts) => getTrpcVanillaClient().chat.interrupt.mutate(opts),
    abortAndPop: (opts) => getTrpcVanillaClient().chat.abortAndPop.mutate(opts) as Promise<{ popped: boolean; text: string | null }>,
    kill: (tabId) => getTrpcVanillaClient().chat.kill.mutate({ tabId }) as Promise<void>,
    remove: (tabId) => getTrpcVanillaClient().chat.remove.mutate({ tabId }) as Promise<void>,
    getBufferSince: (tabId, afterSeq) => getTrpcVanillaClient().chat.getBufferSince.query({ tabId, afterSeq }) as Promise<Array<{ seq: number; event: AgentEvent }>>,
    inspectPermissions: (taskId, mode) => getTrpcVanillaClient().chat.inspectPermissions.query({ taskId, mode }) as Promise<{ ok: boolean; hasSkipPerms: boolean; hasPermissionMode: boolean; permissionModeValue: string | null }>,
    onEvent: (cb) => {
      const sub = getTrpcVanillaClient().chat.onEvent.subscribe(undefined, {
        onData: ({ tabId, event, seq }) => cb(tabId, event as AgentEvent, seq),
      })
      return () => sub.unsubscribe()
    },
    onExit: (cb) => {
      const sub = getTrpcVanillaClient().chat.onExit.subscribe(undefined, {
        onData: ({ tabId, sessionId, code, signal }) => cb(tabId, sessionId, code, signal),
      })
      return () => sub.unsubscribe()
    },
  }
}

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
  sendToolResult: (args: { toolUseId: string; content: string; isError?: boolean }) => Promise<boolean>
  /**
   * Reply to an inbound permission_request. `decision.behavior:'allow'` carries
   * `updatedInput` (e.g. AskUserQuestion answers) — the CLI runs the tool
   * with that mutated input. `behavior:'deny'` blocks the tool.
   */
  respondPermission: (args: {
    requestId: string
    decision:
      | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
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
 * 1. On mount: call chat:create (main process spawns or returns existing session).
 * 2. Subscribe to chat:event and chat:exit, filter by tabId, feed into reducer.
 * 3. Replay buffered events via getBufferSince(tabId, -1) so tab re-open sees prior state.
 * 4. On unmount: unsubscribe only. Session persists (main keeps buffer). Tab close triggers chat:remove via useTaskTerminals.
 */
export function useChatSession(opts: UseChatSessionOpts): UseChatSessionResult {
  const [state, dispatch] = useReducer(reducer, undefined, initialState)
  const [hydrating, setHydrating] = useState(true)
  const lastSeqRef = useRef<number>(-1)
  const [permissionRequests, setPermissionRequests] = useState<
    Map<string, { requestId: string; toolName: string; input: unknown }>
  >(() => new Map())

  useEffect(() => {
    let cancelled = false
    let hydrated = false
    const liveQueue: Array<{ event: AgentEvent; seq: number }> = []
    lastSeqRef.current = -1
    setHydrating(true)
    const chat = getChatApi()

    const applyLive = (event: AgentEvent, seq: number): void => {
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
            input: event.input,
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
    }

    // Subscribe BEFORE create so we don't miss events emitted between
    // session spawn and the getBufferSince call below. While hydrating,
    // queue events instead of dispatching — `session-spawn` (and other
    // events from the fresh subprocess) can race ahead of getBufferSince,
    // advance lastSeqRef, and make the replay loop's `seq > lastSeqRef`
    // filter drop the entire historical buffer. Drained after replay.
    const offEvent = chat.onEvent((tabId, event, seq) => {
      if (cancelled || tabId !== opts.tabId) return
      if (!hydrated) {
        liveQueue.push({ event, seq })
        return
      }
      applyLive(event, seq)
    })

    const offExit = chat.onExit((tabId, sessionId, code, signal) => {
      if (cancelled || tabId !== opts.tabId) return
      dispatch({ type: 'process-exit', sessionId, code, signal })
    })

    // Serialize: AWAIT create, THEN replay. The create handler awaits
    // whichBinary() before populating the in-memory session map, so a
    // parallel getBufferSince would race and return [] for cold reattach.
    // Awaiting guarantees session.buffer is seeded with persisted history.
    void (async () => {
      try {
        await chat.create({
          tabId: opts.tabId,
          taskId: opts.taskId,
          mode: opts.mode,
          cwd: opts.cwd,
          providerFlagsOverride: opts.providerFlagsOverride ?? null,
        })
      } catch (e) {
        // Surface create failure but still attempt replay (e.g. session may
        // exist from a previous reattach despite this create rejecting).
        dispatch({
          type: 'event',
          event: { kind: 'error', message: (e as Error).message ?? String(e) },
        })
      }
      if (cancelled) return
      try {
        const buffered = await chat.getBufferSince(opts.tabId, -1)
        if (cancelled) return
        for (const { seq, event } of buffered) {
          if (seq > lastSeqRef.current) {
            dispatch({ type: 'event', event })
            lastSeqRef.current = seq
          }
        }
      } catch {
        /* ignore replay failures */
      } finally {
        if (!cancelled) {
          // Drain live events queued during hydration. Dedup via lastSeqRef
          // so anything already covered by the replay buffer is skipped.
          hydrated = true
          for (const { event, seq } of liveQueue) applyLive(event, seq)
          liveQueue.length = 0
          setHydrating(false)
        }
      }
    })()

    return () => {
      cancelled = true
      offEvent()
      offExit()
    }
  }, [opts.tabId, opts.taskId, opts.mode, opts.cwd, opts.providerFlagsOverride])

  const sendMessage = async (text: string): Promise<void> => {
    const chat = getChatApi()
    // Optimistic: paint the user-text immediately so the UI doesn't lag the IPC
    // roundtrip. Main still emits the canonical `user-message` event and the
    // reducer confirms-in-place (FIFO) when it arrives — single source of truth
    // for replay. `user-sent` is renderer-only; never persisted.
    dispatch({ type: 'user-sent', text })
    try {
      const ok = await chat.send(opts.tabId, text)
      if (!ok) dispatch({ type: 'user-send-failed' })
    } catch (err) {
      dispatch({ type: 'user-send-failed' })
      throw err
    }
  }

  const sendToolResult = async (args: {
    toolUseId: string
    content: string
    isError?: boolean
  }): Promise<boolean> => {
    const chat = getChatApi()
    return chat.sendToolResult(opts.tabId, args)
  }

  const respondPermission = async (args: {
    requestId: string
    decision:
      | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
      | { behavior: 'deny'; message: string; interrupt?: boolean }
  }): Promise<boolean> => {
    const chat = getChatApi()
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
    return chat.respondPermission(opts.tabId, args)
  }

  const interrupt = async (): Promise<void> => {
    const chat = getChatApi()
    // Main records an `interrupted` event into the session buffer before kill+respawn;
    // the broadcast flows back via `chat:event` and the reducer appends the timeline
    // marker. Single source of truth → replay sees the same boundary.
    await chat.interrupt({
      tabId: opts.tabId,
      taskId: opts.taskId,
      mode: opts.mode,
      cwd: opts.cwd,
      providerFlagsOverride: opts.providerFlagsOverride ?? null,
    })
  }

  const abortAndPop = async (): Promise<{ popped: boolean; text: string | null }> => {
    const chat = getChatApi()
    // Main is authoritative: walks its own buffer to decide pop vs marker. The
    // synthetic event (`user-message-popped` or `interrupted`) flows back via
    // `chat:event`; reducer mutates the timeline. Return value tells the caller
    // whether to restore the popped text to the chat input field.
    return chat.abortAndPop({
      tabId: opts.tabId,
      taskId: opts.taskId,
      mode: opts.mode,
      cwd: opts.cwd,
      providerFlagsOverride: opts.providerFlagsOverride ?? null,
    })
  }

  const kill = async (): Promise<void> => {
    const chat = getChatApi()
    await chat.kill(opts.tabId)
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
    reset,
  }
}
