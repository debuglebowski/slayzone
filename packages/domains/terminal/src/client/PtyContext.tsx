import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useCallback,
  useState,
  useMemo,
  type ReactNode
} from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import type { TerminalState, PromptInfo } from '@slayzone/terminal/shared'
import { disposeTerminal } from './terminal-cache'

// Per-task state - no buffer (backend is source of truth)
interface PtyState {
  lastSeq: number // Last sequence number received for ordering
  exitCode?: number
  crashOutput?: string
  sessionInvalid: boolean
  state: TerminalState
  pendingPrompt?: PromptInfo
  quickRunPrompt?: string
}

type DataCallback = (data: string, seq: number) => void
type ExitCallback = (exitCode: number) => void
type SessionInvalidCallback = () => void
type StateChangeCallback = (newState: TerminalState, oldState: TerminalState) => void
type PromptCallback = (prompt: PromptInfo) => void
type SessionDetectedCallback = (sessionId: string) => void
type DevServerCallback = (url: string) => void
type TitleChangeCallback = (title: string) => void

const ALIVE_STATES: Set<TerminalState> = new Set(['running', 'idle'])

function taskIdFromSessionId(sessionId: string): string {
  const idx = sessionId.indexOf(':')
  return idx >= 0 ? sessionId.substring(0, idx) : sessionId
}

export function applyExitEvent(
  sessionId: string,
  exitCode: number,
  state: PtyState | undefined,
  stateSubs: Map<string, Set<StateChangeCallback>>,
  exitSubs: Map<string, Set<ExitCallback>>
): void {
  if (state) {
    // Ensure state transitions to dead — the main process may not always
    // emit pty:state-change (e.g. killPty deletes session before onExit fires)
    if (state.state !== 'dead') {
      const oldState = state.state
      state.state = 'dead'
      const currentStateSubs = stateSubs.get(sessionId)
      if (currentStateSubs) {
        currentStateSubs.forEach((cb) => cb('dead', oldState))
      }
    }
  }

  // Always notify explicit exit subscribers, even if session state was
  // already cleaned up before the exit event reached the renderer.
  const subs = exitSubs.get(sessionId)
  if (subs) {
    subs.forEach((cb) => cb(exitCode))
  }
}

interface PtyContextValue {
  subscribe: (sessionId: string, cb: DataCallback) => () => void
  subscribeExit: (sessionId: string, cb: ExitCallback) => () => void
  subscribeSessionInvalid: (sessionId: string, cb: SessionInvalidCallback) => () => void
  subscribeState: (sessionId: string, cb: StateChangeCallback) => () => void
  subscribePrompt: (sessionId: string, cb: PromptCallback) => () => void
  subscribeSessionDetected: (sessionId: string, cb: SessionDetectedCallback) => () => void
  subscribeDevServer: (sessionId: string, cb: DevServerCallback) => () => void
  subscribeTitle: (sessionId: string, cb: TitleChangeCallback) => () => void
  getLastSeq: (sessionId: string) => number
  getExitCode: (sessionId: string) => number | undefined
  getCrashOutput: (sessionId: string) => string | undefined
  isSessionInvalid: (sessionId: string) => boolean
  getState: (sessionId: string) => TerminalState
  getPendingPrompt: (sessionId: string) => PromptInfo | undefined
  clearPendingPrompt: (sessionId: string) => void
  resetTaskState: (sessionId: string) => void
  cleanupTask: (sessionId: string) => void // Free all memory for a task
  // Global prompt tracking for badge
  getPendingPromptTaskIds: () => string[]
  // Quick run prompt
  setQuickRunPrompt: (sessionId: string, prompt: string) => void
  getQuickRunPrompt: (sessionId: string) => string | undefined
  clearQuickRunPrompt: (sessionId: string) => void
}

const PtyContext = createContext<PtyContextValue | null>(null)
const ActiveTaskIdsContext = createContext<Set<string>>(new Set())

