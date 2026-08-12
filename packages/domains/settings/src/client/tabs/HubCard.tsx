import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC, useTRPCClient } from '@slayzone/transport/client'
// Leaf subpath, deliberately not `@slayzone/platform/slayzone-config`: that one
// imports node:fs/node:path, which rollup externalizes out of the renderer bundle
// and then fails to resolve. Same constant, browser-safe module.
import { DEFAULT_LOCAL_RUNNER_NAME } from '@slayzone/platform/runner-identity'
import { Button, IconButton, Input, Skeleton, cn, toast } from '@slayzone/ui'
import { FolderCog, Loader2, Plus, RefreshCw, RotateCw, Trash2, X } from 'lucide-react'
import { useRunnerActions } from './RunnerActions'

/**
 * A hub, as a card that owns its runners.
 *
 * WHY NESTED. A runner belongs to exactly ONE hub, and which hub is decided when
 * the token is MINTED — the token embeds that hub's dial URL and TLS fingerprint.
 * Listing runners inside their hub makes that containment the shape of the UI, so
 * the enrollment affordance's POSITION is the hub choice: no picker, and no way to
 * mint a token against a hub the operator didn't mean.
 *
 * WHY A RAIL. The card border alone did not carry it: a bare column grid under a
 * hub row reads as that hub's own properties, because every column header
 * (Name/Platform/Status) is generic. Runners hang off an indented connector
 * instead, under a "Runners" heading, with ＋ Add runner as the LAST LEAF — so
 * enrolling is visibly an operation inside this hub rather than a page action.
 * Column headers are gone with it; the values (`darwin-arm64`, `pty, git`) label
 * themselves, and the heading names the rows once.
 *
 * WHY THE CARD LIVES HERE rather than in `HubsSettingsTab`. The body is the runner
 * list and only this component can query it, so the hub's own identity/controls
 * come in as slots. `HubCardShell` is the shared chrome, exported for the hubs
 * that CANNOT have a runner list at all (see `HubsSettingsTab.hubCardFor`).
 *
 * WHY A SEPARATE COMPONENT FROM THE TAB. `useTRPC()` resolves to the nearest
 * provider, so one component cannot query more than one hub with hooks. Mounted
 * once per hub inside `<HubScope hubId>`, each copy gets its own tRPC client +
 * QueryClient and uses ORDINARY `useQuery`/`useMutation` — no vanilla-client
 * plumbing, no manual cancellation, per-hub loading/error for free.
 *
 * The load-bearing consequence is that BOTH mutations here — mint and revoke — are
 * created inside the hub's own scope, so they are bound to the hub that owns this
 * card by CONSTRUCTION. The alternative (one flat table routing by an id→hub map)
 * makes the same correctness a lookup that can silently go stale.
 *
 * THE LOCAL RUNNER is the one row this client can control as a PROCESS rather than
 * as a registry entry: it is the app's own supervised child. So on the local hub
 * only, its row carries a restart action, and its ABSENCE gets a leaf of its own —
 * a local hub with no local runner cannot execute anything at all, and that state
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
  /** The card body — the runners area. */
  body: ReactNode
}

export function HubCardShell({
  hubId,
  headerTestId,
  identity,
  status,
  primary,
  more,
  body
}: HubCardShellProps) {
  return (
    <div
      className="border-border bg-card rounded-lg border"
      data-testid={`hub-group-${hubId}`}
      data-hub-id={hubId}
    >
      {/* The header is the HUB's alone. Nothing runner-derived sits here — a count
          beside the hub's own address reads as a property of the hub, and the rows
          below state it anyway. */}
      {/* NO gap between the slots — the runner rows below are table cells, which
          have no gaps to mirror, so a gap here would offset every column by the
          accumulated 8px and the two rows would never line up. Spacing lives
          inside the slots (their fixed widths) instead. */}
      <div className="flex items-center px-3 py-2.5" data-testid={headerTestId}>
        <div className="flex min-w-0 flex-1 items-center gap-2">{identity}</div>
        <div className="w-32 shrink-0">{status}</div>
        <div className="flex w-24 shrink-0 justify-end">{primary}</div>
        <div className="flex w-8 shrink-0 justify-end">{more}</div>
      </div>
      <div className="border-border/60 border-t px-3 py-2">{body}</div>
    </div>
  )
}

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
  title
}: {
  tone: HubStatusTone
  label: string
  title?: string
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs" title={title} data-testid="hub-status">
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
      <span
        className={cn('truncate', tone === 'bad' ? 'text-destructive' : 'text-muted-foreground')}
      >
        {label}
      </span>
    </span>
  )
}

