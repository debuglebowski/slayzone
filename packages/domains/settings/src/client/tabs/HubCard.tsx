import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { electronBootstrap, useSubscription } from '@slayzone/transport/client'
import { useTRPC, useTRPCClient } from '../trpc'
// Leaf subpath, deliberately not `@slayzone/platform/slayzone-config`: that one
// imports node:fs/node:path, which rollup externalizes out of the renderer bundle
// and then fails to resolve. Same constant, browser-safe module.
import { DEFAULT_LOCAL_COMPUTER_NAME } from '@slayzone/platform/computer-identity'
// The status words every client shows (the mobile app too): one implementation.
import {
  capabilityNote,
  computerRowStatus,
  computerUpgradeTitle,
  outdatedComputerNote
} from '@slayzone/computers/labels'
import { Button, IconButton, Input, Skeleton, cn, toast } from '@slayzone/ui'
import {
  FolderCog,
  Loader2,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  RotateCw,
  Trash2,
  X
} from 'lucide-react'
import { useComputerActions } from './ComputerActions'
import { MachineLabel } from './MachineLabel'
import { ComputerName } from './ComputerName'
import { ComputerFaults } from './ComputerFaults'
import { HubUsersSection } from './HubUsersSection'

/**
 * A hub, as a card that owns its computers.
 *
 * WHY NESTED. A computer belongs to exactly ONE hub, and which hub is decided when
 * the token is MINTED — the token embeds that hub's dial URL.
 * Listing computers inside their hub makes that containment the shape of the UI, so
 * the enrollment affordance's POSITION is the hub choice: no picker, and no way to
 * mint a token against a hub the operator didn't mean.
 *
 * WHY A RAIL. The card border alone did not carry it: a bare column grid under a
 * hub row reads as that hub's own properties, because every column header
 * (Name/Platform/Status) is generic. Computers hang off an indented connector
 * instead, under a "Computers" heading, with ＋ Add computer as the LAST LEAF — so
 * enrolling is visibly an operation inside this hub rather than a page action.
 * Column headers are gone with it; the values (`darwin-arm64`, `pty, git`) label
 * themselves, and the heading names the rows once.
 *
 * WHY THE CARD LIVES HERE rather than in `HubsSettingsTab`. The body is the computer
 * list and only this component can query it, so the hub's own identity/controls
 * come in as slots. `HubCardShell` is the shared chrome, exported for the hubs
 * that CANNOT have a computer list at all (see `HubsSettingsTab.hubCardFor`).
 *
 * WHY A SEPARATE COMPONENT FROM THE TAB. `useTRPC()` resolves to the nearest
 * provider, so one component cannot query more than one hub with hooks. Mounted
 * once per hub inside `<HubScope hubId>`, each copy gets its own tRPC client +
 * QueryClient and uses ORDINARY `useQuery`/`useMutation` — no vanilla-client
 * plumbing, no manual cancellation, per-hub loading/error for free.
 *
 * The load-bearing consequence is that BOTH mutations here — mint and delete — are
 * created inside the hub's own scope, so they are bound to the hub that owns this
 * card by CONSTRUCTION. The alternative (one flat table routing by an id→hub map)
 * makes the same correctness a lookup that can silently go stale.
 *
 * THE LOCAL COMPUTER is the one row this client can control as a PROCESS rather than
 * as a registry entry: it is the app's own supervised child. So on the local hub
 * only, its row carries a restart action, and its ABSENCE gets a leaf of its own —
 * a local hub with no local computer cannot execute anything at all, and that state
 * is reachable (boot-time join-token mint failure) with no way out but relaunching.
 */

/**
 * FIXED SLOTS. Every hub card ends in the same three columns at the same widths —
 * status, primary action, more — whatever kind of hub it is.
 *
 * Before, a local card ended with switch + word + icon and a remote with button +
 * three icons: two unrelated shapes, ragged at different widths, so a list of hubs
 * had no column to scan down. Fixed widths cost a little space on the cards that
 * do not fill them, and buy alignment that holds no matter what a hub's state is.
 *
 * The slots are RESERVED, not conditional: an empty primary still occupies its
 * width, so nothing shifts when a Sign in button appears or a hub goes offline.
 */
