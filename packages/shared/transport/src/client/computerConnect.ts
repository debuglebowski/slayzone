/**
 * A count of computer connects, as the UI saw them (the app shell's
 * `computers.onStatusChange` handler calls {@link noteComputerConnected}). Views
 * backed by a computer refuse with "connect a computer" until one is there; a
 * subscription refused that way stays errored, so it restarts on the next connect
 * ({@link useResubscribeOnComputerConnect}).
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'

let generation = 0
const listeners = new Set<() => void>()

export function noteComputerConnected(): void {
  generation++
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useComputerConnectGeneration(): number {
  return useSyncExternalStore(subscribe, () => generation)
}

/** A tRPC `useSubscription` result: restart it after a connect if it errored. */
export function useResubscribeOnComputerConnect(sub: { status: string; reset(): void }): void {
  const current = useComputerConnectGeneration()
  const seen = useRef(current)
  const { status, reset } = sub
  useEffect(() => {
    if (seen.current === current) return
    seen.current = current
    if (status === 'error') reset()
  }, [current, status, reset])
}
