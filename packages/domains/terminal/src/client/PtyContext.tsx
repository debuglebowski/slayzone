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
import type { TerminalState, PromptInfo } from '@slayzone/terminal/shared'
import { disposeTerminal } from './terminal-cache'
import { useTerminalStateStore } from './useTerminalStateStore'

// Per-task state - no buffer (backend is source of truth)
export interface PtyState {
  lastSeq: number // Last sequence number received for ordering
  exitCode?: number
  crashOutput?: string
  pendingPrompt?: PromptInfo
  quickRunPrompt?: string
}

type DataCallback = (data: string, seq: number) => void
type ExitCallback = (exitCode: number, reason?: string | null) => void
type StateChangeCallback = (newState: TerminalState, oldState: TerminalState) => void
type PromptCallback = (prompt: PromptInfo) => void
type SessionDetectedCallback = (sessionId: string) => void
type DevServerCallback = (url: string) => void
type TitleChangeCallback = (title: string) => void

const ALIVE_STATES: Set<TerminalState> = new Set(['running', 'idle'])

interface PtyContextValue {
  subscribe: (sessionId: string, cb: DataCallback) => () => void
  subscribeExit: (sessionId: string, cb: ExitCallback) => () => void
  subscribeState: (sessionId: string, cb: StateChangeCallback) => () => void
  subscribePrompt: (sessionId: string, cb: PromptCallback) => () => void
  subscribeSessionDetected: (sessionId: string, cb: SessionDetectedCallback) => () => void
  subscribeDevServer: (sessionId: string, cb: DevServerCallback) => () => void
  subscribeTitle: (sessionId: string, cb: TitleChangeCallback) => () => void
  getLastSeq: (sessionId: string) => number
  getExitCode: (sessionId: string) => number | undefined
  getCrashOutput: (sessionId: string) => string | undefined
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

  // Track task IDs with pending prompts for global badge
  const [pendingPromptTaskIds, setPendingPromptTaskIds] = useState<Set<string>>(new Set())
  // Ref for stable getPendingPromptTaskIds callback
  const pendingPromptTaskIdsRef = useRef(pendingPromptTaskIds)
  pendingPromptTaskIdsRef.current = pendingPromptTaskIds

  // Terminal STATE (incl. hibernation + self-heal reconcile + alive-task
  // tracking) lives in the reactive store (useTerminalStateStore). PtyContext
  // owns only the event streams (data/exit/prompt/title/...) + their metadata.

  const getOrCreateState = useCallback((sessionId: string): PtyState => {
    let state = statesRef.current.get(sessionId)
    if (!state) {
      state = { lastSeq: -1 }
      statesRef.current.set(sessionId, state)
    }
    return state
  }, [])