export interface HubCardShellProps {
  /** Keys the card for tests and scoping (`hub-group-<id>`). */
  hubId: string
  /** Which kind of hub row this is, for the existing per-kind testids. */
  headerTestId: string
  /** Default star, name, address. */
  identity: ReactNode
  /** One shared vocabulary across hub kinds — see `HubStatus`. */
  status: ReactNode
  /** The single most useful action for this hub right now. May be absent. */
  primary?: ReactNode
  /** Everything else, behind `⋯`. */
  more: ReactNode
  /** An icon action for the card as a whole, just left of `⋯` (refresh the list). */
  headerAction?: ReactNode
  /** The card body — the computers area. */
  body: ReactNode
}

export function HubCardShell({
  hubId,
  headerTestId,
  identity,
  status,
  primary,
  more,
  headerAction,
  body
}: HubCardShellProps) {
  return (
    <div
      className="border-border bg-card rounded-lg border"
      data-testid={`hub-group-${hubId}`}
      data-hub-id={hubId}
    >
      {/* The header is the HUB's alone. Nothing computer-derived sits here — a count
          beside the hub's own address reads as a property of the hub, and the rows
          below state it anyway. */}
      {/* NO gap between the slots — the computer rows below are table cells, which
          have no gaps to mirror, so a gap here would offset every column by the
          accumulated 8px and the two rows would never line up. Spacing lives
          inside the slots (their fixed widths) instead. */}
      <div className="flex items-center px-3 py-2.5" data-testid={headerTestId}>
        <div className="flex min-w-0 flex-1 items-center gap-2">{identity}</div>
        <div className="w-32 shrink-0">{status}</div>
        <div className="flex w-24 shrink-0 justify-end">{primary}</div>
        {/* Reserved for both icons even when only `⋯` shows, so the status column
            lines up across every card. Rows mirror the two trailing slots with ONE
            action column of their combined width (`ROW_ACTIONS`). */}
        <div className="flex w-16 shrink-0 items-center justify-end">
          {headerAction}
          {more}
        </div>
      </div>
      <div className="border-border/60 border-t px-3 py-2">{body}</div>
    </div>
  )
}

/**
 * A computer row's action column: as wide as the header's primary + refresh/`⋯` slots
 * together (w-24 + w-16), right-aligned, so a row's icons end where the header's
 * `⋯` does. One column, not two: an empty cell under the header's icons left a
 * gap at the right of every row.
 */
const ROW_ACTIONS = 'w-40 py-2'

/** ok = live, idle = known-but-not-live, bad = we asked and it failed. */
export type HubStatusTone = 'ok' | 'idle' | 'bad'

/**
 * One status vocabulary for every hub kind, so the column means the same thing
 * all the way down. A local hub is Running/Off; a remote is Signed in, Reachable,
 * Signed out, Unreachable. The dot carries the tone, the word carries the fact —
 * neither alone is enough (colour is not readable to everyone, and "Off" beside a
 * green dot would be a contradiction).
 */
export function HubStatus({
  tone,
  label,
  detail,
  title
}: {
  tone: HubStatusTone
  label: string
  /** Second, fainter line under the label (e.g. an upgrade's step and target). */
  detail?: string
  title?: string
}) {
  const dot = (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        tone === 'ok'
          ? 'bg-green-500'
          : tone === 'bad'
            ? 'bg-destructive'
            : 'bg-muted-foreground/50'
      )}
      aria-hidden="true"
    />
  )
  const word = (
    <span className={cn('truncate', tone === 'bad' ? 'text-destructive' : 'text-muted-foreground')}>
      {label}
    </span>
  )
  if (!detail)
    return (
      <span className="flex items-center gap-1.5 text-xs" title={title} data-testid="hub-status">
        {dot}
        {word}
      </span>
    )
  return (
    <span className="flex min-w-0 flex-col text-xs" title={title} data-testid="hub-status">
      <span className="flex items-center gap-1.5">
        {dot}
        {word}
      </span>
      {/* Indented to the label, past the dot (size-1.5 + gap-1.5 = 0.75rem). */}
      <span className="text-muted-foreground/70 truncate pl-3">{detail}</span>
    </span>
  )
}

