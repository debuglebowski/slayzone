/**
 * The app's connection to every signed-in hub at once, through the SAME federation
 * path desktop uses for remote hubs: `FederationProvider` (one socket per hub, its
 * bearer as tRPC `connectionParams`, one React Query cache per hub) and one `HubScope`
 * per hub. Each hub's `HubFeedSource` loads that hub's board and watches its socket,
 * and reports what it has into `useHubFeeds()`; screens read the merged view from
 * there (`hub-board.ts`).
 *
 * A hub served inside the app (`HubSession.inProcess`: the demo hub) joins the same
 * federation through its in-process link: no socket, always connected, every screen
 * unchanged.
 *
 * Nothing below this provider sits inside an ambient `HubScope`: a screen about one
 * hub's row wraps itself in that hub's scope, so `useTRPC()` anywhere else throws
 * instead of quietly talking to some hub.
 */
import type { HubEntry } from '@slayzone/platform/hub-registry'
import {
  defaultDirectProbe,
  FederationProvider,
  type HubConnection,
  HubScope,
  type RuntimeLink,
  useFederation,
  useHubConnection,
  setDirectLinkProbe,
  useSubscription
} from '@slayzone/transport/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { installDirectRtc } from './direct-rtc'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { NO_AGENT_SESSIONS } from './agents/hub-agents'
import { useHubAgentSessions } from './agents/use-hub-agent-sessions'
import {
  type HubBoardState,
  type HubClient,
  type HubFeed,
  ownerClient,
  UNREACHABLE_GRACE_MS
} from './hub-board'
import type { HubSession } from './hub-session'
import { useTRPC } from './trpc'

// Direct links to computers (docs/direct-link.md): the phone reaches a computer
// straight when the hub offers its public address and a plain HTTP probe gets
// through (on cellular, behind NAT, offline — it does not, and the hub relays).
setDirectLinkProbe((address) => defaultDirectProbe(address))
// A computer with no address the phone can dial (behind NAT) is reached over WebRTC,
// brokered by the hub; when that fails too, the hub relays.
installDirectRtc()

/**
 * The federation's default hub id: the client's co-located hub, which this app has
 * none of. It names no hub in the list, so every hub is a remote one and gets its
 * bearer (the default hub never does).
 */
const NO_LOCAL_HUB = 'local'

export interface HubFeeds {
  /** One per signed-in hub, in sign-in order. */
  feeds: HubFeed[]
  /** Load everything this hub's screens show again, which also reconnects at once. */
  retry: (hubId: string) => void
  /** The client of the hub that owns a row (see `ownerClient`). */
  clientFor: (hubId: string) => HubClient
}

const HubFeedsContext = createContext<HubFeeds | null>(null)

export function useHubFeeds(): HubFeeds {
  const feeds = useContext(HubFeedsContext)
  if (!feeds) throw new Error('useHubFeeds must be used within HubConnections')
  return feeds
}

export function HubConnections({
  sessions,
  children
}: {
  sessions: readonly HubSession[]
  children: ReactNode
}) {
  const hubs = useMemo(() => sessions.map((s) => s.entry), [sessions])
  const tokens = useMemo(
    () => Object.fromEntries(sessions.map((s) => [s.entry.id, s.token])),
    [sessions]
  )
  // Hubs served inside the app (the demo hub): their tRPC never leaves the process.
  const inProcessLinks = useMemo(() => {
    const links: Record<string, RuntimeLink> = {}
    for (const s of sessions) if (s.inProcess) links[s.entry.id] = s.inProcess.link
    return links
  }, [sessions])
  return (
    <FederationProvider
      hubs={hubs}
      defaultHubId={NO_LOCAL_HUB}
      tokens={tokens}
      inProcessLinks={inProcessLinks}
    >
      <Feeds hubs={hubs}>{children}</Feeds>
    </FederationProvider>
  )
}

type Report = (hubId: string, feed: HubFeed | null) => void

function Feeds({ hubs, children }: { hubs: HubEntry[]; children: ReactNode }) {
  const { resolve } = useFederation()
  const [reports, setReports] = useState<ReadonlyMap<string, HubFeed>>(new Map())
  const report = useCallback<Report>((hubId, feed) => {
    setReports((prev) => {
      const next = new Map(prev)
      if (feed) next.set(hubId, feed)
      else next.delete(hubId)
      return next
    })
  }, [])

  const value = useMemo<HubFeeds>(
    () => ({
      feeds: hubs.map((hub) => reports.get(hub.id) ?? notReported(hub)),
      retry: (hubId) => void resolve(hubId)?.queryClient.refetchQueries({ type: 'active' }),
      clientFor: (hubId) => ownerClient(resolve, hubId)
    }),
    [hubs, reports, resolve]
  )

  return (
    <HubFeedsContext.Provider value={value}>
      {hubs.map((hub) => (
        <HubFeedScope key={hub.id} hub={hub} onFeed={report} />
      ))}
      {children}
    </HubFeedsContext.Provider>
  )
}

