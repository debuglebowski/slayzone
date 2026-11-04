import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type MutableRefObject,
  type ReactNode
} from 'react'
import { useSubscription, useFederationOrNull, HubScope } from '@slayzone/transport/client'
import { useTRPC, useTRPCClient } from './trpc'
import type { TerminalState, PromptInfo } from '@slayzone/terminal-contracts'
import { useStableCallback } from '@slayzone/ui'
import { disposeTerminal } from './terminal-cache'
import { directPtyStatus, onDirectPtySessionsChanged, ptyBufferSince } from './direct-pty'
import { createPtyDelivery, type PtyBackfill, type PtyDelivery } from './pty-delivery'
import { createRelaySubscription } from './relay-subscription'
import { useTerminalStateStore, useWireTerminalStateStore } from './useTerminalStateStore'

// Per-task state - no buffer (backend is source of truth)
export interface PtyState {
  lastSeq: number // Last sequence number received for ordering
  crashOutput?: string
}

type DataCallback = (data: string, seq: number) => void
/** `reason`: the adapter's error code (e.g. SESSION_NOT_FOUND). `exitReason`: the
 *  lifecycle cause the code cannot carry (`startup-timeout`, `computer-restarted`, …).
 *  `exitDetail`: the owner's own words for it (a spawn refusal's message). */
type ExitCallback = (
  exitCode: number,
  reason?: string | null,
  exitReason?: string | null,
  exitDetail?: string | null
) => void
type StateChangeCallback = (newState: TerminalState, oldState: TerminalState) => void
type PromptCallback = (prompt: PromptInfo) => void
type SessionDetectedCallback = (sessionId: string) => void
type DevServerCallback = (url: string) => void
type TitleChangeCallback = (title: string) => void
type AvailabilityCallback = (available: boolean) => void

interface PtyContextValue {
  /**
   * `rendered`: the last seq this terminal wrote by itself (attach, replay). Output
   * continues after it, and a gap after it is read back (pty-delivery.ts).
   */
  subscribe: (sessionId: string, cb: DataCallback, rendered?: () => number) => () => void
  /**
   * Deliver one chunk of a session's output, in seq order: what the hub stream
   * does, and what a direct link (direct-pty.ts) does for chunks it receives
   * straight from the computer. A seq already delivered is dropped, so the two
   * streams may overlap.
   */
  deliver: (sessionId: string, data: string, seq: number, backfill: PtyBackfill) => void
  subscribeExit: (sessionId: string, cb: ExitCallback) => () => void
  subscribeState: (sessionId: string, cb: StateChangeCallback) => () => void
  subscribePrompt: (sessionId: string, cb: PromptCallback) => () => void
  subscribeSessionDetected: (sessionId: string, cb: SessionDetectedCallback) => () => void
  subscribeDevServer: (sessionId: string, cb: DevServerCallback) => () => void
  subscribeTitle: (sessionId: string, cb: TitleChangeCallback) => () => void
  /** The session's computer went offline (false) / came back (true). */
  subscribeAvailability: (sessionId: string, cb: AvailabilityCallback) => () => void
  getLastSeq: (sessionId: string) => number
  getCrashOutput: (sessionId: string) => string | undefined
  getState: (sessionId: string) => TerminalState
  resetTaskState: (sessionId: string) => void
  cleanupTask: (sessionId: string) => void // Free all memory for a task
}

const PtyContext = createContext<PtyContextValue | null>(null)

/** Shared subscriber/state refs the event streams write into. Session ids are
 *  globally unique (`${taskId}:${taskId}`, tasks unique per hub), so ONE shared
 *  set of maps is correct even when N hubs' streams fan into it. */
interface PtyStreamSinks {
  deliver: (sessionId: string, data: string, seq: number, backfill: PtyBackfill) => void
  /** The sessions this hub must relay: mounted here and not on a direct link. */
  relaySessionIds: () => string[]
  onRelaySetChanged: (cb: () => void) => () => void
  statesRef: MutableRefObject<Map<string, PtyState>>
  dataSubsRef: MutableRefObject<Map<string, Set<DataCallback>>>
  exitSubsRef: MutableRefObject<Map<string, Set<ExitCallback>>>
  promptSubsRef: MutableRefObject<Map<string, Set<PromptCallback>>>
  sessionDetectedSubsRef: MutableRefObject<Map<string, Set<SessionDetectedCallback>>>
  devServerSubsRef: MutableRefObject<Map<string, Set<DevServerCallback>>>
  titleSubsRef: MutableRefObject<Map<string, Set<TitleChangeCallback>>>
  availabilitySubsRef: MutableRefObject<Map<string, Set<AvailabilityCallback>>>
}

