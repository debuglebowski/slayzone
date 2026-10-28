import type { LoopConfig } from './types'
import { checkCriteria } from './ansi'

export type LoopStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'passed'
  | 'stopped'
  | 'error'
  | 'max-reached'

export function isLoopActive(status: LoopStatus): boolean {
  return status === 'running'
}

export interface LoopTransport<Marker> {
  /** Capture a marker before sending — used to read output produced after this point. */
  markBoundary: () => Marker
  /** Send a prompt to the agent. */
  send: (prompt: string) => void | Promise<void>
  /** Read the output produced since `marker`. May return null on transport error. */
  readOutputSince: (marker: Marker) => Promise<string | null>
  /** Subscribe to "iteration complete" signal (terminal=idle state, chat=stream-end). */
  subscribeIdle: (cb: () => void) => () => void
  /** Subscribe to session exit. */
  subscribeExit: (cb: () => void) => () => void
}

export interface LoopController {
  start: (config: LoopConfig) => void
  pause: () => void
  resume: () => void
  stop: () => void
  /** Tear down subscriptions. Call on unmount. */
  dispose: () => void
}

export interface LoopHandlers {
  onStatus: (status: LoopStatus) => void
  onIteration: (n: number) => void
}

/**
 * Transport-agnostic loop controller. Drives iteration → wait-for-idle → criteria-check cycle.
 *
 * Caller wires transport callbacks (PTY for terminal, chat IPC for chat panel).
 * Status + iteration changes pushed via handlers.
 */
export function makeLoopController<Marker>(
  transport: LoopTransport<Marker>,
  handlers: LoopHandlers
): LoopController {
  let active = false
  let disposed = false
  let config: LoopConfig | null = null
  let iteration = 0
  let marker: Marker | null = null
  let pendingTimer: ReturnType<typeof setTimeout> | null = null

  const setStatus = (s: LoopStatus) => {
    if (!disposed) handlers.onStatus(s)
  }
  const setIter = (n: number) => {
    iteration = n
    if (!disposed) handlers.onIteration(n)
  }

  const runIteration = (): void => {
    pendingTimer = null
    if (!active || disposed || !config) return
    setIter(iteration + 1)
    setStatus('running')
    marker = transport.markBoundary()
    void transport.send(config.prompt)
  }

  const onIdle = (): void => {
    if (!active || disposed || !config || marker === null) return
    void transport.readOutputSince(marker).then((output) => {
      if (!active || disposed) return
      if (output === null) {
        active = false
        setStatus('error')
        return
      }
      if (checkCriteria(output, config!.criteriaType, config!.criteriaPattern)) {
        active = false
        setStatus('passed')
        return
      }
      if (iteration >= config!.maxIterations) {
        active = false
        setStatus('max-reached')
        return
      }
      pendingTimer = setTimeout(() => runIteration(), 500)
    })
  }

  const onExit = (): void => {
    if (active) {
      active = false
      setStatus('stopped')
    }
  }

  const cancelPending = (): void => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
  }

  const unsubIdle = transport.subscribeIdle(onIdle)
  const unsubExit = transport.subscribeExit(onExit)

  return {
    start: (cfg) => {
      cancelPending()
      config = cfg
      iteration = 0
      if (!disposed) handlers.onIteration(0)
      active = true
      setStatus('idle')
      runIteration()
    },
    pause: () => {
      active = false
      cancelPending()
      setStatus('paused')
    },
    resume: () => {
      active = true
      setStatus('idle')
      runIteration()
    },
    stop: () => {
      active = false
      cancelPending()
      iteration = 0
      if (!disposed) handlers.onIteration(0)
      setStatus('stopped')
    },
    dispose: () => {
      // Tear down: cancel scheduled work + unsubscribe transport hooks.
      // `disposed` flag silences any in-flight async work that lands after
      // unmount (readOutputSince promise resolution, late idle callbacks).
      disposed = true
      active = false
      cancelPending()
      unsubIdle()
      unsubExit()
    }
  }
}