const PENDING_BOARD: HubBoardState = {
  data: undefined,
  pending: true,
  error: null,
  refreshing: false
}

/** A hub whose source has not reported yet (the render before its first effect). */
function notReported(hub: HubEntry): HubFeed {
  return {
    hub,
    connection: { status: 'connecting', error: null },
    stalled: false,
    board: PENDING_BOARD,
    agents: NO_AGENT_SESSIONS
  }
}

function HubFeedScope({ hub, onFeed }: { hub: HubEntry; onFeed: Report }) {
  const connection = useHubConnection(hub.id)
  return (
    <HubScope hubId={hub.id}>
      <HubFeedSource hub={hub} connection={connection} onFeed={onFeed} />
    </HubScope>
  )
}

/**
 * One hub's feed: its board (`task.loadBoardData`, the procedure the desktop board
 * loads), reloaded when the hub says its tasks changed (`notify.onTasksChanged`), its
 * agent sessions (`useHubAgentSessions`), and its connection. Everything shown of the
 * hub loads again by itself when its socket comes back (`useReloadOnReconnect`). Must
 * sit inside that hub's `HubScope`. Renders nothing.
 */
export function HubFeedSource({
  hub,
  connection,
  onFeed
}: {
  hub: HubEntry
  connection: HubConnection | null
  onFeed: Report
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const boardQ = useQuery(trpc.task.loadBoardData.queryOptions(undefined, { staleTime: 30_000 }))
  useSubscription(
    trpc.notify.onTasksChanged.subscriptionOptions(undefined, {
      onData: () => void queryClient.invalidateQueries(trpc.task.loadBoardData.queryFilter())
    })
  )
  const stalled = useStalled(connection !== null && connection.status !== 'open')
  const agents = useHubAgentSessions()
  useReloadOnReconnect(connection)

  const { data, isPending, isRefetching, error } = boardQ
  const message = error ? error.message : null
  const board = useMemo<HubBoardState>(
    () => ({ data, pending: isPending, error: message, refreshing: isRefetching }),
    [data, isPending, message, isRefetching]
  )

  useEffect(() => {
    onFeed(hub.id, { hub, connection, stalled, board, agents })
  }, [onFeed, hub, connection, stalled, board, agents])
  // Signed out of: nothing of this hub stays in the list.
  useEffect(() => () => onFeed(hub.id, null), [onFeed, hub.id])

  return null
}

/**
 * The hub's socket opens again after it failed or dropped: everything this hub's
 * screens show loads again (the queries of its `HubScope`), as Retry would. What the
 * hub pushed while the socket was down (`notify.onTasksChanged`, agent state…) never
 * arrives. A socket that opens without having failed (a first connect, or a first
 * attempt that hung past the connect deadline) reloads only the loads that failed
 * meanwhile; the others are still on their way.
 */
function useReloadOnReconnect(connection: HubConnection | null): void {
  const queryClient = useQueryClient()
  const lostSinceOpen = useRef(false)
  const wasOpen = useRef(connection?.status === 'open')
  useEffect(() => {
    const open = connection?.status === 'open'
    const opened = open && !wasOpen.current
    wasOpen.current = open
    if (connection && !open && connection.error) lostSinceOpen.current = true
    if (!opened) return
    if (lostSinceOpen.current) {
      lostSinceOpen.current = false
      void queryClient.invalidateQueries()
    } else {
      void queryClient.refetchQueries({ predicate: (query) => query.state.status === 'error' })
    }
  }, [connection, queryClient])
}

/** `down` has held for `UNREACHABLE_GRACE_MS`. */
function useStalled(down: boolean): boolean {
  const [elapsed, setElapsed] = useState(false)
  // Every outage counts its own grace period: a change of `down` restarts the count
  // (React's "adjust state when a prop changes" pattern, during render).
  const [wasDown, setWasDown] = useState(down)
  if (down !== wasDown) {
    setWasDown(down)
    setElapsed(false)
  }
  useEffect(() => {
    if (!down) return
    const timer = setTimeout(() => setElapsed(true), UNREACHABLE_GRACE_MS)
    return () => clearTimeout(timer)
  }, [down])
  return down && elapsed
}
