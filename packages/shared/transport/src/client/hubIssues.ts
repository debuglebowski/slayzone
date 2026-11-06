import { useSyncExternalStore } from 'react'
import type { HubEntry } from '@slayzone/platform/hub-registry'
import type { ConnectionStateSource } from './connectDeadlineLink'
import { useFederationOrNull, type ResolvedHub } from './FederationProvider'

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

/**
 * A hub connection's whole state: a {@link HubIssue}, or `ok` once the hub answered
 * `hub.describe` on an open socket (`authRequired`: the hub requires login, so `ok`
 * means it holds this app's sign-in). Null = not known yet (no socket open so far).
 */
export type HubHealth = { kind: 'ok'; authRequired: boolean } | HubIssue

export interface WatchHubHealthOptions {
  source: ConnectionStateSource
  /** Ask the hub `hub.describe` over this same socket. */
  describe: () => Promise<unknown>
  onHealth: (health: HubHealth | null) => void
  graceMs?: number
}

function sameHealth(a: HubHealth | null, b: HubHealth | null): boolean {
  if (!a || !b) return a === b
  if (a.kind === 'ok' || b.kind === 'ok')
    return (
      a.kind === b.kind &&
      (a as { authRequired: boolean }).authRequired ===
        (b as { authRequired: boolean }).authRequired
    )
  return a.kind === b.kind && a.detail === b.detail
}

/**
 * Report a hub connection's {@link HubHealth} every time it changes. Returns the stop
 * function.
 */
export function watchHubHealth(opts: WatchHubHealthOptions): () => void {
  const graceMs = opts.graceMs ?? HUB_ISSUE_GRACE_MS
  let current: HubHealth | null = null
  let failingSince: number | null = null
  let lastFailure = ''
  let grace: ReturnType<typeof setTimeout> | null = null
  let wasOpen = false
  // Bumped whenever the socket leaves `open`: a describe answer from an earlier
  // open says nothing about the socket now.
  let generation = 0
  let stopped = false

  const report = (next: HubHealth | null): void => {
    if (stopped || sameHealth(next, current)) return
    // The same issue keeps its start: a reworded error is not a new problem.
    current =
      next && next.kind !== 'ok' && current && current.kind === next.kind
        ? { ...next, since: (current as HubIssue).since }
        : next
    opts.onHealth(current)
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
      // Reachable again; what the hub makes of this socket is not known until it answers.
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
              : {
                  kind: 'ok',
                  authRequired: (answer as { authRequired?: unknown } | null)?.authRequired === true
                }
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

/** The issue half of {@link HubHealth}: null for `ok` and for not-known-yet. */
export function issueOf(health: HubHealth | null | undefined): HubIssue | null {
  return health && health.kind !== 'ok' ? health : null
}

export interface WatchHubIssueOptions {
  source: ConnectionStateSource
  describe: () => Promise<unknown>
  onIssue: (issue: HubIssue | null) => void
  graceMs?: number
}

/** {@link watchHubHealth}, reporting only its issue (null when none). */
export function watchHubIssue(opts: WatchHubIssueOptions): () => void {
  let last: HubIssue | null = null
  return watchHubHealth({
    source: opts.source,
    describe: opts.describe,
    graceMs: opts.graceMs,
    onHealth: (health) => {
      const issue = issueOf(health)
      if (!issue && !last) return
      last = issue
      opts.onIssue(issue)
    }
  })
}

/** The one procedure this module calls, typed structurally: transport names no router. */
type HubDescribeClient = { hub: { describe: { query: () => Promise<unknown> } } }

interface HealthFeed {
  get(): HubHealth | null
  subscribe(onChange: () => void): () => void
}

/**
 * One watch per hub client, however many surfaces read it (the banner, the hub's card
 * in Settings): one `hub.describe` per socket open. Keyed by the client object, which
 * a new token replaces (`getOrCreateHubClient`), so a feed never outlives its
 * credential. Watches only while someone listens; restarts from not-known.
 */
const feeds = new WeakMap<object, HealthFeed>()

function healthFeedOf(ws: ResolvedHub['ws']): HealthFeed {
  const cached = feeds.get(ws)
  if (cached) return cached
  const listeners = new Set<() => void>()
  let value: HubHealth | null = null
  let stop: (() => void) | null = null
  const client = ws.client as unknown as HubDescribeClient
  const feed: HealthFeed = {
    get: () => value,
    subscribe: (onChange) => {
      listeners.add(onChange)
      if (!stop) {
        stop = watchHubHealth({
          source: ws.wsClient.connectionState,
          describe: () => client.hub.describe.query(),
          onHealth: (health) => {
            value = health
            for (const listener of listeners) listener()
          }
        })
      }
      return () => {
        listeners.delete(onChange)
        if (listeners.size > 0 || !stop) return
        stop()
        stop = null
        value = null
      }
    }
  }
  feeds.set(ws, feed)
  return feed
}

interface FederationHealth {
  subscribe(onChange: () => void): () => void
  getSnapshot(): ReadonlyMap<string, HubHealth>
}

type Federation = NonNullable<ReturnType<typeof useFederationOrNull>>

/** Every hub's feed in one store, for `useSyncExternalStore`; one per federation value. */
const federationHealth = new WeakMap<Federation, FederationHealth>()

function federationHealthOf(fed: Federation): FederationHealth {
  const cached = federationHealth.get(fed)
  if (cached) return cached
  const hubFeeds: Array<[string, HealthFeed]> = []
  for (const hub of fed.hubs) {
    const resolved = fed.resolve(hub.id)
    if (resolved) hubFeeds.push([hub.id, healthFeedOf(resolved.ws)])
  }
  const read = (): ReadonlyMap<string, HubHealth> => {
    const map = new Map<string, HubHealth>()
    for (const [hubId, feed] of hubFeeds) {
      const health = feed.get()
      if (health) map.set(hubId, health)
    }
    return map
  }
  let snapshot = read()
  const store: FederationHealth = {
    getSnapshot: () => snapshot,
    subscribe: (onChange) => {
      const changed = (): void => {
        snapshot = read()
        onChange()
      }
      const unsubs = hubFeeds.map(([, feed]) => feed.subscribe(changed))
      // A feed another surface already watched has a value this snapshot predates.
      changed()
      return () => {
        for (const unsub of unsubs) unsub()
      }
    }
  }
  federationHealth.set(fed, store)
  return store
}

const NO_HEALTH: ReadonlyMap<string, HubHealth> = new Map()
const noSubscribe = (): (() => void) => () => {}
const noHealth = (): ReadonlyMap<string, HubHealth> => NO_HEALTH

/**
 * Every hub's {@link HubHealth} in the nearest federation, by hub id (absent = not
 * known yet). Empty outside a federation. Watching a hub opens its socket, as
 * `HubScope` does.
 */
export function useHubHealth(): ReadonlyMap<string, HubHealth> {
  const fed = useFederationOrNull()
  const store = fed ? federationHealthOf(fed) : null
  return useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    store ? store.getSnapshot : noHealth,
    store ? store.getSnapshot : noHealth
  )
}

/** A hub with something wrong with its connection. */
export interface HubIssueEntry {
  hub: HubEntry
  issue: HubIssue
}

/** Every hub in the nearest federation that has a {@link HubIssue}, in hub-list order. */
export function useHubIssues(): HubIssueEntry[] {
  const fed = useFederationOrNull()
  const health = useHubHealth()
  if (!fed) return []
  const entries: HubIssueEntry[] = []
  for (const hub of fed.hubs) {
    const issue = issueOf(health.get(hub.id))
    if (issue) entries.push({ hub, issue })
  }
  return entries
}
