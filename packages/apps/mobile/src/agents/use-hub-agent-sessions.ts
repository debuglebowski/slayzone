/**
 * One hub's agent sessions, live: the state of every terminal AND chat agent on the
 * hub, kept by the shared terminal-state rules (`@slayzone/terminal/terminal-state`,
 * the rules desktop's store runs) over
 *
 * - pushes: `pty.onStateChange` (terminal and chat agents), `pty.onExit`,
 *   `pty.onBackgroundJobs`, `pty.onHibernated`;
 * - snapshots: `pty.sessionList` + the persisted hibernated set
 *   (`taskTerminals.listHibernatedSessions`), reconciled the way desktop's 15s
 *   self-heal does: at mount, when the socket comes back (pushes sent while it was
 *   down are lost: the feed reloads every query of the hub then, this snapshot too —
 *   `HubFeedSource`), when the app returns to the foreground (React Query's focus
 *   refetch), after an exit, and every 30s while the app is in front.
 *
 * Must run inside the hub's `HubScope`.
 */
import { useSubscription } from '@slayzone/transport/client'
import type { TerminalState } from '@slayzone/terminal-contracts'
import {
  applyBackgroundJobs,
  applyExit,
  applyHibernated,
  applyStateChange,
  EMPTY_TERMINAL_STATE,
  reconcile,
  type TerminalStateData,
  type TerminalStatePatch
} from '@slayzone/terminal/terminal-state'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useReducer } from 'react'
import { useTRPC, useTRPCClient } from '../trpc'
import type { HubAgentSessions } from './hub-agents'

/** Backstop for a push lost without a reconnect (desktop: 15s, plus window focus). */
const SNAPSHOT_INTERVAL_MS = 30_000

type Step = (state: TerminalStateData) => TerminalStatePatch

function applyStep(state: TerminalStateData, step: Step): TerminalStateData {
  const patch = step(state)
  return Object.keys(patch).length === 0 ? state : { ...state, ...patch }
}

export function useHubAgentSessions(): HubAgentSessions {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const [state, dispatch] = useReducer(applyStep, EMPTY_TERMINAL_STATE)

  const snapshot = useQuery({
    queryKey: ['agents', 'snapshot'],
    queryFn: async () => {
      // Taken before the fetch: a push that lands while it is in flight is fresher
      // than what the snapshot could see, and keeps its value (`reconcile`).
      const dispatchedAt = Date.now()
      const [sessions, hibernated] = await Promise.all([
        client.pty.sessionList.query(),
        client.taskTerminals.listHibernatedSessions.query()
      ])
      return { dispatchedAt, sessions, hibernated }
    },
    staleTime: 0,
    refetchInterval: SNAPSHOT_INTERVAL_MS
  })
  const refetch = snapshot.refetch

  useEffect(() => {
    const data = snapshot.data
    if (!data) return
    dispatch((s) => reconcile(s, data.sessions, data.hibernated, data.dispatchedAt))
  }, [snapshot.data])

  useSubscription(
    trpc.pty.onStateChange.subscriptionOptions(undefined, {
      onData: ({ sessionId, newState }) =>
        dispatch((s) => applyStateChange(s, sessionId, newState as TerminalState, Date.now()))
    })
  )
  useSubscription(
    trpc.pty.onExit.subscriptionOptions(undefined, {
      onData: ({ sessionId }) => {
        dispatch((s) => applyExit(s, sessionId, Date.now()))
        void refetch()
      }
    })
  )
  useSubscription(
    trpc.pty.onBackgroundJobs.subscriptionOptions(undefined, {
      onData: ({ sessionId, count }) =>
        dispatch((s) => applyBackgroundJobs(s, sessionId, count, Date.now()))
    })
  )
  useSubscription(
    trpc.pty.onHibernated.subscriptionOptions(undefined, {
      onData: ({ sessionId }) => dispatch((s) => applyHibernated(s, sessionId, Date.now()))
    })
  )

  const loaded = snapshot.data !== undefined
  const error = snapshot.error ? snapshot.error.message : null
  return useMemo(() => ({ state, loaded, error }), [state, loaded, error])
}