/**
 * "Computers", plus an optional note for the states that are NOT a list of rows.
 *
 * Shared with the hubs that cannot be queried at all, so every card names what its
 * body is about — even when that body is one line of explanation.
 */
export function ComputersHeading({
  note,
  noteTestId,
  action
}: {
  note?: string
  noteTestId?: string
  /** Right-aligned control for the section (the refresh button). */
  action?: ReactNode
}) {
  return (
    <div className="flex min-h-7 items-center gap-2 pb-1">
      <span className="text-muted-foreground text-xs font-medium">Computers</span>
      {note ? (
        <span className="text-muted-foreground text-xs" data-testid={noteTestId}>
          {note}
        </span>
      ) : null}
      {action ? <div className="ml-auto">{action}</div> : null}
    </div>
  )
}

/** One placeholder leaf, shown while the first load is in flight. */
function SkeletonRow({ rail = true, last = false }: { rail?: boolean; last?: boolean }) {
  return (
    <tr data-testid="computer-row-skeleton">
      {rail ? <Rail last={last} /> : <td className="w-8" />}
      <td className="py-2 pr-3 pl-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      </td>
      <td className="w-32 py-2 pr-3">
        <Skeleton className="h-3 w-20" />
      </td>
      <td className={ROW_ACTIONS} />
    </tr>
  )
}

export interface HubCardProps {
  /** The hub this card is for (also the ambient HubScope's id). */
  hubId: string
  /** Display label, used when naming the hub a freshly minted token points at. */
  hubLabel: string
  /**
   * This hub is the LOCAL one — i.e. its computers include the app's own supervised
   * child, the only computer this client can restart. False for every remote hub:
   * their machines' processes are not ours to cycle.
   */
  isLocalHub: boolean
  /**
   * The id THIS app's own computer has on this hub (it joins every hub the client
   * lists), or null when it has none here (yet). On the local hub it is also found by
   * its enroll name. That row is never deleted: the app would only enroll it again.
   */
  ownComputerId?: string | null
  identity: ReactNode
  status: ReactNode
  primary?: ReactNode
  more: ReactNode
  headerTestId: string
}

/**
 * The connector rail, DRAWN rather than typed.
 *
 * `├─` and `└─` were box-drawing characters in a proportional UI font: their
 * stroke weight is the font's, not the border token's, so they read lighter than
 * every other line on the card, and their arms only met the next row's by
 * coincidence of line-height. Two borders instead — same token as the card's own
 * edges, continuous down the column, and correct at any row height or zoom.
 *
 * `last` terminates the vertical at the elbow, which is the whole job of `└`.
 */
/**
 * The leading 32px of a computer row, matching the width of the header's star
 * button (`icon-sm` = `size-8`). Whatever fills it — rail or marker — the name
 * beside it therefore starts at the same x as the hub's own name one row up.
 */
function Marker() {
  return (
    <td className="text-muted-foreground/60 w-8 py-2 text-center" aria-hidden="true">
      ▣
    </td>
  )
}

function Rail({ last = false }: { last?: boolean }) {
  return (
    <td className="relative w-8" aria-hidden="true">
      <span
        className={cn(
          'border-border absolute left-3 border-l',
          // bottom-1/2 rather than h-1/2: percentage heights inside a table cell
          // depend on the cell resolving its own height, insets do not.
          last ? 'top-0 bottom-1/2' : 'inset-y-0'
        )}
      />
      <span className="border-border absolute top-1/2 left-3 w-2.5 border-t" />
    </td>
  )
}

/** Main-process supervisor state of the app's own computer — not hub-scoped. */
const LOCAL_COMPUTER_STATUS_KEY = ['local-computer-status'] as const
/** Where the app's own computer stands on each remote hub — main-process state. */
const LOCAL_COMPUTER_HUBS_KEY = ['local-computer-hubs'] as const

