// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'

/**
 * One hub's runner block — the list, enrollment, revoke, and the local-runner
 * process controls.
 *
 * The block is mounted per hub inside that hub's `<HubScope>`, so everything it
 * does is hub-scoped by construction. These tests stand in for that scope by
 * stamping a hub id onto the mocked tRPC builders (`__hub`) and routing the
 * mutation spies by it — which is what lets the "two blocks, two hubs" cases below
 * prove that a mint or revoke cannot leak to the wrong hub.
 */

type MockRunner = {
  id: string
  name: string
  platform: string
  capabilities: string[]
  connected: boolean
  connectedAt: number | null
  lastSeenAt: number | null
  createdAt: number
}

/** Per-hub runner lists, keyed by hub id. */
let runnersByHub: Record<string, MockRunner[]> = {}
/** Query lifecycle, so the loading / error / empty summaries can be exercised. */
let queryState: 'success' | 'loading' | 'error' = 'success'

const mintSpy = vi.fn(() =>
  Promise.resolve({
    token: 'szjt1.MOCKTOKEN',
    label: 'x',
    hubUrl: 'ws://127.0.0.1:51100/computers'
  } as any)
)
const revokeSpy = vi.fn(() => Promise.resolve({ ok: true as const }))
const remoteMintSpy = vi.fn((_input: any, hub?: string) =>
  Promise.resolve({
    token: 'szjt1.REMOTETOKEN',
    label: 'x',
    // 'hub-lo' stands for a hub whose dial address is loopback — legitimate when
    // the runner is co-located, and the case the token dialog must warn about.
    hubUrl:
      hub === 'hub-lo' ? 'ws://127.0.0.1:51100/computers' : 'wss://hub-b.example.com:8443/computers'
  } as any)
)
const remoteRevokeSpy = vi.fn(() => Promise.resolve({ ok: true as const }))

/**
 * The local runner is cycled over the DESKTOP BRIDGE, not tRPC — it is a child of
 * the main process, which the hub has no handle on.
 */
const restartLocalRunnerSpy = vi.fn(() => Promise.resolve({ ok: true as const }))

/** The manual "re-check which runners are connected" round trip. */
const refetchSpy = vi.fn(() => Promise.resolve({} as any))

/** Reads/writes of a runner's filesystem path-jail, tagged with the asking hub. */
const editRootsSpy = vi.fn(
  (_call: { op: 'load' | 'save'; hub: string; runnerId: string; roots?: string[] }) => {}
)

/** Which hub's subtree is rendering — set by the test's `<Scope>` wrapper. */
let renderingHubId = 'local'

vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => {
    const hub = renderingHubId
    return {
      computers: {
        list: { queryOptions: () => ({ __hub: hub }), queryFilter: () => ({ __hub: hub }) },
        mintJoinToken: { mutationOptions: () => ({ __key: 'mint', __hub: hub }) },
        revokeRunner: { mutationOptions: () => ({ __key: 'revoke', __hub: hub }) }
      }
    }
  },
  // The vanilla client, used only for the allowed-roots dialog's thunks. Tagged
  // with the rendering hub for the same reason the query proxy is: an edit made
  // from one hub's card must not read or write another hub's runner.
  useTRPCClient: () => {
    const hub = renderingHubId
    return {
      workspace: {
        listRoots: {
          query: (input: { runnerId: string }) => {
            editRootsSpy({ op: 'load', hub, runnerId: input.runnerId })
            return Promise.resolve({ roots: ['/home/kalle'], home: '/home/kalle' })
          }
        },
        setAllowedRoots: {
          mutate: (input: { runnerId: string; roots: string[] }) => {
            editRootsSpy({ op: 'save', hub, runnerId: input.runnerId, roots: input.roots })
            return Promise.resolve({ roots: input.roots, rejected: [] })
          }
        }
      }
    }
  },
  electronBootstrap: { restartLocalRunner: () => restartLocalRunnerSpy() }
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: {
    __hub?: string
    __queryFn?: () => unknown
    queryFn?: () => Promise<unknown>
    enabled?: boolean
  }) => {
    // Hooks FIRST, unconditionally. This mock serves three query shapes and an
    // early return above these would make the hook order depend on which shape
    // arrived — the exact rule React enforces, and it fires in a mock as readily
    // as in a component.
    const [data, setData] = React.useState<unknown>(undefined)
    const started = React.useRef(false)

    // A synchronous canned answer (git readiness). Settled immediately so the
    // marker renders in the same tick the row does.
    if (opts?.__queryFn) {
      return {
        data: opts.enabled === false ? undefined : opts.__queryFn(),
        isSuccess: true,
        isError: false,
        isPending: false
      }
    }
    // A plain-`queryFn` query (the allowed-roots dialog) is driven by its own
    // thunk, not by the runner roster. Running it is the point: the thunk is what
    // binds the read to a specific hub's client, which is exactly what the
    // per-hub routing assertion checks.
    if (opts?.queryFn) {
      if (opts.enabled !== false && !started.current) {
        started.current = true
        void opts.queryFn().then(setData)
      }
      return { data, isSuccess: data !== undefined, isError: false, isPending: data === undefined }
    }
    return {
      data: (opts?.__hub !== undefined ? runnersByHub[opts.__hub] : undefined) ?? [],
      isSuccess: queryState === 'success',
      isError: queryState === 'error',
      isFetching: queryState === 'loading',
      // Records WHICH hub asked, so a refresh can be shown not to fan out.
      refetch: () => refetchSpy(opts?.__hub)
    }
  },
  useMutation: (opts: { __key?: string; __hub?: string }) => {
    const remote = opts?.__hub !== undefined && opts.__hub !== 'local'
    const revoke = opts?.__key === 'revoke'
    return {
      mutateAsync: revoke
        ? remote
          ? remoteRevokeSpy
          : revokeSpy
        : remote
          ? (input: any) => remoteMintSpy(input, opts?.__hub)
          : mintSpy,
      isPending: false
    }
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() })
}))

vi.mock('@slayzone/ui', () => {
  const Pass = ({ children }: any) => <>{children}</>
  return {
    Button: ({ children, onClick, disabled, ...props }: any) => (
      <button onClick={onClick} disabled={disabled} {...props}>
        {children}
      </button>
    ),
    IconButton: ({ children, onClick, disabled, ...props }: any) => (
      <button onClick={onClick} disabled={disabled} {...props}>
        {children}
      </button>
    ),
    Input: (props: any) => <input {...props} />,
    Skeleton: (props: any) => <div data-slot="skeleton" {...props} />,
    cn: (...parts: any[]) => parts.filter(Boolean).join(' '),
    AlertDialog: Pass,
    AlertDialogAction: ({ children, onClick, ...props }: any) => (
      <button onClick={onClick} {...props}>
        {children}
      </button>
    ),
    AlertDialogCancel: ({ children }: any) => <button>{children}</button>,
    AlertDialogContent: Pass,
    AlertDialogDescription: Pass,
    AlertDialogFooter: Pass,
    AlertDialogHeader: Pass,
    AlertDialogTitle: ({ children }: any) => <div>{children}</div>,
    Dialog: ({ open, children }: any) => (open ? <>{children}</> : null),
    DialogContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    DialogHeader: Pass,
    DialogTitle: ({ children }: any) => <div>{children}</div>,
    DialogDescription: ({ children }: any) => <div>{children}</div>,
    DialogFooter: Pass,
    toast: { success: vi.fn(), error: vi.fn() }
  }
})

import { HubCard } from './HubCard'
import { RunnerActionsProvider } from './RunnerActions'

/** Stands in for `<HubScope>`: records whose subtree follows. */
function Scope({ hubId, children }: { hubId: string; children: React.ReactNode }) {
  renderingHubId = hubId
  return <>{children}</>
}

