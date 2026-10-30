import { behaviorSubject } from '@trpc/server/observable'
import { useMemo, useSyncExternalStore } from 'react'
import type { ConnectionStateSource } from './connectDeadlineLink'
import { useFederation } from './FederationProvider'

/**
 * A hub's connection as the UI reads it: the socket's OWN state (@trpc/client's
 * `wsClient.connectionState`), not a guess from whether some query is still pending.
 * A query against a hub that is gone waits up to `HUB_CONNECT_DEADLINE_MS` before it
 * fails (`connectDeadlineLink`); the socket says so at its first failed attempt.
 *
 * - `idle`: no socket yet (a lazy client before its first operation).
 * - `connecting`: an attempt is under way. `error` is null on the first one; after a
 *   failed attempt, or a socket that dropped, it is what ended it, and @trpc/client's
 *   reconnect loop is retrying (backoff 0, 2, 4 … 30s).
 * - `open`: connected (@trpc/client calls it `pending`).
 */
export type HubConnection =
  | { status: 'idle'; error: null }
  | { status: 'connecting'; error: Error | null }
  | { status: 'open'; error: null }

type ConnectionState = ReturnType<ConnectionStateSource['get']>

const IDLE: HubConnection = { status: 'idle', error: null }
const FIRST_ATTEMPT: HubConnection = { status: 'connecting', error: null }
const OPEN: HubConnection = { status: 'open', error: null }

export function toHubConnection(state: ConnectionState): HubConnection {
  switch (state.state) {
    case 'idle':
      return IDLE
    case 'pending':
      return OPEN
    case 'connecting':
      return state.error ? { status: 'connecting', error: state.error } : FIRST_ATTEMPT
  }
}

/** Live `toHubConnection` of a socket's state stream. */
export function useConnectionState(source: ConnectionStateSource): HubConnection {
  const subscribe = useMemo(
    () => (onChange: () => void) => {
      const subscription = source.subscribe({ next: onChange })
      return () => subscription.unsubscribe()
    },
    [source]
  )
  // `get()` hands back the same object until the next state: a stable snapshot.
  const state = useSyncExternalStore(subscribe, source.get, source.get)
  return useMemo(() => toHubConnection(state), [state])
}

/** A state that never changes, read for a hub the federation does not list. */
const NO_SOCKET: ConnectionStateSource = behaviorSubject<ConnectionState>({
  type: 'state',
  state: 'idle',
  error: null
})

/**
 * The connection of a hub in the nearest `FederationProvider` (opening its socket if
 * nothing has yet, like `HubScope`); null when the federation does not list the hub.
 */
export function useHubConnection(hubId: string): HubConnection | null {
  const resolved = useFederation().resolve(hubId)
  const connection = useConnectionState(resolved?.ws.wsClient.connectionState ?? NO_SOCKET)
  return resolved ? connection : null
}