/**
 * "Runners", plus an optional note for the states that are NOT a list of rows.
 *
 * Shared with the hubs that cannot be queried at all, so every card names what its
 * body is about — even when that body is one line of explanation.
 */
export function RunnersHeading({
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
      <span className="text-muted-foreground text-xs font-medium">Runners</span>
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
    <tr data-testid="runner-row-skeleton">
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
      <td className="w-24 py-2" />
      <td className="w-8" />
    </tr>
  )
}

export interface HubCardProps {
  /** The hub this card is for (also the ambient HubScope's id). */
  hubId: string
  /** Display label, used when naming the hub a freshly minted token points at. */
  hubLabel: string
  /**
   * This hub is the LOCAL one — i.e. its runners include the app's own supervised
   * child, the only runner this client can restart. False for every remote hub:
   * their machines' processes are not ours to cycle.
   */
  isLocalHub: boolean
  identity: ReactNode
  status: ReactNode
  primary?: ReactNode
  more: ReactNode
  headerTestId: string
}

/**
 * Connection state and last-seen as ONE field.
 *
 * They were two columns, and for a connected runner both read "Connected" — the
 * second carried information only while disconnected. Merged, the cell always
 * answers "can this take work right now, and if not, when did it last check in".
 */
function statusText(row: { connected: boolean; lastSeenAt: number | null }): string {
  if (row.connected) return 'Connected'
  if (row.lastSeenAt == null) return 'Never connected'
  return `Last seen ${new Date(row.lastSeenAt).toLocaleString()}`
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
 * The leading 32px of a runner row, matching the width of the header's star
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

export function HubCard({
  hubId,
  hubLabel,
  isLocalHub,
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
  // hub's client rather than resolving one itself. Same reason revoke is a thunk.
  const trpcClient = useTRPCClient()
  const {
    showMintedToken,
    requestRevoke,
    requestEditRoots,
    requestRestart,
    requestStart,
    restarting,
    runnerRevision
  } = useRunnerActions()

  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')

  // A hub always accepts runners, so the list is always available (no mode to
  // enable). `list` merges live connection status when a runner is connected;
  // it's a plain DB read otherwise.
  const runnersQuery = useQuery(trpc.computers.list.queryOptions())
  const runners = runnersQuery.data ?? []

  const revokeMutation = useMutation(trpc.computers.revokeRunner.mutationOptions())
  const mintMutation = useMutation(trpc.computers.mintJoinToken.mutationOptions())

  // Refetch after the local runner is restarted/started. The runner re-dials
  // asynchronously after the spawn returns and `runners.list` does not poll, so
  // without this the list would sit on "Disconnected".
  useEffect(() => {
    if (runnerRevision === 0) return
    void queryClient.invalidateQueries(trpc.computers.list.queryFilter())
  }, [runnerRevision, queryClient, trpc])

  // Only meaningful on the local hub. Gated on `isSuccess` so the first render
  // (no data yet) doesn't flash "not running" at a perfectly healthy runner.
  const localRunnerMissing =
    isLocalHub &&
    runnersQuery.isSuccess &&
    !runners.some((r) => r.name === DEFAULT_LOCAL_RUNNER_NAME)

  const mint = async (): Promise<void> => {
    try {
      const res = await mintMutation.mutateAsync({ label: label.trim() || 'runner' })
      showMintedToken({ token: res.token, hubLabel, hubUrl: res.hubUrl })
      setLabel('')
      setAdding(false)
      void queryClient.invalidateQueries(trpc.computers.list.queryFilter())
      toast.success('Enrollment token created')
    } catch (err) {
      toast.error(`Could not create token: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // First load only — a background refetch keeps the current rows on screen
  // rather than replacing a live list with placeholders.
  const firstLoad = !runnersQuery.isSuccess && !runnersQuery.isError

  /**
   * THE LOCAL HUB'S RUNNER SET IS A SINGLETON — exactly one runner, the app's own
   * supervised child, spawned and enrolled at boot. A machine you point at a hub
   * is a runner for a hub OTHER machines can reach, which a local hub is not: a
   * token minted here carries a loopback dial address, redeemable only by
   * something already on this machine, where that one runner already is.
   *
   * Every piece of list chrome presupposes more than one, so none of it renders
   * here: no rail to branch, no plural "Runners" heading, no refresh-the-LIST
   * button, no add leaf. What remains is the runner row itself, laid out exactly
   * as a remote hub's rows are — the row is the same, only the scaffolding it
   * doesn't need is gone.
   *
   * Remote hubs keep all of it; that is the case it was built for.
   */
  const singleRunner = isLocalHub
  const canEnroll = !singleRunner

  /**
   * The rail's terminator belongs to whichever leaf renders LAST, and that is no
   * longer always the add leaf — a local card has none. Resolved once here rather
   * than guessed per row, so the elbow can't end up on two rows or none.
   */
  const lastLeaf: 'add' | 'missing' | 'runner' | 'skeleton' = canEnroll
    ? 'add'
    : localRunnerMissing
      ? 'missing'
      : runners.length > 0
        ? 'runner'
        : 'skeleton'

  /**
   * The heading's note — only for the states that are NOT a list of rows. With
   * rows on screen a count would restate what is already visible; while loading,
   * the skeleton says it better than a word does. What remains must each be named,
   * since an unreachable hub reporting "none enrolled" would be a false claim
   * about that hub's configuration rather than a description of a failed request.
   */
  const note = (): string | undefined => {
    if (runnersQuery.isError) return 'could not reach this hub'
    if (firstLoad) return undefined
    if (runners.length === 0 && !localRunnerMissing) return 'none enrolled'
    return undefined
  }

  /**
   * `runners.list` does not poll — connection status is whatever it was when the
   * query last ran. Without this, a runner that reconnected is indistinguishable
   * from one that is still down until something else happens to invalidate.
   */
  const refresh = (
    <IconButton
      size="icon-sm"
      variant="ghost"
      aria-label="Refresh runner status"
      title="Re-check which runners are connected"
      disabled={runnersQuery.isFetching}
      onClick={() => void runnersQuery.refetch()}
      data-testid="runner-refresh"
    >
      <RefreshCw className={cn('size-3.5', runnersQuery.isFetching && 'animate-spin')} />
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
      body={
        <>
          {singleRunner ? (
            // No heading and no list-refresh on a one-runner hub, but the states
            // that are NOT a row still have to be said out loud — an unreachable
            // hub must not simply render nothing.
            note() ? (
              <p className="text-muted-foreground pb-1 text-xs" data-testid="hub-runners-summary">
                {note()}
              </p>
            ) : null
          ) : (
            <RunnersHeading note={note()} noteTestId="hub-runners-summary" action={refresh} />
          )}
          {/* `table-fixed`: with no column headers the values are the only thing
              setting width, so auto layout would re-flow the whole rail whenever a
              runner name changed length. */}
          <table className="w-full table-fixed text-sm" data-testid="runners-table">
            <tbody>
              {firstLoad && (
                <>
                  <SkeletonRow rail={!singleRunner} />
                  <SkeletonRow rail={!singleRunner} last={lastLeaf === 'skeleton'} />
                </>
              )}
              {runners.map((runner, i) => (
                <tr key={runner.id} data-testid="runner-row">
                  {singleRunner ? (
                    <Marker />
                  ) : (
                    <Rail last={lastLeaf === 'runner' && i === runners.length - 1} />
                  )}
                  {/* Name then muted meta on one line — the same shape as the
                      hub's own `Local  this machine` directly above. Three equal
                      columns spread the same facts across the width and made the
                      two rows read as unrelated tables. */}
                  <td className="py-2 pr-3 pl-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 text-sm font-medium">{runner.name}</span>
                      <span className="text-muted-foreground truncate font-mono text-xs">
                        {runner.platform}
                      </span>
                      <span className="text-muted-foreground truncate text-xs">
                        {runner.capabilities.length > 0 ? runner.capabilities.join(', ') : '—'}
                      </span>
                    </div>
                  </td>
                  {/* The same component the hub header uses, so the dot, the
                      truncation and the tone are identical rather than merely
                      similar. */}
                  <td className="w-32 py-2 pr-3">
                    <HubStatus
                      tone={runner.connected ? 'ok' : 'idle'}
                      label={statusText(runner)}
                      title={statusText(runner)}
                    />
                  </td>
                  <td className="w-24 py-2 text-right">
                    {/* Which folders this runner may touch. Offered for EVERY
                        runner, local included: the app's filesystem work now runs
                        on the runner that owns the workspace, so a project outside
                        these roots is one the UI genuinely cannot open — and the
                        local runner's default jail is only $HOME. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Folders this runner may access"
                      onClick={() =>
                        requestEditRoots({
                          id: runner.id,
                          name: runner.name,
                          load: () => trpcClient.workspace.listRoots.query({ runnerId: runner.id }),
                          save: (roots) =>
                            trpcClient.workspace.setAllowedRoots.mutate({
                              runnerId: runner.id,
                              roots
                            })
                        })
                      }
                      data-testid="runner-edit-roots"
                    >
                      <FolderCog className="size-3.5" />
                    </Button>
                    {/* The app's OWN supervised child — the one runner it can cycle
                        as a process. Restarting kills every agent pty on this
                        machine, so the provider gates it behind a confirm. */}
                    {isLocalHub && runner.name === DEFAULT_LOCAL_RUNNER_NAME && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={restarting}
                        title="Restart local runner (stops running agents + terminals; reconnects automatically)"
                        onClick={requestRestart}
                        data-testid="runner-local-restart"
                      >
                        <RotateCw className={cn('size-3.5', restarting && 'animate-spin')} />
                      </Button>
                    )}
                    {/* The app's own supervised runner is NOT revocable. Revoking
                        it would delete the credential the app re-dials with, and
                        nothing on this machine could execute until a relaunch
                        re-enrolled one — a one-click way to break the install with
                        no corresponding way to undo it. Every OTHER runner on this
                        hub keeps its revoke, including ones enrolled before the
                        local hub stopped offering enrollment. */}
                    {!(isLocalHub && runner.name === DEFAULT_LOCAL_RUNNER_NAME) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          requestRevoke({
                            id: runner.id,
                            name: runner.name,
                            // Closed over this hub's mutation + QueryClient, so a
                            // revoke cannot be routed to the wrong hub.
                            revoke: async () => {
                              await revokeMutation.mutateAsync({ runnerId: runner.id })
                              void queryClient.invalidateQueries(trpc.computers.list.queryFilter())
                            }
                          })
                        }
                        data-testid="runner-revoke"
                      >
                        <Trash2 className="text-destructive size-3.5" />
                      </Button>
                    )}
                  </td>
                  {/* Mirrors the header's `⋯` slot, so a row's action column ends
                      exactly where the hub's primary action does. */}
                  <td className="w-8" />
                </tr>
              ))}

              {/* No local runner on the local hub = nothing on this machine can
                  execute: agents, terminals and git work all run on runners.
                  Reachable when the boot-time join-token mint fails (diagnostic
                  `local_runner.unspawned`), which used to be recoverable only by
                  relaunching the app. */}
              {localRunnerMissing && (
                <tr data-testid="runner-local-missing">
                  {singleRunner ? (
                    <td className="text-destructive/70 w-8 py-2 text-center" aria-hidden="true">
                      ⨯
                    </td>
                  ) : (
                    <Rail last={lastLeaf === 'missing'} />
                  )}
                  <td className="py-2 pr-3 pl-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="text-muted-foreground shrink-0 text-sm font-medium">
                        Local runner
                      </span>
                      <span className="text-muted-foreground truncate text-xs">
                        agents, terminals and git work all run on runners
                      </span>
                    </div>
                  </td>
                  <td className="w-32 py-2 pr-3">
                    <HubStatus tone="bad" label="Not running" />
                  </td>
                  <td className="w-24 py-2 text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={restarting}
                      title="Start the local runner"
                      onClick={requestStart}
                      data-testid="runner-local-start"
                    >
                      {restarting ? <RotateCw className="mr-1 size-3.5 animate-spin" /> : null}
                      Start
                    </Button>
                  </td>
                  <td className="w-8" />
                </tr>
              )}

              {/* Last leaf: enrolling is an operation INSIDE this hub, and sits
                  where the runner it creates will appear. Absent on the local hub
                  — see `canEnroll`. */}
              {canEnroll && (
                <tr data-testid="runner-add-row">
                  <Rail last />
                  <td colSpan={4} className="py-1">
                    {adding ? (
                      <>
                        <div className="flex items-center gap-2">
                          <Input
                            value={label}
                            onChange={(e) => setLabel(e.target.value)}
                            placeholder="Runner label (e.g. office-mac)"
                            disabled={mintMutation.isPending}
                            className="max-w-xs"
                            data-testid="runner-enroll-label"
                          />
                          <Button
                            variant="outline"
                            disabled={mintMutation.isPending}
                            onClick={() => {
                              void mint()
                            }}
                            data-testid="runner-add"
                          >
                            {mintMutation.isPending ? (
                              <Loader2 className="mr-2 size-4 animate-spin" />
                            ) : null}
                            Add a runner
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={mintMutation.isPending}
                            onClick={() => {
                              setAdding(false)
                              setLabel('')
                            }}
                            data-testid="runner-add-cancel"
                          >
                            <X className="size-4" />
                          </Button>
                        </div>
                        <p className="text-muted-foreground mt-2 text-xs">
                          Mint a one-time enrollment token for{' '}
                          <span className="text-foreground">{hubLabel || 'this hub'}</span> and
                          paste it into the runner machine&apos;s config. The token embeds that
                          hub&apos;s address and TLS fingerprint, and expires after 15 minutes.
                        </p>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setAdding(true)}
                        className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm"
                        data-testid="runner-add-open"
                      >
                        <Plus className="size-4" />
                        Add runner
                      </button>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      }
    />
  )
}

