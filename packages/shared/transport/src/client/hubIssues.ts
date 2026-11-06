import { useEffect, useState } from 'react'
import type { HubEntry } from '@slayzone/platform/hub-registry'
import type { ConnectionStateSource } from './connectDeadlineLink'
import { useFederationOrNull } from './FederationProvider'

/**
 * What is wrong with a hub connection, for the app-wide banner (one per hub):
 *
 * - `unreachable`: the socket has kept failing for {@link HUB_ISSUE_GRACE_MS}.
 *   `since` is its first failure, `detail` the error that ended the last attempt.
 * - `signin`: the socket is open but the hub, which requires login, resolved no
 *   account for it — the stored sign-in is gone (expired, revoked by Entra, never
 *   made). Every call there is refused while the socket itself looks healthy.
 * - `error`: the socket is open but the hub cannot answer `hub.describe`, the one
 *   call every hub serves to anyone — something is wrong beyond sign-in.
 *
 * The answer comes from the socket's own state and the hub's own `hub.describe`,
 * asked again each time the socket opens: the hub resolves a socket's account once,
 * at open, and closes it when that account's session ends (`trpc-connections.ts`
 * on the hub), so a fresh open is exactly when the answer can change.
 */
export type HubIssue =
  | { kind: 'unreachable'; since: number; detail: string }
  | { kind: 'signin'; since: number; detail: string }
  | { kind: 'error'; since: number; detail: string }

/** How long a socket must keep failing before its hub reads unreachable in the banner:
 *  longer than a reconnect blip or the local hub's boot. */
export const HUB_ISSUE_GRACE_MS = 5_000

/** The fields of `hub.describe` read here; a hub older than them sends none. */
type DescribeAnswer = { authRequired?: boolean; scopes?: readonly string[] | null } | null

/**
 * Did the hub find no account on this socket? `scopes` is null when the hub's gate
 * is off OR when the socket has no principal, so only `authRequired` tells them
 * apart. A hub too old to send `scopes` is not called signed out.
 */
export function isSignedOutDescribe(answer: unknown): boolean {
  if (!answer || typeof answer !== 'object') return false
  const d = answer as NonNullable<DescribeAnswer>
  return d.authRequired === true && 'scopes' in d && d.scopes === null
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface WatchHubIssueOptions {
  source: ConnectionStateSource
  /** Ask the hub `hub.describe` over this same socket. */
  describe: () => Promise<unknown>
  onIssue: (issue: HubIssue | null) => void
  graceMs?: number
}

/**
 * Report a hub connection's {@link HubIssue} (null when none) every time it changes.
 * Returns the stop function.
 */
export function watchHubIssue(opts: WatchHubIssueOptions): () => void {
  const graceMs = opts.graceMs ?? HUB_ISSUE_GRACE_MS
  let current: HubIssue | null = null
  let failingSince: number | null = null
  let lastFailure = ''
  let grace: ReturnType<typeof setTimeout> | null = null
  let wasOpen = false
  // Bumped whenever the socket leaves `open`: a describe answer from an earlier
  // open says nothing about the socket now.
  let generation = 0
  let stopped = false

  const report = (next: HubIssue | null): void => {
    if (stopped) return
    if (next && current && next.kind === current.kind && next.detail === current.detail) return
    if (!next && !current) return
    // The same kind keeps its start: a reworded error is not a new problem.
    current =
      next && current && next.kind === current.kind ? { ...next, since: current.since } : next
    opts.onIssue(current)
  }

  const clearGrace = (): void => {
    if (grace) clearTimeout(grace)
    grace = null
  }

  const onState = (state: ReturnType<ConnectionStateSource['get']>): void => {
    if (state.state === 'pending') {
      clearGrace()
      failingSince = null
      if (wasOpen) return
      wasOpen = true
      if (current?.kind === 'unreachable') report(null)
      const asked = generation
      opts.describe().then(
        (answer) => {
          if (asked !== generation) return
          report(
            isSignedOutDescribe(answer)
              ? {
                  kind: 'signin',
                  since: Date.now(),
                  detail: 'The hub requires sign-in and holds none for this app.'
                }
              : null
          )
        },
        (err: unknown) => {
          if (asked !== generation) return
          report({ kind: 'error', since: Date.now(), detail: messageOf(err) })
        }
      )
      return
    }
    if (wasOpen) generation++
    wasOpen = false
    if (state.state !== 'connecting' || !state.error) return
    lastFailure = messageOf(state.error)
    if (failingSince === null) failingSince = Date.now()
    if (current?.kind === 'unreachable') {
      report({ kind: 'unreachable', since: current.since, detail: lastFailure })
      return
    }
    if (grace) return
    grace = setTimeout(() => {
      grace = null
      report({ kind: 'unreachable', since: failingSince ?? Date.now(), detail: lastFailure })
    }, graceMs)
  }

  onState(opts.source.get())
  const subscription = opts.source.subscribe({ next: onState })
  return () => {
    stopped = true
    clearGrace()
    subscription.unsubscribe()
  }
}

/** The one procedure this module calls, typed structurally: transport names no router. */
type HubDescribeClient = { hub: { describe: { query: () => Promise<unknown> } } }

const NO_ISSUES: ReadonlyMap<string, HubIssue> = new Map()

/** A hub with something wrong with its connection. */
export interface HubIssueEntry {
  hub: HubEntry
  issue: HubIssue
}

/**
 * Every hub in the nearest federation that has a {@link HubIssue}, in hub-list order.
 * Empty outside a federation. Watching a hub opens its socket, as `HubScope` does.
 */
export function useHubIssues(): HubIssueEntry[] {
  const fed = useFederationOrNull()
  // Tagged with the federation they were watched under: a new one (fresh tokens after
  // a sign-in rebuild the hub's client) starts from nothing, without a reset render.
  const [watched, setWatched] = useState<{ fed: unknown; issues: ReadonlyMap<string, HubIssue> }>(
    () => ({ fed: null, issues: new Map() })
  )

  useEffect(() => {
    if (!fed) return
    const stops: Array<() => void> = []
    for (const hub of fed.hubs) {
      const resolved = fed.resolve(hub.id)
      if (!resolved) continue
      const client = resolved.ws.client as unknown as HubDescribeClient
      stops.push(
        watchHubIssue({
          source: resolved.ws.wsClient.connectionState,
          describe: () => client.hub.describe.query(),
          onIssue: (issue) =>
            setWatched((prev) => {
              const next = new Map(prev.fed === fed ? prev.issues : undefined)
              if (issue) next.set(hub.id, issue)
              else next.delete(hub.id)
              return { fed, issues: next }
            })
        })
      )
    }
    return () => {
      for (const stop of stops) stop()
    }
  }, [fed])

  const issues = watched.fed === fed ? watched.issues : NO_ISSUES
  if (!fed) return []
  const entries: HubIssueEntry[] = []
  for (const hub of fed.hubs) {
    const issue = issues.get(hub.id)
    if (issue) entries.push({ hub, issue })
  }
  return entries
}