/**
 * The PTY live event streams for ONE hub. Mounted once per connected hub inside
 * that hub's `<HubScope>`, so ambient `useTRPC()`/`useTRPCClient()` here resolve
 * to that hub's client — a remote task's onData/onExit/onPrompt/... arrive from
 * the hub that actually runs its pty. All streams write into the SHARED sinks
 * (keyed by globally-unique sessionId), and the reactive terminal-state store is
 * wired here too, so status dots track every hub. Single-hub → exactly one
 * instance = byte-identical to the former root-only wiring.
 */
function PtyEventStreams({ sinks }: { sinks: PtyStreamSinks }): null {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const {
    deliver,
    relaySessionIds,
    onRelaySetChanged,
    statesRef,
    dataSubsRef,
    exitSubsRef,
    promptSubsRef,
    sessionDetectedSubsRef,
    devServerSubsRef,
    titleSubsRef,
    availabilitySubsRef
  } = sinks

  // Reactive terminal-state store wiring (state-change / exit / hibernated subs +
  // hydrate) — per hub, so this hub's session liveness feeds the shared store.
  useWireTerminalStateStore()

  // Global event-stream subscriptions — survive all view changes. The server
  // fans out ALL sessions (no per-session filter); the payload carries the
  // sessionId, so each handler filters/looks up by sessionId exactly as the IPC
  // path did. Kept ALWAYS enabled (no tab gating) — terminal correctness needs
  // every frame, in order.
  //
  // Note: only update EXISTING state, don't create state for unknown tasks —
  // state is created when the Terminal component subscribes (the
  // ensure-state-before-onData guard).
  const handleData = useStableCallback(
    ({ sessionId, data, seq }: { sessionId: string; data: string; seq: number }) =>
      deliver(sessionId, data, seq, (afterSeq) =>
        ptyBufferSince(trpcClient, sessionId, afterSeq).then((b) => b?.chunks ?? [])
      )
  )
  // Output relayed through the hub, for exactly the sessions that need it: those
  // mounted here and not on a direct link to their computer (docs/direct-link.md).
  // The hub has a session's computer stream through it only while someone watches
  // it, so a direct terminal takes the hub out of its data path.
  useEffect(() => {
    const relay = createRelaySubscription({
      open: (sessionIds, onStarted) => {
        const sub = trpcClient.pty.onData.subscribe(
          { sessionIds },
          { onStarted, onData: handleData }
        )
        return { close: () => sub.unsubscribe() }
      }
    })
    relay.set(relaySessionIds())
    const off = onRelaySetChanged(() => relay.set(relaySessionIds()))
    return () => {
      off()
      relay.close()
    }
  }, [trpcClient, handleData, relaySessionIds, onRelaySetChanged])

  const handleExit = useStableCallback(
    async ({
      sessionId,
      exitCode,
      errorCode,
      exitReason,
      exitDetail
    }: {
      sessionId: string
      exitCode: number | null
      errorCode: string | null
      exitReason: string | null
      exitDetail: string | null
    }) => {
      const state = statesRef.current.get(sessionId)

      if (state) {
        // Capture crash output before the 100ms backend cleanup window closes
        // Only capture if process exited non-zero (likely a crash)
        if (exitCode !== 0) {
          try {
            const raw = await trpcClient.pty.getBuffer.query({ sessionId })
            if (raw && statesRef.current.get(sessionId)) {
              statesRef.current.get(sessionId)!.crashOutput = raw
            }
          } catch {
            // Best-effort; ignore errors
          }
        }
      }

      // Fire explicit exit subscribers (the exit event stream). Terminal STATE
      // (→ 'dead', or preserved 'hibernated') is owned by the reactive store,
      // which applies its own pty:exit handler + reconcile. `errorCode` is the
      // structured exit reason (the old positional `reason` arg).
      const subs = exitSubsRef.current.get(sessionId)
      if (subs) {
        subs.forEach((cb) =>
          cb(exitCode ?? 0, errorCode ?? null, exitReason ?? null, exitDetail ?? null)
        )
      }

      // Free xterm.js instance + this session's event-stream bookkeeping.
      disposeTerminal(sessionId)
      statesRef.current.delete(sessionId)
      dataSubsRef.current.delete(sessionId)
      exitSubsRef.current.delete(sessionId)
      promptSubsRef.current.delete(sessionId)
      sessionDetectedSubsRef.current.delete(sessionId)
      devServerSubsRef.current.delete(sessionId)
      titleSubsRef.current.delete(sessionId)
    }
  )
  useSubscription(trpc.pty.onExit.subscriptionOptions(undefined, { onData: handleExit }))

  const handlePrompt = useStableCallback(
    ({ sessionId, prompt }: { sessionId: string; prompt: unknown }) => {
      if (!statesRef.current.has(sessionId)) return // Ignore prompts for unknown tasks

      const subs = promptSubsRef.current.get(sessionId)
      if (subs) {
        subs.forEach((cb) => cb(prompt as PromptInfo))
      }
    }
  )
  useSubscription(trpc.pty.onPrompt.subscriptionOptions(undefined, { onData: handlePrompt }))

  const handleSessionDetected = useStableCallback(
    ({ sessionId, conversationId }: { sessionId: string; conversationId: string }) => {
      const subs = sessionDetectedSubsRef.current.get(sessionId)
      if (subs) {
        subs.forEach((cb) => cb(conversationId))
      }
    }
  )
  useSubscription(
    trpc.pty.onSessionDetected.subscriptionOptions(undefined, { onData: handleSessionDetected })
  )

  const handleDevServerDetected = useStableCallback(
    ({ sessionId, url }: { sessionId: string; url: string }) => {
      const subs = devServerSubsRef.current.get(sessionId)
      if (subs) {
        subs.forEach((cb) => cb(url))
      }
    }
  )
  useSubscription(
    trpc.pty.onDevServerDetected.subscriptionOptions(undefined, { onData: handleDevServerDetected })
  )

  const handleTitleChange = useStableCallback(
    ({ sessionId, title }: { sessionId: string; title: string }) => {
      const subs = titleSubsRef.current.get(sessionId)
      if (subs) {
        subs.forEach((cb) => cb(title))
      }
    }
  )
  useSubscription(
    trpc.pty.onTitleChange.subscriptionOptions(undefined, { onData: handleTitleChange })
  )

  const handleAvailability = useStableCallback(
    ({ sessionId, available }: { sessionId: string; available: boolean }) => {
      const subs = availabilitySubsRef.current.get(sessionId)
      if (subs) subs.forEach((cb) => cb(available))
    }
  )
  useSubscription(
    trpc.pty.onOutputAvailability.subscriptionOptions(undefined, { onData: handleAvailability })
  )

  return null
}