  // Global listeners - survive all view changes
  // Note: Only update existing state, don't create state for unknown tasks
  // State is created when Terminal component subscribes
  useEffect(() => {
    const unsubData = window.api.pty.onData((sessionId, data, seq) => {
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

    const unsubExit = window.api.pty.onExit(async (sessionId, exitCode, reason) => {
      const state = statesRef.current.get(sessionId)

      if (state) {
        state.exitCode = exitCode

        // Capture crash output before the 100ms backend cleanup window closes
        // Only capture if process exited non-zero (likely a crash)
        if (exitCode !== 0) {
          try {
            const raw = await window.api.pty.getBuffer(sessionId)
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
      // which applies its own pty:exit handler + reconcile.
      const subs = exitSubsRef.current.get(sessionId)
      if (subs) subs.forEach((cb) => cb(exitCode, reason ?? null))

      // Free xterm.js instance + this session's event-stream bookkeeping.
      disposeTerminal(sessionId)
      statesRef.current.delete(sessionId)
      dataSubsRef.current.delete(sessionId)
      exitSubsRef.current.delete(sessionId)
      promptSubsRef.current.delete(sessionId)
      sessionDetectedSubsRef.current.delete(sessionId)
      devServerSubsRef.current.delete(sessionId)
      titleSubsRef.current.delete(sessionId)
    })

    // Terminal STATE lives in the reactive store (which has its own
    // onStateChange handler). PtyContext keeps only the pending-prompt side
    // effect: clear it when the agent leaves the alive set (dead/error).
    const unsubStateChange = window.api.pty.onStateChange((sessionId, newState, oldState) => {
      if (ALIVE_STATES.has(oldState) && !ALIVE_STATES.has(newState)) {
        const state = statesRef.current.get(sessionId)
        if (state) state.pendingPrompt = undefined
        setPendingPromptTaskIds((prev) => {
          if (!prev.has(sessionId)) return prev
          const next = new Set(prev)
          next.delete(sessionId)
          return next
        })
      }
    })

    const unsubPrompt = window.api.pty.onPrompt((sessionId, prompt) => {
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

    const unsubSessionDetected = window.api.pty.onSessionDetected((sessionId, conversationId) => {
      const subs = sessionDetectedSubsRef.current.get(sessionId)
      if (subs) {
        subs.forEach((cb) => cb(conversationId))
      }
    })

    const unsubDevServer = window.api.pty.onDevServerDetected((sessionId, url) => {
      const subs = devServerSubsRef.current.get(sessionId)
      if (subs) {
        subs.forEach((cb) => cb(url))
      }
    })

    const unsubTitleChange = window.api.pty.onTitleChange((sessionId, title) => {
      const subs = titleSubsRef.current.get(sessionId)
      if (subs) {
        subs.forEach((cb) => cb(title))
      }
    })

    return () => {
      unsubData()
      unsubExit()
      unsubStateChange()
      unsubPrompt()
      unsubSessionDetected()
      unsubDevServer()
      unsubTitleChange()
    }
  }, [])

  const subscribe = useCallback(
    (sessionId: string, cb: DataCallback): (() => void) => {
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
    },
    [getOrCreateState]
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
  const subscribeState = useCallback(
    (sessionId: string, cb: StateChangeCallback): (() => void) => {
      return useTerminalStateStore.subscribe(
        (s) => s.byId[sessionId] ?? 'starting',
        (next, previous) => cb(next, previous)
      )
    },
    []
  )

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

  const getLastSeq = useCallback((sessionId: string): number => {
    return statesRef.current.get(sessionId)?.lastSeq ?? -1
  }, [])

  const getExitCode = useCallback((sessionId: string): number | undefined => {
    return statesRef.current.get(sessionId)?.exitCode
  }, [])

  const getCrashOutput = useCallback((sessionId: string): string | undefined => {
    return statesRef.current.get(sessionId)?.crashOutput
  }, [])

  const getState = useCallback((sessionId: string): TerminalState => {
    return useTerminalStateStore.getState().getSessionState(sessionId)
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
    useTerminalStateStore.getState().clearSession(sessionId)
    setPendingPromptTaskIds((prev) => {
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
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
    setPendingPromptTaskIds((prev) => {
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  // Quick run prompt - for auto-sending prompt when task opens
  const setQuickRunPrompt = useCallback(
    (sessionId: string, prompt: string): void => {
      const state = getOrCreateState(sessionId)
      state.quickRunPrompt = prompt
    },
    [getOrCreateState]
  )

  const getQuickRunPrompt = useCallback((sessionId: string): string | undefined => {
    return statesRef.current.get(sessionId)?.quickRunPrompt
  }, [])

  const clearQuickRunPrompt = useCallback((sessionId: string): void => {
    const state = statesRef.current.get(sessionId)
    if (state) {
      state.quickRunPrompt = undefined
    }
  }, [])

  const value = useMemo<PtyContextValue>(
    () => ({
      subscribe,
      subscribeExit,
      subscribeState,
      subscribePrompt,
      subscribeSessionDetected,
      subscribeDevServer,
      subscribeTitle,
      getLastSeq,
      getExitCode,
      getCrashOutput,
      getState,
      getPendingPrompt,
      clearPendingPrompt,
      resetTaskState,
      cleanupTask,
      getPendingPromptTaskIds,
      setQuickRunPrompt,
      getQuickRunPrompt,
      clearQuickRunPrompt
    }),
    [
      subscribe,
      subscribeExit,
      subscribeState,
      subscribePrompt,
      subscribeSessionDetected,
      subscribeDevServer,
      subscribeTitle,
      getLastSeq,
      getExitCode,
      getCrashOutput,
      getState,
      getPendingPrompt,
      clearPendingPrompt,
      resetTaskState,
      cleanupTask,
      getPendingPromptTaskIds,
      setQuickRunPrompt,
      getQuickRunPrompt,
      clearQuickRunPrompt
    ]
  )

  return <PtyContext.Provider value={value}>{children}</PtyContext.Provider>
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