function makeRunner(overrides: Partial<MockRunner> = {}): MockRunner {
  return {
    id: 'r-1',
    name: 'mac-studio',
    platform: 'darwin-arm64',
    capabilities: ['pty', 'git'],
    connected: true,
    connectedAt: 111,
    lastSeenAt: 222,
    createdAt: 100,
    ...overrides
  }
}

/**
 * Identity / status / primary / more are SLOTS filled by `HubsSettingsTab` — the
 * card only positions them. Stand-ins here, so the header the tests see has the
 * same shape as production's.
 */
const identityFor = (label: string) => <span data-testid="hub-identity">{label}</span>
const statusFor = (label: string) => <span data-testid="hub-status-slot">{label} status</span>
const primaryFor = (label: string) => <button data-testid="hub-primary">{label} primary</button>
const moreFor = (label: string) => <button data-testid="hub-more">{label} more</button>

const card = (hubId: string, hubLabel: string, isLocalHub: boolean) => (
  <Scope hubId={hubId}>
    <HubCard
      hubId={hubId}
      hubLabel={hubLabel}
      isLocalHub={isLocalHub}
      headerTestId={isLocalHub ? 'hub-row-local' : 'hub-row-remote'}
      identity={identityFor(hubLabel)}
      status={statusFor(hubLabel)}
      primary={primaryFor(hubLabel)}
      more={moreFor(hubLabel)}
    />
  </Scope>
)

/** One local hub's card, inside the shared actions provider. */
async function renderLocal(): Promise<void> {
  await act(async () => {
    render(<RunnerActionsProvider>{card('local', 'Local', true)}</RunnerActionsProvider>)
  })
}

/** One remote hub's card — the only kind that enrolls. */
async function renderRemote(hubId = 'hub-b', label = 'Hub B'): Promise<void> {
  await act(async () => {
    render(<RunnerActionsProvider>{card(hubId, label, false)}</RunnerActionsProvider>)
  })
}

/** Two REMOTE cards, for the cases about list chrome the local hub doesn't have. */
async function renderTwoRemotes(): Promise<void> {
  await act(async () => {
    render(
      <RunnerActionsProvider>
        {card('hub-b', 'Hub B', false)}
        {card('hub-lo', 'Loopback hub', false)}
      </RunnerActionsProvider>
    )
  })
}

/** Two hubs' cards side by side, as the Hubs list mounts them. */
async function renderTwoHubs(): Promise<void> {
  await act(async () => {
    render(
      <RunnerActionsProvider>
        {card('local', 'Local', true)}
        {card('hub-b', 'Hub B', false)}
      </RunnerActionsProvider>
    )
  })
}

beforeEach(() => {
  runnersByHub = {}
  queryState = 'success'
  // Reset per test: a readiness answer left over from a previous case would make
  // an unrelated row sprout a marker.
  renderingHubId = 'local'
  mintSpy.mockClear()
  revokeSpy.mockClear()
  remoteMintSpy.mockClear()
  remoteRevokeSpy.mockClear()
  restartLocalRunnerSpy.mockClear()
  refetchSpy.mockClear()
})

afterEach(cleanup)