export function PtyProvider({ children }: { children: ReactNode }) {
  // Per-sessionId state (metadata only - backend is source of truth for buffer)
  const statesRef = useRef<Map<string, PtyState>>(new Map())

  // Per-sessionId subscriber sets
  const dataSubsRef = useRef<Map<string, Set<DataCallback>>>(new Map())
  const exitSubsRef = useRef<Map<string, Set<ExitCallback>>>(new Map())
  const promptSubsRef = useRef<Map<string, Set<PromptCallback>>>(new Map())
  const sessionDetectedSubsRef = useRef<Map<string, Set<SessionDetectedCallback>>>(new Map())
  const devServerSubsRef = useRef<Map<string, Set<DevServerCallback>>>(new Map())
  const titleSubsRef = useRef<Map<string, Set<TitleChangeCallback>>>(new Map())
  const availabilitySubsRef = useRef<Map<string, Set<AvailabilityCallback>>>(new Map())

  // Multi-hub: the PTY event streams must run per connected hub (a remote task's
  // pty lives on its hub, so onData/onExit only arrive from that hub's socket).
  // Mount one PtyEventStreams per hub inside its HubScope, all writing the SHARED
  // sinks above. Single-hub / no federation → exactly one instance on the
  // default hub = byte-identical to the former root-only wiring.
  const fed = useFederationOrNull()
  // Seq-ordered, gap-aware delivery shared by the hub stream and the direct link
  // (pty-delivery.ts): duplicates dropped, a gap read back before going on.
  const renderedRef = useRef(new Map<string, Set<() => number>>())
  const deliveryRef = useRef<PtyDelivery | null>(null)
  if (deliveryRef.current === null) {
    deliveryRef.current = createPtyDelivery({
      emit: (sessionId, data, seq) => {
        const state = statesRef.current.get(sessionId)
        if (state) state.lastSeq = seq
        dataSubsRef.current.get(sessionId)?.forEach((cb) => cb(data, seq))
      }
    })
  }
  const delivery = deliveryRef.current
  const deliver = useCallback(
    (sessionId: string, data: string, seq: number, backfill: PtyBackfill): void => {
      // Only sessions a terminal subscribed to (state exists) take output.
      if (!statesRef.current.has(sessionId)) return
      // What the terminal already wrote itself (attach / replay) counts as delivered.
      let rendered = -1
      for (const get of renderedRef.current.get(sessionId) ?? [])
        rendered = Math.max(rendered, get())
      delivery.advance(sessionId, rendered)
      delivery.deliver(sessionId, data, seq, backfill)
    },
    [delivery]
  )
  const relayListenersRef = useRef(new Set<() => void>())
  const relaySetChanged = useCallback(() => {
    for (const cb of relayListenersRef.current) cb()
  }, [])
  const relaySessionIds = useCallback((): string[] => {
    const direct = new Set(directPtyStatus().sessionIds)
    const ids: string[] = []
    for (const [id, subs] of dataSubsRef.current) if (subs.size > 0 && !direct.has(id)) ids.push(id)
    return ids
  }, [])
  const onRelaySetChanged = useCallback((cb: () => void): (() => void) => {
    relayListenersRef.current.add(cb)
    return () => relayListenersRef.current.delete(cb)
  }, [])
  useEffect(() => onDirectPtySessionsChanged(relaySetChanged), [relaySetChanged])
  const sinks: PtyStreamSinks = {
    deliver,
    relaySessionIds,
    onRelaySetChanged,
    statesRef,
    dataSubsRef,
    exitSubsRef,
    promptSubsRef,
    sessionDetectedSubsRef,
    devServerSubsRef,
    titleSubsRef,
    availabilitySubsRef
  }
  const hubStreams = fed ? (
    fed.hubs.map((h) => (
      <HubScope key={h.id} hubId={h.id}>
        <PtyEventStreams sinks={sinks} />
      </HubScope>
    ))
  ) : (
    // No FederationProvider (fork / tests) → wire against the ambient client.
    <PtyEventStreams sinks={sinks} />
  )

  // Terminal STATE (incl. hibernation + self-heal reconcile + alive-task
  // tracking) lives in the reactive store (useTerminalStateStore). PtyContext
  // owns only the event streams (data/exit/prompt/title/...) + their metadata.

  const getOrCreateState = useCallback(
    (sessionId: string): PtyState => {
      let state = statesRef.current.get(sessionId)
      if (!state) {
        state = { lastSeq: -1 }
        statesRef.current.set(sessionId, state)
        // A new state is a new start (first mount, or after an exit / mode switch
        // removed the old one): the delivery position starts over with it.
        delivery.reset(sessionId)
        delivery.open(sessionId)
      }
      return state
    },
    [delivery]
  )

  const subscribe = useCallback(
    (sessionId: string, cb: DataCallback, rendered?: () => number): (() => void) => {
      // Ensure state exists so onData doesn't drop data
      getOrCreateState(sessionId)

      let subs = dataSubsRef.current.get(sessionId)
      if (!subs) {
        subs = new Set()
        dataSubsRef.current.set(sessionId, subs)
      }
      subs.add(cb)
      let positions = renderedRef.current.get(sessionId)
      if (rendered) {
        if (!positions) {
          positions = new Set()
          renderedRef.current.set(sessionId, positions)
        }
        positions.add(rendered)
      }
      relaySetChanged()
      return () => {
        subs!.delete(cb)
        if (rendered) positions?.delete(rendered)
        relaySetChanged()
      }
    },
    [getOrCreateState, relaySetChanged]
  )

  const subscribeExit = useCallback((sessionId: string, cb: ExitCallback): (() => void) => {
    let subs = exitSubsRef.current.get(sessionId)
    if (!subs) {
      subs = new Set()
      exitSubsRef.current.set(sessionId, subs)
    }
    subs.add(cb)
    return () => {
      subs!.delete(cb)
    }
  }, [])

  // Store-backed shim: state lives in the reactive store now. Preserves the
  // `(newState, oldState)` callback contract that useLoopMode relies on.
  const subscribeState = useCallback((sessionId: string, cb: StateChangeCallback): (() => void) => {
    return useTerminalStateStore.subscribe(
      (s) => s.byId[sessionId] ?? 'starting',
      (next, previous) => cb(next, previous)
    )
  }, [])

  const subscribePrompt = useCallback((sessionId: string, cb: PromptCallback): (() => void) => {
    let subs = promptSubsRef.current.get(sessionId)
    if (!subs) {
      subs = new Set()
      promptSubsRef.current.set(sessionId, subs)
    }
    subs.add(cb)
    return () => {
      subs!.delete(cb)
    }
  }, [])

  const subscribeSessionDetected = useCallback(
    (sessionId: string, cb: SessionDetectedCallback): (() => void) => {
      let subs = sessionDetectedSubsRef.current.get(sessionId)
      if (!subs) {
        subs = new Set()
        sessionDetectedSubsRef.current.set(sessionId, subs)
      }
      subs.add(cb)
      return () => {
        subs!.delete(cb)
      }
    },
    []
  )

  const subscribeDevServer = useCallback(
    (sessionId: string, cb: DevServerCallback): (() => void) => {
      let subs = devServerSubsRef.current.get(sessionId)
      if (!subs) {
        subs = new Set()
        devServerSubsRef.current.set(sessionId, subs)
      }
      subs.add(cb)
      return () => {
        subs!.delete(cb)
      }
    },
    []
  )

  const subscribeTitle = useCallback((sessionId: string, cb: TitleChangeCallback): (() => void) => {
    let subs = titleSubsRef.current.get(sessionId)
    if (!subs) {
      subs = new Set()
      titleSubsRef.current.set(sessionId, subs)
    }
    subs.add(cb)
    return () => {
      subs!.delete(cb)
    }
  }, [])

  const subscribeAvailability = useCallback(
    (sessionId: string, cb: AvailabilityCallback): (() => void) => {
      let subs = availabilitySubsRef.current.get(sessionId)
      if (!subs) {
        subs = new Set()
        availabilitySubsRef.current.set(sessionId, subs)
      }
      subs.add(cb)
      return () => {
        subs!.delete(cb)
      }
    },
    []
  )

  const getLastSeq = useCallback(
    (sessionId: string): number =>
      statesRef.current.has(sessionId) ? delivery.lastSeq(sessionId) : -1,
    [delivery]
  )

  const getCrashOutput = useCallback((sessionId: string): string | undefined => {
    return statesRef.current.get(sessionId)?.crashOutput
  }, [])

  const getState = useCallback((sessionId: string): TerminalState => {
    return useTerminalStateStore.getState().getSessionState(sessionId)
  }, [])

  // Full reset for mode switches - removes all state so fresh state is created
  // Sequence numbers handle ordering - no need for ignore mechanism
  const resetTaskState = useCallback((sessionId: string): void => {
    statesRef.current.delete(sessionId)
    useTerminalStateStore.getState().clearSession(sessionId)
  }, [])

  // Clean up all memory for a task (call when PTY exits or task is deleted)
  const cleanupTask = useCallback((sessionId: string): void => {
    statesRef.current.delete(sessionId)
    useTerminalStateStore.getState().clearSession(sessionId)
    dataSubsRef.current.delete(sessionId)
    exitSubsRef.current.delete(sessionId)
    promptSubsRef.current.delete(sessionId)
    sessionDetectedSubsRef.current.delete(sessionId)
    devServerSubsRef.current.delete(sessionId)
    titleSubsRef.current.delete(sessionId)
  }, [])

  const value = useMemo<PtyContextValue>(
    () => ({
      subscribe,
      deliver,
      subscribeExit,
      subscribeState,
      subscribePrompt,
      subscribeSessionDetected,
      subscribeDevServer,
      subscribeTitle,
      subscribeAvailability,
      getLastSeq,
      getCrashOutput,
      getState,
      resetTaskState,
      cleanupTask
    }),
    [
      subscribeAvailability,
      subscribe,
      deliver,
      subscribeExit,
      subscribeState,
      subscribePrompt,
      subscribeSessionDetected,
      subscribeDevServer,
      subscribeTitle,
      getLastSeq,
      getCrashOutput,
      getState,
      resetTaskState,
      cleanupTask
    ]
  )

  return (
    <PtyContext.Provider value={value}>
      {hubStreams}
      {children}
    </PtyContext.Provider>
  )
}

export function usePty(): PtyContextValue {
  const ctx = useContext(PtyContext)
  if (!ctx) {
    throw new Error('usePty must be used within PtyProvider')
  }
  return ctx
}