export function PtyProvider({ children }: { children: ReactNode }) {
  // Per-sessionId state (metadata only - backend is source of truth for buffer)
  const statesRef = useRef<Map<string, PtyState>>(new Map())

  // Per-sessionId subscriber sets
  const dataSubsRef = useRef<Map<string, Set<DataCallback>>>(new Map())
  const exitSubsRef = useRef<Map<string, Set<ExitCallback>>>(new Map())
  const sessionInvalidSubsRef = useRef<Map<string, Set<SessionInvalidCallback>>>(new Map())
  const stateSubsRef = useRef<Map<string, Set<StateChangeCallback>>>(new Map())
  const promptSubsRef = useRef<Map<string, Set<PromptCallback>>>(new Map())
  const sessionDetectedSubsRef = useRef<Map<string, Set<SessionDetectedCallback>>>(new Map())
  const devServerSubsRef = useRef<Map<string, Set<DevServerCallback>>>(new Map())
  const titleSubsRef = useRef<Map<string, Set<TitleChangeCallback>>>(new Map())

  // Track task IDs with pending prompts for global badge
  const [pendingPromptTaskIds, setPendingPromptTaskIds] = useState<Set<string>>(new Set())
  // Ref for stable getPendingPromptTaskIds callback
  const pendingPromptTaskIdsRef = useRef(pendingPromptTaskIds)
  pendingPromptTaskIdsRef.current = pendingPromptTaskIds

  // Track task IDs with alive terminals (running or idle)
  const [activeTaskIds, setActiveTaskIds] = useState<Set<string>>(new Set())

  /** Recompute activeTaskIds from statesRef. Only triggers re-render if the set actually changed. */
  const refreshActiveTaskIds = useCallback(() => {
    setActiveTaskIds((prev) => {
      const next = new Set<string>()
      for (const [sid, s] of statesRef.current) {
        if (ALIVE_STATES.has(s.state)) next.add(taskIdFromSessionId(sid))
      }
      // Avoid new reference if nothing changed
      if (next.size === prev.size && [...next].every((id) => prev.has(id))) return prev
      return next
    })
  }, [])

  // Seed from existing sessions on mount. Use the unified session registry so
  // both PTY and chat-transport sessions hydrate after a renderer reload — the
  // legacy `pty.list()` only sees pty-manager sessions, leaving chat tabs
  // stuck on the default 'starting' state.
  useEffect(() => {
    performance.mark('sz:pty:start')
    window.api.session.list().then((sessions) => {
      for (const s of sessions) {
        if (ALIVE_STATES.has(s.state)) {
          const sid = s.sessionId
          const existing = statesRef.current.get(sid)
          if (existing) {
            existing.state = s.state
          } else {
            statesRef.current.set(sid, { lastSeq: -1, sessionInvalid: false, state: s.state })
          }
        }
      }
      refreshActiveTaskIds()
      performance.mark('sz:pty:end')
    })
  }, [refreshActiveTaskIds])

  const getOrCreateState = useCallback((sessionId: string): PtyState => {
    let state = statesRef.current.get(sessionId)
    if (!state) {
      state = { lastSeq: -1, sessionInvalid: false, state: 'starting' }
      statesRef.current.set(sessionId, state)
    }
    return state
  }, [])

  // Global listeners - survive all view changes
  // Note: Only update existing state, don't create state for unknown tasks
  // State is created when Terminal component subscribes
  useEffect(() => {
    const unsubData = ((cb) => { const s = getTrpcVanillaClient().pty.onData.subscribe(undefined, { onData: ({ sessionId, data, seq }) => cb(sessionId, data, seq) }); return () => s.unsubscribe() })((sessionId: string, data: string, seq: number) => {
      const state = statesRef.current.get(sessionId)
      if (!state) return

      // Drop out-of-order data (seq should be monotonically increasing)
      if (seq <= state.lastSeq) return
      state.lastSeq = seq

      // Notify subscribers
      const subs = dataSubsRef.current.get(sessionId)
      if (subs) {
        subs.forEach((cb) => cb(data, seq))
      }
    })

    const unsubExit = ((cb) => { const s = getTrpcVanillaClient().pty.onExit.subscribe(undefined, { onData: ({ sessionId, exitCode }) => cb(sessionId, exitCode ?? -1) }); return () => s.unsubscribe() })(async (sessionId: string, exitCode: number) => {
      const state = statesRef.current.get(sessionId)

      if (state) {
        state.exitCode = exitCode

        // Capture crash output before the 100ms backend cleanup window closes
        // Only capture if process exited non-zero (likely a crash)
        if (exitCode !== 0) {
          try {
            const raw = await getTrpcVanillaClient().pty.getBuffer.query({ sessionId })
            if (raw && statesRef.current.get(sessionId)) {
              statesRef.current.get(sessionId)!.crashOutput = raw
            }
          } catch {
            // Best-effort; ignore errors
          }
        }

      }

      applyExitEvent(sessionId, exitCode, state, stateSubsRef.current, exitSubsRef.current)

      // Free xterm.js instance + PtyContext state. Handles the case where Terminal
      // component is unmounted (tab closed before PTY exits). If Terminal was still
      // mounted, it already called these synchronously above — all no-ops here.
      disposeTerminal(sessionId)
      statesRef.current.delete(sessionId)
      dataSubsRef.current.delete(sessionId)
      exitSubsRef.current.delete(sessionId)
      sessionInvalidSubsRef.current.delete(sessionId)
      stateSubsRef.current.delete(sessionId)
      promptSubsRef.current.delete(sessionId)
      sessionDetectedSubsRef.current.delete(sessionId)
      devServerSubsRef.current.delete(sessionId)
      titleSubsRef.current.delete(sessionId)
      refreshActiveTaskIds()
    })

    const unsubSessionNotFound = ((cb) => { const s = getTrpcVanillaClient().pty.onSessionNotFound.subscribe(undefined, { onData: ({ sessionId }) => cb(sessionId) }); return () => s.unsubscribe() })((sessionId: string) => {
      const state = statesRef.current.get(sessionId)
      if (!state) return // Ignore for unknown tasks

      state.sessionInvalid = true

      const subs = sessionInvalidSubsRef.current.get(sessionId)
      if (subs) {
        subs.forEach((cb) => cb())
      }
    })

    const unsubStateChange = ((cb) => { const s = getTrpcVanillaClient().pty.onStateChange.subscribe(undefined, { onData: ({ sessionId, newState, oldState }) => cb(sessionId, newState as TerminalState, oldState as TerminalState) }); return () => s.unsubscribe() })((sessionId: string, newState: TerminalState, oldState: TerminalState) => {
      // Bootstrap state entry if missing — chat sessions may emit before any component subscribes.
      // The entry is cheap; without it, early transitions are lost and `getState` stays 'starting'.
      const state = getOrCreateState(sessionId)

      state.state = newState as TerminalState

      const subs = stateSubsRef.current.get(sessionId)
      if (subs) {
        subs.forEach((cb) => cb(newState as TerminalState, oldState as TerminalState))
      }

      // Update active task tracking
      const wasAlive = ALIVE_STATES.has(oldState as TerminalState)
      const isAlive = ALIVE_STATES.has(newState as TerminalState)
      if (wasAlive !== isAlive) refreshActiveTaskIds()

      // Clear pending prompt when state leaves the alive set (e.g. dead/error)
      if (ALIVE_STATES.has(oldState as TerminalState) && !ALIVE_STATES.has(newState as TerminalState)) {
        state.pendingPrompt = undefined
        setPendingPromptTaskIds((prev) => {
          const next = new Set(prev)
          next.delete(sessionId)
          return next
        })
      }
    })

    const unsubPrompt = ((cb) => { const s = getTrpcVanillaClient().pty.onPrompt.subscribe(undefined, { onData: ({ sessionId, prompt }) => cb(sessionId, prompt as PromptInfo) }); return () => s.unsubscribe() })((sessionId: string, prompt: PromptInfo) => {
      const state = statesRef.current.get(sessionId)
      if (!state) return // Ignore prompts for unknown tasks

      state.pendingPrompt = prompt

      // Update global tracking
      setPendingPromptTaskIds((prev) => new Set(prev).add(sessionId))

      const subs = promptSubsRef.current.get(sessionId)
      if (subs) {
        subs.forEach((cb) => cb(prompt))
      }
    })

    const unsubSessionDetected = ((cb) => { const s = getTrpcVanillaClient().pty.onSessionDetected.subscribe(undefined, { onData: ({ sessionId, conversationId }) => cb(sessionId, conversationId) }); return () => s.unsubscribe() })((sessionId: string, conversationId: string) => {
      const subs = sessionDetectedSubsRef.current.get(sessionId)
      if (subs) {
        subs.forEach((cb) => cb(conversationId))
      }
    })

    const unsubDevServer = ((cb) => { const s = getTrpcVanillaClient().pty.onDevServerDetected.subscribe(undefined, { onData: ({ sessionId, info }) => cb(sessionId, info) }); return () => s.unsubscribe() })((sessionId: string, url: unknown) => {
      const subs = devServerSubsRef.current.get(sessionId)
      if (subs) {
        subs.forEach((cb) => cb(url as string))
      }
    })

    const unsubTitleChange = ((cb) => { const s = getTrpcVanillaClient().pty.onTitleChange.subscribe(undefined, { onData: ({ sessionId, title }) => cb(sessionId, title) }); return () => s.unsubscribe() })((sessionId: string, title: string) => {
      const subs = titleSubsRef.current.get(sessionId)
      if (subs) {
        subs.forEach((cb) => cb(title))
      }
    })

    return () => {
      unsubData()
      unsubExit()
      unsubSessionNotFound()
      unsubStateChange()
      unsubPrompt()
      unsubSessionDetected()
      unsubDevServer()
      unsubTitleChange()
    }
  }, [getOrCreateState, refreshActiveTaskIds])

  const subscribe = useCallback((sessionId: string, cb: DataCallback): (() => void) => {
    // Ensure state exists so onData doesn't drop data
    getOrCreateState(sessionId)

    let subs = dataSubsRef.current.get(sessionId)
    if (!subs) {
      subs = new Set()
      dataSubsRef.current.set(sessionId, subs)
    }
    subs.add(cb)
    return () => {
      subs!.delete(cb)
    }
  }, [getOrCreateState])

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

  const subscribeSessionInvalid = useCallback(
    (sessionId: string, cb: SessionInvalidCallback): (() => void) => {
      let subs = sessionInvalidSubsRef.current.get(sessionId)
      if (!subs) {
        subs = new Set()
        sessionInvalidSubsRef.current.set(sessionId, subs)
      }
      subs.add(cb)
      return () => {
        subs!.delete(cb)
      }
    },
    []
  )

  const subscribeState = useCallback((sessionId: string, cb: StateChangeCallback): (() => void) => {
    // Ensure state exists so onStateChange doesn't drop events
    getOrCreateState(sessionId)

    let subs = stateSubsRef.current.get(sessionId)
    if (!subs) {
      subs = new Set()
      stateSubsRef.current.set(sessionId, subs)
    }
    subs.add(cb)

    // Fetch initial state from backend if we don't have it yet. Goes through
    // the session registry so chat-transport sessions resolve too — bare
    // `pty.getState` returns null for chat tabs and leaves them stuck.
    const state = statesRef.current.get(sessionId)
    if (!state || state.state === 'starting') {
      window.api.session.getState(sessionId).then((backendState) => {
        if (backendState) {
          const localState = getOrCreateState(sessionId)
          if (localState.state !== backendState) {
            const oldState = localState.state
            localState.state = backendState
            // Notify all subscribers of the initial state
            const currentSubs = stateSubsRef.current.get(sessionId)
            if (currentSubs) {
              currentSubs.forEach((sub) => sub(backendState, oldState))
            }
            // Update active task tracking
            if (ALIVE_STATES.has(backendState)) refreshActiveTaskIds()
          }
        }
      })
    }

    return () => {
      subs!.delete(cb)
    }
  }, [getOrCreateState])

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

  const subscribeTitle = useCallback(
    (sessionId: string, cb: TitleChangeCallback): (() => void) => {
      let subs = titleSubsRef.current.get(sessionId)
      if (!subs) {
        subs = new Set()
        titleSubsRef.current.set(sessionId, subs)
      }
      subs.add(cb)
      return () => {
        subs!.delete(cb)
      }
    },
    []
  )

  const getLastSeq = useCallback((sessionId: string): number => {
    return statesRef.current.get(sessionId)?.lastSeq ?? -1
  }, [])

  const getExitCode = useCallback((sessionId: string): number | undefined => {
    return statesRef.current.get(sessionId)?.exitCode
  }, [])

  const getCrashOutput = useCallback((sessionId: string): string | undefined => {
    return statesRef.current.get(sessionId)?.crashOutput
  }, [])

  const isSessionInvalid = useCallback((sessionId: string): boolean => {
    return statesRef.current.get(sessionId)?.sessionInvalid ?? false
  }, [])

  const getState = useCallback((sessionId: string): TerminalState => {
    return statesRef.current.get(sessionId)?.state ?? 'starting'
  }, [])

  const getPendingPrompt = useCallback((sessionId: string): PromptInfo | undefined => {
    return statesRef.current.get(sessionId)?.pendingPrompt
  }, [])

  const clearPendingPrompt = useCallback((sessionId: string): void => {
    const state = statesRef.current.get(sessionId)
    if (state) {
      state.pendingPrompt = undefined
      setPendingPromptTaskIds((prev) => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
  }, [])

  const getPendingPromptTaskIds = useCallback((): string[] => {
    return Array.from(pendingPromptTaskIdsRef.current)
  }, [])

  // Full reset for mode switches - removes all state so fresh state is created
  // Sequence numbers handle ordering - no need for ignore mechanism
  const resetTaskState = useCallback((sessionId: string): void => {
    statesRef.current.delete(sessionId)
    setPendingPromptTaskIds((prev) => {
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  // Clean up all memory for a task (call when PTY exits or task is deleted)
  const cleanupTask = useCallback((sessionId: string): void => {
    statesRef.current.delete(sessionId)
    dataSubsRef.current.delete(sessionId)
    exitSubsRef.current.delete(sessionId)
    sessionInvalidSubsRef.current.delete(sessionId)
    stateSubsRef.current.delete(sessionId)
    promptSubsRef.current.delete(sessionId)
    sessionDetectedSubsRef.current.delete(sessionId)
    devServerSubsRef.current.delete(sessionId)
    titleSubsRef.current.delete(sessionId)
    setPendingPromptTaskIds((prev) => {
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  // Quick run prompt - for auto-sending prompt when task opens
  const setQuickRunPrompt = useCallback((sessionId: string, prompt: string): void => {
    const state = getOrCreateState(sessionId)
    state.quickRunPrompt = prompt
  }, [getOrCreateState])

  const getQuickRunPrompt = useCallback((sessionId: string): string | undefined => {
    return statesRef.current.get(sessionId)?.quickRunPrompt
  }, [])

  const clearQuickRunPrompt = useCallback((sessionId: string): void => {
    const state = statesRef.current.get(sessionId)
    if (state) {
      state.quickRunPrompt = undefined
    }
  }, [])

  const value = useMemo<PtyContextValue>(() => ({
    subscribe,
    subscribeExit,
    subscribeSessionInvalid,
    subscribeState,
    subscribePrompt,
    subscribeSessionDetected,
    subscribeDevServer,
    subscribeTitle,
    getLastSeq,
    getExitCode,
    getCrashOutput,
    isSessionInvalid,
    getState,
    getPendingPrompt,
    clearPendingPrompt,
    resetTaskState,
    cleanupTask,
    getPendingPromptTaskIds,
    setQuickRunPrompt,
    getQuickRunPrompt,
    clearQuickRunPrompt
  }), [
    subscribe,
    subscribeExit,
    subscribeSessionInvalid,
    subscribeState,
    subscribePrompt,
    subscribeSessionDetected,
    subscribeDevServer,
    subscribeTitle,
    getLastSeq,
    getExitCode,
    getCrashOutput,
    isSessionInvalid,
    getState,
    getPendingPrompt,
    clearPendingPrompt,
    resetTaskState,
    cleanupTask,
    getPendingPromptTaskIds,
    setQuickRunPrompt,
    getQuickRunPrompt,
    clearQuickRunPrompt
  ])

  return (
    <PtyContext.Provider value={value}>
      <ActiveTaskIdsContext.Provider value={activeTaskIds}>
        {children}
      </ActiveTaskIdsContext.Provider>
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

/**
 * Hook for tracking pending prompts globally.
 * Returns array of task IDs with pending prompts.
 */
export function usePendingPrompts(): string[] {
  const ctx = usePty()
  return ctx.getPendingPromptTaskIds()
}

/**
 * Reactive set of task IDs with alive terminals (running or idle).
 * Uses a separate context so changes only re-render consumers of this hook,
 * not all usePty() consumers.
 */
export function useActiveTaskIds(): Set<string> {
  return useContext(ActiveTaskIdsContext)
}