describe('HubCard', () => {
  it('offers enrollment with no mode to enable and no hub picker', async () => {
    await renderRemote()
    expect(screen.getByTestId('runner-add-open').hasAttribute('disabled')).toBe(false)
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add-open'))
    })
    expect(screen.getByTestId('runner-add').hasAttribute('disabled')).toBe(false)
    // The block IS the hub, so there is nothing to pick. This is the affordance
    // the nesting exists to delete.
    expect(screen.queryByTestId('runner-add-hub')).toBeNull()
  })

  it('mints an enrollment token and shows it once', async () => {
    await renderRemote()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add-open'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add'))
    })
    expect(remoteMintSpy).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByTestId('runner-minted-token')).toBeDefined()
    })
  })

  it('dismisses the minted token via the Done control', async () => {
    await renderRemote()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add-open'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add'))
    })
    await waitFor(() => expect(screen.getByTestId('runner-minted-token')).toBeDefined())
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-token-dismiss'))
    })
    expect(screen.queryByTestId('runner-minted-token')).toBeNull()
  })

  it('renders enrolled runners as rows', async () => {
    runnersByHub = {
      local: [
        makeRunner(),
        makeRunner({ id: 'r-2', name: 'linux-box', platform: 'linux-x64', connected: false })
      ]
    }
    await renderLocal()
    expect(screen.getAllByTestId('runner-row').length).toBe(2)
    expect(screen.getByText('mac-studio')).toBeDefined()
    expect(screen.getByText('linux-box')).toBeDefined()
    expect(screen.getByText('darwin-arm64')).toBeDefined()
  })

  it('fires the revoke mutation after confirming', async () => {
    runnersByHub = { local: [makeRunner()] }
    await renderLocal()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-revoke'))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    })
    expect(revokeSpy).toHaveBeenCalledWith({ runnerId: 'r-1' })
  })

  // --- the heading: names the rows, and names each NOT-a-list state -----------

  it('says none are enrolled only when the hub actually answered', async () => {
    // A REMOTE hub, deliberately: an empty LOCAL hub is not empty on screen — it
    // still shows the "local runner not running" leaf, so "none enrolled" beside a
    // visible row would contradict it.
    runnersByHub = { 'hub-b': [] }
    await act(async () => {
      render(<RunnerActionsProvider>{card('hub-b', 'Hub B', false)}</RunnerActionsProvider>)
    })
    expect(screen.getByTestId('hub-runners-summary').textContent).toBe('none enrolled')
  })

  it('does not say “none enrolled” on a local hub that is showing its missing runner', async () => {
    runnersByHub = { local: [] }
    await renderLocal()
    expect(screen.getByTestId('runner-local-missing')).toBeDefined()
    expect(screen.queryByTestId('hub-runners-summary')).toBeNull()
  })

  it('never claims an unreachable hub has no runners', async () => {
    // "none enrolled" is a claim about the hub's CONFIGURATION. Saying it when the
    // request failed reports a transport problem as a settings fact.
    queryState = 'error'
    runnersByHub = { local: [] }
    await renderLocal()
    expect(screen.getByTestId('hub-runners-summary').textContent).toBe('could not reach this hub')
  })

  it('adds no note once the rows themselves are on screen', async () => {
    // A count beside the heading would restate what is already visible.
    runnersByHub = {
      'hub-b': [makeRunner(), makeRunner({ id: 'r-2', name: 'linux-box', connected: false })]
    }
    await renderRemote()
    expect(screen.queryByTestId('hub-runners-summary')).toBeNull()
    expect(screen.getByText('Runners')).toBeDefined()
  })

  // --- placement: the hub header stays the HUB's ------------------------------

  it('keeps runner content out of the hub’s own header row', async () => {
    runnersByHub = { local: [makeRunner({ id: 'r-local', name: 'local-runner' })] }
    await renderLocal()
    const header = screen.getByTestId('hub-row-local')
    // The hub header carries the hub's identity and controls, and nothing else — a
    // runner count beside the hub's address reads as a property of the hub.
    expect(header.contains(screen.getByTestId('hub-identity'))).toBe(true)
    expect(header.contains(screen.getByTestId('hub-status-slot'))).toBe(true)
    expect(header.contains(screen.getByTestId('hub-more'))).toBe(true)
    expect(header.contains(screen.getByTestId('runners-table'))).toBe(false)
  })

  it('hangs enroll off the rail as the LAST leaf, below every runner', async () => {
    runnersByHub = { 'hub-b': [makeRunner()] }
    await renderRemote()
    const rows = Array.from(screen.getByTestId('runners-table').querySelectorAll('tbody > tr'))
    const addRow = screen.getByTestId('runner-add-row')
    expect(rows.at(-1)).toBe(addRow)
    expect(addRow.contains(screen.getByTestId('runner-add-open'))).toBe(true)
  })

  it('still offers enroll on a hub with no runners at all', async () => {
    // The rail is the only thing in the body then — losing the add leaf with the
    // list would leave an empty hub with no way to fill it.
    runnersByHub = { 'hub-b': [] }
    await act(async () => {
      render(<RunnerActionsProvider>{card('hub-b', 'Hub B', false)}</RunnerActionsProvider>)
    })
    expect(screen.queryAllByTestId('runner-row').length).toBe(0)
    expect(screen.getByTestId('runner-add-open')).toBeDefined()
  })

  it('merges status and last-seen into one field', async () => {
    // They were two columns, and a connected runner read "Connected" in both.
    runnersByHub = {
      local: [makeRunner({ connected: false, lastSeenAt: null, name: 'never-seen' })]
    }
    await renderLocal()
    expect(screen.getByText(/Never connected/)).toBeDefined()
  })

  // --- two hubs: actions cannot leak across the boundary ---------------------

  it('mints against the hub whose block was used', async () => {
    runnersByHub = { local: [], 'hub-b': [] }
    await renderTwoHubs()
    // Only Hub B offers enrollment — the local card has no add leaf at all, which
    // is itself the assertion that a mint cannot be aimed at the local hub.
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add-open'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add'))
    })
    expect(remoteMintSpy).toHaveBeenCalled()
    expect(mintSpy).not.toHaveBeenCalled()
    // The dialog names the hub, so a pasted token is never attributed to the wrong one.
    await waitFor(() => {
      expect(screen.getByTestId('runner-minted-hub').textContent).toContain('Hub B')
    })
  })

  it('revokes a remote row against the REMOTE hub, with that row’s id', async () => {
    runnersByHub = {
      local: [makeRunner({ id: 'r-1', name: 'mac-studio' })],
      'hub-b': [makeRunner({ id: 'r-remote', name: 'vps-1' })]
    }
    await renderTwoHubs()
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('runner-revoke')[1]!)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    })
    expect(remoteRevokeSpy).toHaveBeenCalledWith({ runnerId: 'r-remote' })
    expect(revokeSpy).not.toHaveBeenCalled()
  })

  // The app's filesystem work runs on the runner that owns the workspace, so a
  // folder outside these roots is one the UI genuinely cannot open. Offered for
  // EVERY runner, local included — the local runner's default jail is only $HOME,
  // and a project on an external drive would otherwise be unreachable with no
  // way to say so.
  // The marker is deliberately quiet: nothing at all when the runner can do git
  // work, because a row per runner saying "fine" is noise. It appears only when
  // there is something an operator can act on.
  it('offers the allowed-folders editor on every runner row', async () => {
    runnersByHub = {
      local: [
        makeRunner({ id: 'r-1', name: 'local-runner' }),
        makeRunner({ id: 'r-2', name: 'other' })
      ]
    }
    await renderLocal()
    expect(screen.getAllByTestId('runner-edit-roots')).toHaveLength(2)
  })

  // The dialog is a SINGLE instance living outside any hub's scope, so it is
  // handed thunks bound to the asking hub's client. Without that, editing a
  // remote runner's jail would read and write the local hub's.
  it('reads and writes a remote runner’s folders against that runner’s own hub', async () => {
    runnersByHub = {
      local: [makeRunner({ id: 'r-1', name: 'mac-studio' })],
      'hub-b': [makeRunner({ id: 'r-remote', name: 'vps-1' })]
    }
    await renderTwoHubs()
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('runner-edit-roots')[1]!)
    })
    await waitFor(() => {
      expect(editRootsSpy).toHaveBeenCalledWith({
        op: 'load',
        hub: 'hub-b',
        runnerId: 'r-remote'
      })
    })

    await act(async () => {
      fireEvent.change(screen.getByTestId('runner-roots-input'), {
        target: { value: '/srv/projects' }
      })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-roots-save'))
    })

    expect(editRootsSpy).toHaveBeenCalledWith({
      op: 'save',
      hub: 'hub-b',
      runnerId: 'r-remote',
      roots: ['/home/kalle', '/srv/projects']
    })
  })

  // A loopback token cannot be used by a runner on another machine. Minting can't
  // refuse (the co-located case is the norm), so the dialog must say so.
  it('warns when the minted token targets loopback', async () => {
    runnersByHub = { 'hub-lo': [] }
    await renderRemote('hub-lo', 'Loopback hub')
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add-open'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('runner-token-loopback-warning')).toBeDefined()
    })
  })

  it('does NOT warn when the minted token targets a public address', async () => {
    runnersByHub = { 'hub-b': [] }
    await renderRemote()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add-open'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add'))
    })
    await waitFor(() => expect(screen.getByTestId('runner-minted-token')).toBeDefined())
    expect(screen.queryByTestId('runner-token-loopback-warning')).toBeNull()
  })

  // --- local runner: restart / start ----------------------------------------
  //
  // The local runner is the app's own supervised child, so it is the ONE row this
  // client can act on as a process. These pin that boundary: the affordance must
  // never appear on a runner we cannot actually control.

  it('offers restart on the local hub’s local-runner row only', async () => {
    runnersByHub = { local: [makeRunner({ id: 'r-local', name: 'local-runner' }), makeRunner()] }
    await renderLocal()
    expect(screen.getAllByTestId('runner-row').length).toBe(2)
    expect(screen.getAllByTestId('runner-local-restart').length).toBe(1)
    expect(screen.queryByTestId('runner-local-missing')).toBeNull()
  })

  it('does NOT offer restart for a REMOTE hub’s own local-runner', async () => {
    // Both hubs have a runner by that name — only the one on OUR machine is a
    // process this app can cycle. Restarting the other is not ours to do.
    runnersByHub = {
      local: [makeRunner({ id: 'r-local', name: 'local-runner' })],
      'hub-b': [makeRunner({ id: 'r-remote-local', name: 'local-runner' })]
    }
    await renderTwoHubs()
    expect(screen.getAllByTestId('runner-row').length).toBe(2)
    expect(screen.getAllByTestId('runner-local-restart').length).toBe(1)
  })

  it('restarts only after the confirm, since it kills every terminal on the machine', async () => {
    runnersByHub = { local: [makeRunner({ id: 'r-local', name: 'local-runner' })] }
    await renderLocal()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-local-restart'))
    })
    expect(restartLocalRunnerSpy).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-local-restart-confirm'))
    })
    expect(restartLocalRunnerSpy).toHaveBeenCalledTimes(1)
  })

  it('offers Start when the local hub has no local runner at all', async () => {
    // The boot-time join-token mint failed → nothing on this machine can execute,
    // and there is no row to hang a restart on. Starting destroys nothing, so it
    // skips the confirm.
    runnersByHub = { local: [makeRunner()] }
    await renderLocal()
    expect(screen.getByTestId('runner-local-missing')).toBeDefined()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-local-start'))
    })
    expect(restartLocalRunnerSpy).toHaveBeenCalledTimes(1)
  })

  it('never claims a REMOTE hub is missing its local runner', async () => {
    runnersByHub = { local: [], 'hub-b': [] }
    await renderTwoHubs()
    expect(screen.getAllByTestId('runner-local-missing').length).toBe(1)
  })

  // --- the local hub is not an enrollment target ------------------------------

  it('offers no enrollment on the local hub at all', async () => {
    // A token minted here would carry a loopback dial address: redeemable only by
    // something already on this machine, where a runner already exists.
    runnersByHub = { local: [makeRunner({ id: 'r-local', name: 'local-runner' })] }
    await renderLocal()
    expect(screen.queryByTestId('runner-add-open')).toBeNull()
    expect(screen.queryByTestId('runner-add-row')).toBeNull()
  })

  it('terminates the rail on the last runner when there is no add leaf', async () => {
    // The elbow has to move with the last leaf, or the connector runs past the
    // final row into empty space.
    runnersByHub = {
      local: [
        makeRunner({ id: 'r-local', name: 'local-runner' }),
        makeRunner({ id: 'r-2', name: 'other' })
      ]
    }
    await renderLocal()
    const rows = Array.from(screen.getByTestId('runners-table').querySelectorAll('tbody > tr'))
    expect(rows.length).toBe(2)
    expect(rows.at(-1)).toBe(screen.getAllByTestId('runner-row').at(-1))
  })

  it('drops the list chrome on a one-runner hub', async () => {
    // Rail, plural heading and refresh-the-LIST all presuppose more than one
    // runner. The local hub has exactly one, forever.
    runnersByHub = { local: [makeRunner({ id: 'r-local', name: 'local-runner' })] }
    await renderLocal()
    expect(screen.queryByText('Runners')).toBeNull()
    expect(screen.queryByTestId('runner-refresh')).toBeNull()
  })

  it('derives the row geometry FROM the header, not in parallel with it', async () => {
    // The two rows are different mechanisms — a flex header over a fixed-layout
    // table — so nothing makes them agree except these widths matching. Compare
    // them directly rather than asserting each against a remembered number, and
    // assert the header carries NO gap: a gap between flex slots has no
    // counterpart in table cells, so it silently offsets every column.
    runnersByHub = { local: [makeRunner({ id: 'r-local', name: 'local-runner' })] }
    await renderLocal()

    const header = screen.getByTestId('hub-row-local')
    expect(header.className).not.toMatch(/\bgap-/)
    const widthOf = (el: Element): string =>
      (el.className.match(/\bw-(?:\d+|full|auto)\b/) ?? ['(auto)'])[0]

    // Trailing slots of the header: status, primary, more.
    const headerSlots = Array.from(header.children).slice(1).map(widthOf)
    // Trailing cells of the row: status, actions, spacer.
    const rowCells = Array.from(screen.getByTestId('runner-row').querySelectorAll('td'))
    const rowTrailing = rowCells.slice(-3).map(widthOf)

    expect(rowTrailing).toEqual(headerSlots)
    // ...and the leading cell matches the star button's footprint (icon-sm = size-8).
    expect(widthOf(rowCells[0]!)).toBe('w-8')
  })

  it('gives a runner row the same column geometry as the hub header above it', async () => {
    // The header reserves w-8 (star) … w-36 (status) w-24 (primary) w-8 (more).
    // A row that does not mirror those widths puts its status and its action under
    // nothing in particular, which is what "the rows don't line up" looks like.
    runnersByHub = { local: [makeRunner({ id: 'r-local', name: 'local-runner' })] }
    await renderLocal()
    const cells = Array.from(screen.getByTestId('runner-row').querySelectorAll('td'))
    const cls = cells.map((c) => c.className)
    // Five cells against the header's four slots plus its leading star.
    expect(cells.length).toBe(5)
    expect(cls[0]).toContain('w-8') // leading marker == the star's footprint
    expect(cls[1]).toContain('pl-2') // name starts where the hub's name starts
    expect(cls[2]).toContain('w-32') // status column == the header's status slot
    expect(cls[3]).toContain('w-24') // actions == the header's primary slot
    expect(cls[4]).toContain('w-8') // spacer under the header's `⋯`
  })

  it('keeps the list chrome on a hub that can hold several runners', async () => {
    runnersByHub = { 'hub-b': [makeRunner()] }
    await renderRemote()
    expect(screen.getByText('Runners')).toBeDefined()
    expect(screen.getByTestId('runner-refresh')).toBeDefined()
    // Identical geometry to the local card's row — the rail simply fills the
    // leading cell the marker fills there.
    const cells = screen.getByTestId('runner-row').querySelectorAll('td')
    expect(cells.length).toBe(5)
  })

  it('still names an unreachable one-runner hub, with no heading to hang it on', async () => {
    queryState = 'error'
    runnersByHub = { local: [] }
    await renderLocal()
    expect(screen.getByTestId('hub-runners-summary').textContent).toBe('could not reach this hub')
  })

  it('does not let the local runner be revoked', async () => {
    // Revoking it deletes the credential the app re-dials with; nothing on this
    // machine could execute until a relaunch re-enrolled one.
    runnersByHub = { local: [makeRunner({ id: 'r-local', name: 'local-runner' })] }
    await renderLocal()
    expect(screen.getAllByTestId('runner-row').length).toBe(1)
    expect(screen.queryByTestId('runner-revoke')).toBeNull()
    // The action it DOES keep is the process one.
    expect(screen.getByTestId('runner-local-restart')).toBeDefined()
  })

  it('still revokes a non-local runner enrolled on the local hub', async () => {
    // Installs that enrolled one before the local hub stopped offering enrollment
    // must keep a way to remove it.
    runnersByHub = {
      local: [
        makeRunner({ id: 'r-local', name: 'local-runner' }),
        makeRunner({ id: 'r-legacy', name: 'old-box' })
      ]
    }
    await renderLocal()
    const revokes = screen.getAllByTestId('runner-revoke')
    expect(revokes.length).toBe(1)
    await act(async () => {
      fireEvent.click(revokes[0]!)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    })
    expect(revokeSpy).toHaveBeenCalledWith({ runnerId: 'r-legacy' })
  })

  // --- loading + refresh ------------------------------------------------------

  it('does not flash “not running” before the query settles', async () => {
    queryState = 'loading'
    runnersByHub = { local: [] }
    await renderLocal()
    expect(screen.queryByTestId('runner-local-missing')).toBeNull()
  })

  it('shows skeleton leaves on first load, not a word', async () => {
    // The rail keeps its shape while the answer is in flight, so the section does
    // not jump when the rows arrive.
    queryState = 'loading'
    runnersByHub = { 'hub-b': [] }
    await renderRemote()
    expect(screen.getAllByTestId('runner-row-skeleton').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('hub-runners-summary')).toBeNull()
    // Enroll stays reachable — waiting on a list is no reason to block adding to it.
    expect(screen.getByTestId('runner-add-open')).toBeDefined()
  })

  it('drops the skeleton once rows are in', async () => {
    runnersByHub = { local: [makeRunner({ id: 'r-local', name: 'local-runner' })] }
    await renderLocal()
    expect(screen.queryByTestId('runner-row-skeleton')).toBeNull()
    expect(screen.getAllByTestId('runner-row').length).toBe(1)
  })

  it('re-checks connection status on demand', async () => {
    // `runners.list` does not poll, so a runner that reconnected looks identical to
    // one still down until something invalidates the query.
    runnersByHub = { 'hub-b': [makeRunner()] }
    await renderRemote()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-refresh'))
    })
    expect(refetchSpy).toHaveBeenCalledWith('hub-b')
  })

  it('refreshes only its OWN hub', async () => {
    runnersByHub = { 'hub-b': [makeRunner()], 'hub-lo': [makeRunner({ id: 'r-2' })] }
    await renderTwoRemotes()
    const buttons = screen.getAllByTestId('runner-refresh')
    expect(buttons.length).toBe(2)
    await act(async () => {
      fireEvent.click(buttons[1]!)
    })
    // Each card holds its own query, so a refresh cannot fan out to a hub the user
    // did not ask about.
    expect(refetchSpy).toHaveBeenCalledTimes(1)
    expect(refetchSpy).toHaveBeenCalledWith('hub-lo')
  })

  it('disables refresh while a fetch is already in flight', async () => {
    queryState = 'loading'
    runnersByHub = { 'hub-b': [] }
    await renderRemote()
    expect(screen.getByTestId('runner-refresh').hasAttribute('disabled')).toBe(true)
  })
})