export function HubCard({
  hubId,
  hubLabel,
  isLocalHub,
  ownComputerId: ownComputerIdProp = null,
  identity,
  status,
  primary,
  more,
  headerTestId
}: HubCardProps) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  // The vanilla client, not the query proxy: the roots dialog lives OUTSIDE this
  // hub's scope (one instance for all hubs), so it is handed thunks bound to this
  // hub's client rather than resolving one itself. Same reason delete is a thunk.
  const trpcClient = useTRPCClient()
  const {
    showMintedToken,
    requestDelete,
    requestEditRoots,
    requestRestart,
    requestStart,
    restarting,
    computerRevision
  } = useComputerActions()

  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  // Who the computer is for (T-20): blank = yourself (every user enrolls their own);
  // naming someone else is an admin's. Always blank on a hub without login.
  const [forUser, setForUser] = useState('')

  // A hub always accepts computers, so the list is always available (no mode to
  // enable). `list` merges live connection status when a computer is connected;
  // it's a plain DB read otherwise.
  const computersQuery = useQuery({ ...trpc.computers.list.queryOptions(), refetchInterval: 5000 })

  // Connection changes push immediately; polling also refreshes independent upgrade reports. The hub already knows the moment a computer connects, drops
  // or is reaped by the heartbeat watchdog — before this the list refreshed only
  // when a human clicked refresh, so an offline computer looked connected
  // indefinitely. Invalidate rather than patch the cache: the row also carries
  // machine and ownership fields this event knows nothing about.
  useSubscription(
    trpc.computers.onStatusChange.subscriptionOptions(undefined, {
      onData: () => {
        void queryClient.invalidateQueries(trpc.computers.list.queryFilter())
        void queryClient.invalidateQueries({ queryKey: LOCAL_COMPUTER_STATUS_KEY })
      }
    })
  )
  const computers = computersQuery.data ?? []

  // Where THIS app's own computer stands on this (remote) hub — it joins every hub the
  // client lists. Main-process state, like the local computer's status below.
  const ownHubQuery = useQuery({
    queryKey: [...LOCAL_COMPUTER_HUBS_KEY],
    queryFn: () => electronBootstrap.getLocalComputerHubs(),
    enabled: !isLocalHub,
    refetchInterval: 5000
  })
  const ownOnThisHub = isLocalHub ? null : (ownHubQuery.data?.[hubId] ?? null)
  const ownComputerId = ownComputerIdProp ?? ownOnThisHub?.computerId ?? null

  const deleteMutation = useMutation(trpc.computers.delete.mutationOptions())
  const setDisabledMutation = useMutation(trpc.computers.setDisabled.mutationOptions())

  /** This app's own computer on this hub: never deleted, and on the local hub never
   *  disabled either (nothing on this machine could run without it). */
  const isOwnComputer = (computer: { id: string; name: string }): boolean =>
    computer.id === ownComputerId || (isLocalHub && computer.name === DEFAULT_LOCAL_COMPUTER_NAME)

  const toggleDisabled = async (computer: {
    id: string
    name: string
    disabledAt: number | null
  }): Promise<void> => {
    const disable = computer.disabledAt == null
    await setDisabledMutation.mutateAsync({ computerId: computer.id, disabled: disable }).then(
      () => toast.success(`${disable ? 'Disabled' : 'Enabled'} ${computer.name}`),
      // The hub says why — most often terminals or agents still running there.
      (err: unknown) => toast.error(err instanceof Error ? err.message : String(err))
    )
    void queryClient.invalidateQueries(trpc.computers.list.queryFilter())
  }
  const mintMutation = useMutation(trpc.computers.mintJoinToken.mutationOptions())

  // Refetch after the local computer is restarted/started. The computer re-dials
  // asynchronously after the spawn returns and `computers.list` does not poll, so
  // without this the list would sit on "Disconnected".
  useEffect(() => {
    if (computerRevision === 0) return
    void queryClient.invalidateQueries(trpc.computers.list.queryFilter())
  }, [computerRevision, queryClient, trpc])

  // Only meaningful on the local hub. Gated on `isSuccess` so the first render
  // (no data yet) doesn't flash "not running" at a perfectly healthy computer.
  const localComputerMissing =
    isLocalHub &&
    computersQuery.isSuccess &&
    !computers.some((r) => r.name === DEFAULT_LOCAL_COMPUTER_NAME)

  // WHY it is missing. The hub only knows the computer never enrolled; the cause —
  // it dies at startup (a native module that will not load, #165), or its join
  // token could not be minted — is with its supervisor in the main process. Keyed
  // on `computerRevision` so a Start that failed re-reads the fresh cause.
  const localStatusQuery = useQuery({
    queryKey: [...LOCAL_COMPUTER_STATUS_KEY, computerRevision],
    queryFn: () => electronBootstrap.getLocalComputerStatus(),
    enabled: localComputerMissing,
    staleTime: 0
  })
  const localStatus = localComputerMissing ? (localStatusQuery.data ?? null) : null
  const localFailure = localStatus?.lastExit?.reason ?? localStatus?.unspawnedReason ?? null

  const mint = async (): Promise<void> => {
    try {
      const res = await mintMutation.mutateAsync({
        label: label.trim() || 'computer',
        ...(forUser.trim() ? { forUser: forUser.trim() } : {})
      })
      showMintedToken({ token: res.token, hubLabel, hubUrl: res.hubUrl })
      setLabel('')
      setForUser('')
      setAdding(false)
      void queryClient.invalidateQueries(trpc.computers.list.queryFilter())
      toast.success('Enrollment token created')
    } catch (err) {
      toast.error(`Could not create token: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // First load only — a background refetch keeps the current rows on screen
  // rather than replacing a live list with placeholders.
  const firstLoad = !computersQuery.isSuccess && !computersQuery.isError

  /**
   * THE LOCAL HUB'S COMPUTER SET IS A SINGLETON — exactly one computer, the app's own
   * supervised child, spawned and enrolled at boot. A machine you point at a hub
   * is a computer for a hub OTHER machines can reach, which a local hub is not: a
   * token minted here carries a loopback dial address, redeemable only by
   * something already on this machine, where that one computer already is.
   *
   * Every piece of list chrome presupposes more than one, so none of it renders
   * here: no rail to branch, no plural "Computers" heading, no refresh-the-LIST
   * button, no add leaf. What remains is the computer row itself, laid out exactly
   * as a remote hub's rows are — the row is the same, only the scaffolding it
   * doesn't need is gone.
   *
   * Remote hubs keep all of it; that is the case it was built for.
   */
  const singleComputer = isLocalHub
  const canEnroll = !singleComputer

  /**
   * The rail's terminator belongs to whichever leaf renders LAST, and that is no
   * longer always the add leaf — a local card has none. Resolved once here rather
   * than guessed per row, so the elbow can't end up on two rows or none.
   */
  const lastLeaf: 'add' | 'missing' | 'computer' | 'skeleton' = canEnroll
    ? 'add'
    : localComputerMissing
      ? 'missing'
      : computers.length > 0
        ? 'computer'
        : 'skeleton'

  /**
   * The heading's note — only for the states that are NOT a list of rows. With
   * rows on screen a count would restate what is already visible; while loading,
   * the skeleton says it better than a word does. What remains must each be named,
   * since an unreachable hub reporting "none enrolled" would be a false claim
   * about that hub's configuration rather than a description of a failed request.
   */
  const note = (): string | undefined => {
    if (computersQuery.isError) return 'could not reach this hub'
    if (firstLoad) return undefined
    if (computers.length === 0 && !localComputerMissing) return 'none enrolled'
    return undefined
  }

  /**
   * `computers.list` does not poll — connection status is whatever it was when the
   * query last ran. Without this, a computer that reconnected is indistinguishable
   * from one that is still down until something else happens to invalidate.
   */
  const refresh = (
    <IconButton
      size="icon-sm"
      variant="ghost"
      aria-label="Refresh computer status"
      title="Re-check which computers are connected"
      disabled={computersQuery.isFetching}
      onClick={() => void computersQuery.refetch()}
      data-testid="computer-refresh"
    >
      <RefreshCw className={cn('size-3.5', computersQuery.isFetching && 'animate-spin')} />
    </IconButton>
  )

  return (
    <HubCardShell
      hubId={hubId}
      headerTestId={headerTestId}
      identity={identity}
      status={status}
      primary={primary}
      more={more}
      headerAction={singleComputer ? undefined : refresh}
      body={
        <>
          {singleComputer ? (
            // No heading and no list-refresh on a one-computer hub, but the states
            // that are NOT a row still have to be said out loud — an unreachable
            // hub must not simply render nothing.
            note() ? (
              <p className="text-muted-foreground pb-1 text-xs" data-testid="hub-computers-summary">
                {note()}
              </p>
            ) : null
          ) : (
            <ComputersHeading note={note()} noteTestId="hub-computers-summary" />
          )}
          {/* `table-fixed`: with no column headers the values are the only thing
              setting width, so auto layout would re-flow the whole rail whenever a
              computer name changed length. */}
          <table className="w-full table-fixed text-sm" data-testid="computers-table">
            <tbody>
              {firstLoad && (
                <>
                  <SkeletonRow rail={!singleComputer} />
                  <SkeletonRow rail={!singleComputer} last={lastLeaf === 'skeleton'} />
                </>
              )}
              {computers.map((computer, i) => (
                <tr key={computer.id} data-testid="computer-row">
                  {singleComputer ? (
                    <Marker />
                  ) : (
                    <Rail last={lastLeaf === 'computer' && i === computers.length - 1} />
                  )}
                  {/* Name then muted meta on one line — the same shape as the
                      hub's own `Local  this machine` directly above. Three equal
                      columns spread the same facts across the width and made the
                      two rows read as unrelated tables. */}
                  <td className="py-2 pr-3 pl-2">
                    <div
                      className={cn(
                        'flex min-w-0 items-center gap-2',
                        computer.disabledAt != null && 'opacity-60'
                      )}
                    >
                      <ComputerName
                        computer={computer}
                        renamable={!(isLocalHub && isOwnComputer(computer))}
                      />
                      {/* On a remote hub, which row is this app's own computer — the
                          one it joined there and will not delete. */}
                      {!isLocalHub && isOwnComputer(computer) && (
                        <span
                          className="text-muted-foreground shrink-0 text-xs"
                          data-testid="computer-own"
                        >
                          this computer
                        </span>
                      )}
                      <span className="text-muted-foreground truncate font-mono text-xs">
                        {computer.platform}
                      </span>
                      {/* Which physical box. Repeats across rows that share one,
                          which is what makes the grouping visible without adding a
                          header to the common one-computer-per-machine case. */}
                      <MachineLabel machine={computer.machine ?? null} />
                      {/* Only a DIFFERENCE from the standard set: every default
                          computer reports the same four, so listing them said nothing. */}
                      {capabilityNote(computer.capabilities) && (
                        <span
                          className="text-muted-foreground truncate text-xs"
                          title={computer.capabilities.join(', ') || 'No capabilities'}
                          data-testid="computer-capabilities"
                        >
                          {capabilityNote(computer.capabilities)}
                        </span>
                      )}
                    </div>
                    <OutdatedNote computer={computer} />
                    <ComputerFaults computerId={computer.id} />
                  </td>
                  {/* The same component the hub header uses, so the dot, the
                      truncation and the tone are identical rather than merely
                      similar. */}
                  <td className="w-32 py-2 pr-3">
                    {/* Connection and upgrade as ONE field: an upgrade is a state
                        of the computer, and steady state (up to date) says nothing. */}
                    <HubStatus
                      tone={computerRowStatus(computer).tone}
                      label={computerRowStatus(computer).label}
                      detail={computerRowStatus(computer).detail}
                      title={
                        computer.upgradeStatus
                          ? `${computerRowStatus(computer).label} · ${computerUpgradeTitle(computer.upgradeStatus)}`
                          : computerRowStatus(computer).label
                      }
                    />
                  </td>
                  <td className={ROW_ACTIONS}>
                    <div className="flex items-center justify-end">
                      {/* Which folders this computer may touch. Offered for EVERY
                        computer, local included: the app's filesystem work now runs
                        on the computer that owns the workspace, so a project outside
                        these roots is one the UI genuinely cannot open — and the
                        local computer's default jail is only $HOME. */}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Folders this computer may access"
                        onClick={() =>
                          requestEditRoots({
                            id: computer.id,
                            name: computer.name,
                            load: () =>
                              trpcClient.workspace.listRoots.query({ computerId: computer.id }),
                            save: (roots) =>
                              trpcClient.workspace.setAllowedRoots.mutate({
                                computerId: computer.id,
                                roots
                              })
                          })
                        }
                        data-testid="computer-edit-roots"
                      >
                        <FolderCog className="size-3.5" />
                      </Button>
                      {/* The app's OWN supervised child — the one computer it can cycle
                        as a process. Restarting kills every agent pty on this
                        machine, so the provider gates it behind a confirm. */}
                      {isLocalHub && computer.name === DEFAULT_LOCAL_COMPUTER_NAME && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={restarting}
                          title="Restart local computer (stops running agents + terminals; reconnects automatically)"
                          onClick={requestRestart}
                          data-testid="computer-local-restart"
                        >
                          <RotateCw className={cn('size-3.5', restarting && 'animate-spin')} />
                        </Button>
                      )}
                      {/* Disable: kept and connected, but given no new work. Every
                        computer except the app's own on the local hub, without which
                        nothing on this machine could run. The hub refuses while
                        terminals or agents run there, and says so. */}
                      {!(isLocalHub && isOwnComputer(computer)) && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={setDisabledMutation.isPending}
                          title={
                            computer.disabledAt != null
                              ? 'Enable — let this computer take work again'
                              : 'Disable — keep this computer, but send it no new work'
                          }
                          aria-pressed={computer.disabledAt != null}
                          onClick={() => void toggleDisabled(computer)}
                          data-testid={
                            computer.disabledAt != null ? 'computer-enable' : 'computer-disable'
                          }
                        >
                          {computer.disabledAt != null ? (
                            <Power className="size-3.5" />
                          ) : (
                            <PowerOff className="size-3.5" />
                          )}
                        </Button>
                      )}
                      {/* The app's own computer is never deleted, on any hub: the app
                        joins every hub it lists, so it would only enroll it again —
                        and on the local hub nothing on this machine could run until
                        it did. Disable it instead. Every OTHER computer can go. */}
                      {!isOwnComputer(computer) && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Delete this computer from the hub"
                          onClick={() =>
                            requestDelete({
                              id: computer.id,
                              name: computer.name,
                              // Closed over this hub's mutation + QueryClient, so a
                              // delete cannot be routed to the wrong hub.
                              remove: async () => {
                                await deleteMutation.mutateAsync({ computerId: computer.id })
                                void queryClient.invalidateQueries(
                                  trpc.computers.list.queryFilter()
                                )
                              }
                            })
                          }
                          data-testid="computer-delete"
                        >
                          <Trash2 className="text-destructive size-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}

              {/* This app's own computer could not join this remote hub (not signed in
                  there, the hub refused a token, it has no public address). Said
                  here, where its row would be, with the hub's reason. */}
              {ownOnThisHub?.state === 'failed' &&
                !computers.some((c) => c.id === ownOnThisHub.computerId) && (
                  <tr data-testid="computer-own-join-failed">
                    <Rail />
                    <td className="py-2 pr-3 pl-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="text-muted-foreground shrink-0 text-sm font-medium">
                          This computer
                        </span>
                        <span className="text-muted-foreground truncate text-xs">
                          not on this hub
                        </span>
                      </div>
                      {ownOnThisHub.error && (
                        <div className="text-destructive mt-1 text-xs break-words select-text">
                          {ownOnThisHub.error}
                        </div>
                      )}
                    </td>
                    <td className="w-32 py-2 pr-3">
                      <HubStatus tone="bad" label="Could not join" />
                    </td>
                    <td className={ROW_ACTIONS} />
                  </tr>
                )}

              {/* No local computer on the local hub = nothing on this machine can
                  execute: agents, terminals and git work all run on computers.
                  Reachable when the boot-time join-token mint fails (diagnostic
                  `local_computer.unspawned`), which used to be recoverable only by
                  relaunching the app. */}
              {localComputerMissing && (
                <tr data-testid="computer-local-missing">
                  {singleComputer ? (
                    <td className="text-destructive/70 w-8 py-2 text-center" aria-hidden="true">
                      ⨯
                    </td>
                  ) : (
                    <Rail last={lastLeaf === 'missing'} />
                  )}
                  <td className="py-2 pr-3 pl-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="text-muted-foreground shrink-0 text-sm font-medium">
                        Local computer
                      </span>
                      <span className="text-muted-foreground truncate text-xs">
                        agents, terminals and git work all run on computers
                      </span>
                    </div>
                    {localFailure && (
                      // Wraps rather than truncates: the cause is usually one long
                      // line (a dlopen error naming the missing GLIBC version), and
                      // its tail is the part that says what to do. Selectable so it
                      // can be pasted into an issue.
                      <div
                        className="text-destructive mt-1 font-mono text-xs break-all select-text"
                        data-testid="computer-local-failure"
                      >
                        {localFailure}
                      </div>
                    )}
                  </td>
                  <td className="w-32 py-2 pr-3">
                    <HubStatus
                      tone="bad"
                      label={localStatus?.stalled ? 'Failed' : 'Not running'}
                      title={
                        localStatus?.stalled === 'needs-re-enrollment'
                          ? 'The hub no longer recognizes this computer — Start enrolls it again'
                          : localStatus?.stalled === 'backoff-exhausted'
                            ? 'It kept exiting at startup, so restarts stopped — Start tries again'
                            : undefined
                      }
                    />
                  </td>
                  <td className={cn(ROW_ACTIONS, 'text-right')}>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={restarting}
                      title="Start the local computer"
                      onClick={requestStart}
                      data-testid="computer-local-start"
                    >
                      {restarting ? <RotateCw className="mr-1 size-3.5 animate-spin" /> : null}
                      Start
                    </Button>
                  </td>
                </tr>
              )}

              {/* Last leaf: enrolling is an operation INSIDE this hub, and sits
                  where the computer it creates will appear. Absent on the local hub
                  — see `canEnroll`. */}
              {canEnroll && (
                <tr data-testid="computer-add-row">
                  <Rail last />
                  <td colSpan={3} className="py-1">
                    {adding ? (
                      <>
                        <div className="flex items-center gap-2">
                          <Input
                            value={label}
                            onChange={(e) => setLabel(e.target.value)}
                            placeholder="Computer label (e.g. office-mac)"
                            disabled={mintMutation.isPending}
                            className="max-w-xs"
                            data-testid="computer-enroll-label"
                          />
                          <Input
                            value={forUser}
                            onChange={(e) => setForUser(e.target.value)}
                            placeholder="For user (email) — blank: you"
                            disabled={mintMutation.isPending}
                            className="max-w-xs"
                            data-testid="computer-enroll-for"
                          />
                          <Button
                            variant="outline"
                            disabled={mintMutation.isPending}
                            onClick={() => {
                              void mint()
                            }}
                            data-testid="computer-add"
                          >
                            {mintMutation.isPending ? (
                              <Loader2 className="mr-2 size-4 animate-spin" />
                            ) : null}
                            Add a computer
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={mintMutation.isPending}
                            onClick={() => {
                              setAdding(false)
                              setLabel('')
                              setForUser('')
                            }}
                            data-testid="computer-add-cancel"
                          >
                            <X className="size-4" />
                          </Button>
                        </div>
                        <p className="text-muted-foreground mt-2 text-xs">
                          Mint a one-time enrollment token for{' '}
                          <span className="text-foreground">{hubLabel || 'this hub'}</span> and
                          paste it into the computer machine&apos;s config. The token embeds that
                          hub&apos;s address, and expires after 15 minutes. On a hub with sign-in,
                          name the user the computer is for: it becomes theirs.
                        </p>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setAdding(true)}
                        className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm"
                        data-testid="computer-add-open"
                      >
                        <Plus className="size-4" />
                        Add computer
                      </button>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {/* The hub's own (backups, erasure, project sync): admin only, else nothing. */}
          <ComputerFaults computerId={null} title="This hub needs attention" />
          <HubUsersSection />
        </>
      }
    />
  )
}

/** A computer whose release cannot confirm chat writes: which, and what to do. */
function OutdatedNote({ computer }: { computer: { name: string; version?: string | null } }) {
  const note = outdatedComputerNote(computer)
  if (!note) return null
  return (
    <div data-testid="computer-outdated" className="text-destructive mt-0.5 text-xs">
      {note}
    </div>
  )
}
