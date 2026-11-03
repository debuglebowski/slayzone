import { useEffect, useRef, useState } from 'react'
import { useStableCallback } from '@slayzone/ui'

/**
 * The hub's answer when a terminal's scrollback lives on a computer that is
 * unreachable right now (`pty.getBufferSince` / `getBuffer` → SERVICE_UNAVAILABLE;
 * `pty.attach` → `unavailable: 'computer-offline'`). Not an error in the terminal:
 * the process may still run, and its output comes back with the computer.
 */
export function isComputerOfflineError(err: unknown): boolean {
  return (err as { data?: { code?: string } } | null)?.data?.code === 'SERVICE_UNAVAILABLE'
}

/**
 * Whether this terminal's computer is offline, from the session's availability
 * stream (`pty.onOutputAvailability`) or an attach that found it so
 * (`markOffline`). When the computer is back, `catchUp` replays what the terminal
 * missed (from its last rendered seq — gap-free) before the offline state clears;
 * a catch-up that still finds it offline keeps the state.
 */
export function useComputerOffline(opts: {
  sessionId: string
  subscribeAvailability: (sessionId: string, cb: (available: boolean) => void) => () => void
  catchUp: () => Promise<void>
}): { offline: boolean; markOffline: () => void } {
  const [offline, setOffline] = useState(false)
  const offlineRef = useRef(false)
  const set = (next: boolean): void => {
    offlineRef.current = next
    setOffline(next)
  }
  const markOffline = useStableCallback(() => set(true))
  const onAvailability = useStableCallback((available: boolean) => {
    if (!available) {
      set(true)
      return
    }
    if (!offlineRef.current) return
    opts.catchUp().then(
      () => set(false),
      () => set(true)
    )
  })
  const { sessionId, subscribeAvailability } = opts
  useEffect(
    () => subscribeAvailability(sessionId, onAvailability),
    [sessionId, subscribeAvailability, onAvailability]
  )
  return { offline, markOffline }
}
