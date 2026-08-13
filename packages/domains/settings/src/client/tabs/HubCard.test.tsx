// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'

/**
 * One hub's computer block — the list, enrollment, revoke, and the local-computer
 * process controls.
 *
 * The block is mounted per hub inside that hub's `<HubScope>`, so everything it
 * does is hub-scoped by construction. These tests stand in for that scope by
 * stamping a hub id onto the mocked tRPC builders (`__hub`) and routing the
 * mutation spies by it — which is what lets the "two blocks, two hubs" cases below
 * prove that a mint or revoke cannot leak to the wrong hub.
 */

type MockComputer = {
  id: string
  name: string
  platform: string
  capabilities: string[]
  connected: boolean
  connectedAt: number | null
  lastSeenAt: number | null
  createdAt: number
}

/** Per-hub computer lists, keyed by hub id. */
let computersByHub: Record<string, MockComputer[]> = {}
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
    // the computer is co-located, and the case the token dialog must warn about.
    hubUrl:
      hub === 'hub-lo' ? 'ws://127.0.0.1:51100/computers' : 'wss://hub-b.example.com:8443/computers'
  } as any)
)
const remoteRevokeSpy = vi.fn(() => Promise.resolve({ ok: true as const }))

/**
 * The local computer is cycled over the DESKTOP BRIDGE, not tRPC — it is a child of
 * the main process, which the hub has no handle on.
 */
const restartLocalComputerSpy = vi.fn(() => Promise.resolve({ ok: true as const }))

/** The manual "re-check which computers are connected" round trip. */
const refetchSpy = vi.fn(() => Promise.resolve({} as any))

/** Reads/writes of a computer's filesystem path-jail, tagged with the asking hub. */
const editRootsSpy = vi.fn(
  (_call: { op: 'load' | 'save'; hub: string; computerId: string; roots?: string[] }) => {}
)

/** Which hub's subtree is rendering — set by the test's `<Scope>` wrapper. */
let renderingHubId = 'local'

vi.mock('@slayzone/transport/client', () => ({
  // Live status pushes are wired in the component; these tests drive the list
  // directly, so the subscription is a no-op here.
  useSubscription: () => undefined,
  useTRPC: () => {
    const hub = renderingHubId
    return {
      computers: {
        list: { queryOptions: () => ({ __hub: hub }), queryFilter: () => ({ __hub: hub }) },
        mintJoinToken: { mutationOptions: () => ({ __key: 'mint', __hub: hub }) },
        onStatusChange: {
          subscriptionOptions: () => ({ __key: 'computers.onStatusChange' })
        },
        renameMachine: {
          mutationOptions: () => ({ __key: 'computers.renameMachine' })
        },
        revokeComputer: { mutationOptions: () => ({ __key: 'revoke', __hub: hub }) }
      }
    }
  },
  // The vanilla client, used only for the allowed-roots dialog's thunks. Tagged
  // with the rendering hub for the same reason the query proxy is: an edit made
  // from one hub's card must not read or write another hub's computer.
  useTRPCClient: () => {
    const hub = renderingHubId
    return {
      workspace: {
        listRoots: {
          query: (input: { computerId: string }) => {
            editRootsSpy({ op: 'load', hub, computerId: input.computerId })
            return Promise.resolve({ roots: ['/home/kalle'], home: '/home/kalle' })
          }
        },
        setAllowedRoots: {
          mutate: (input: { computerId: string; roots: string[] }) => {
            editRootsSpy({ op: 'save', hub, computerId: input.computerId, roots: input.roots })
            return Promise.resolve({ roots: input.roots, rejected: [] })
          }
        }
      }
    }
  },
  electronBootstrap: { restartLocalComputer: () => restartLocalComputerSpy() }
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
    // thunk, not by the computer roster. Running it is the point: the thunk is what
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
      data: (opts?.__hub !== undefined ? computersByHub[opts.__hub] : undefined) ?? [],
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
import { ComputerActionsProvider } from './ComputerActions'

/** Stands in for `<HubScope>`: records whose subtree follows. */
function Scope({ hubId, children }: { hubId: string; children: React.ReactNode }) {
  renderingHubId = hubId
  return <>{children}</>
}

function makeComputer(overrides: Partial<MockComputer> = {}): MockComputer {
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
    render(<ComputerActionsProvider>{card('local', 'Local', true)}</ComputerActionsProvider>)
  })
}

/** One remote hub's card — the only kind that enrolls. */
async function renderRemote(hubId = 'hub-b', label = 'Hub B'): Promise<void> {
  await act(async () => {
    render(<ComputerActionsProvider>{card(hubId, label, false)}</ComputerActionsProvider>)
  })
}

/** Two REMOTE cards, for the cases about list chrome the local hub doesn't have. */
async function renderTwoRemotes(): Promise<void> {
  await act(async () => {
    render(
      <ComputerActionsProvider>
        {card('hub-b', 'Hub B', false)}
        {card('hub-lo', 'Loopback hub', false)}
      </ComputerActionsProvider>
    )
  })
}

/** Two hubs' cards side by side, as the Hubs list mounts them. */
async function renderTwoHubs(): Promise<void> {
  await act(async () => {
    render(
      <ComputerActionsProvider>
        {card('local', 'Local', true)}
        {card('hub-b', 'Hub B', false)}
      </ComputerActionsProvider>
    )
  })
}

beforeEach(() => {
  computersByHub = {}
  queryState = 'success'
  // Reset per test: a readiness answer left over from a previous case would make
  // an unrelated row sprout a marker.
  renderingHubId = 'local'
  mintSpy.mockClear()
  revokeSpy.mockClear()
  remoteMintSpy.mockClear()
  remoteRevokeSpy.mockClear()
  restartLocalComputerSpy.mockClear()
  refetchSpy.mockClear()
})

afterEach(cleanup)

describe('HubCard', () => {
  it('offers enrollment with no mode to enable and no hub picker', async () => {
    await renderRemote()
    expect(screen.getByTestId('computer-add-open').hasAttribute('disabled')).toBe(false)
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-add-open'))
    })
    expect(screen.getByTestId('computer-add').hasAttribute('disabled')).toBe(false)
    // The block IS the hub, so there is nothing to pick. This is the affordance
    // the nesting exists to delete.
    expect(screen.queryByTestId('computer-add-hub')).toBeNull()
  })

  it('mints an enrollment token and shows it once', async () => {
    await renderRemote()
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-add-open'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-add'))
    })
    expect(remoteMintSpy).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByTestId('computer-minted-token')).toBeDefined()
    })
  })

  it('dismisses the minted token via the Done control', async () => {
    await renderRemote()
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-add-open'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-add'))
    })
    await waitFor(() => expect(screen.getByTestId('computer-minted-token')).toBeDefined())
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-token-dismiss'))
    })
    expect(screen.queryByTestId('computer-minted-token')).toBeNull()
  })

  it('renders enrolled computers as rows', async () => {
    computersByHub = {
      local: [
        makeComputer(),
        makeComputer({ id: 'r-2', name: 'linux-box', platform: 'linux-x64', connected: false })
      ]
    }
    await renderLocal()
    expect(screen.getAllByTestId('computer-row').length).toBe(2)
    expect(screen.getByText('mac-studio')).toBeDefined()
    expect(screen.getByText('linux-box')).toBeDefined()
    expect(screen.getByText('darwin-arm64')).toBeDefined()
  })

  it('fires the revoke mutation after confirming', async () => {
    computersByHub = { local: [makeComputer()] }
    await renderLocal()
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-revoke'))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    })
    expect(revokeSpy).toHaveBeenCalledWith({ computerId: 'r-1' })
  })

  // --- the heading: names the rows, and names each NOT-a-list state -----------

  it('says none are enrolled only when the hub actually answered', async () => {
    // A REMOTE hub, deliberately: an empty LOCAL hub is not empty on screen — it
    // still shows the "local computer not running" leaf, so "none enrolled" beside a
    // visible row would contradict it.
    computersByHub = { 'hub-b': [] }
    await act(async () => {
      render(<ComputerActionsProvider>{card('hub-b', 'Hub B', false)}</ComputerActionsProvider>)
    })
    expect(screen.getByTestId('hub-computers-summary').textContent).toBe('none enrolled')
  })

  it('does not say “none enrolled” on a local hub that is showing its missing computer', async () => {
    computersByHub = { local: [] }
    await renderLocal()
    expect(screen.getByTestId('computer-local-missing')).toBeDefined()
    expect(screen.queryByTestId('hub-computers-summary')).toBeNull()
  })

  it('never claims an unreachable hub has no computers', async () => {
    // "none enrolled" is a claim about the hub's CONFIGURATION. Saying it when the
    // request failed reports a transport problem as a settings fact.
    queryState = 'error'
    computersByHub = { local: [] }
    await renderLocal()
    expect(screen.getByTestId('hub-computers-summary').textContent).toBe('could not reach this hub')
  })

  it('adds no note once the rows themselves are on screen', async () => {
    // A count beside the heading would restate what is already visible.
    computersByHub = {
      'hub-b': [makeComputer(), makeComputer({ id: 'r-2', name: 'linux-box', connected: false })]
    }
    await renderRemote()
    expect(screen.queryByTestId('hub-computers-summary')).toBeNull()
    expect(screen.getByText('Computers')).toBeDefined()
  })

  // --- placement: the hub header stays the HUB's ------------------------------

  it('keeps computer content out of the hub’s own header row', async () => {
    computersByHub = { local: [makeComputer({ id: 'r-local', name: 'local-computer' })] }
    await renderLocal()
    const header = screen.getByTestId('hub-row-local')
    // The hub header carries the hub's identity and controls, and nothing else — a
    // computer count beside the hub's address reads as a property of the hub.
    expect(header.contains(screen.getByTestId('hub-identity'))).toBe(true)
    expect(header.contains(screen.getByTestId('hub-status-slot'))).toBe(true)
    expect(header.contains(screen.getByTestId('hub-more'))).toBe(true)
    expect(header.contains(screen.getByTestId('computers-table'))).toBe(false)
  })

  it('hangs enroll off the rail as the LAST leaf, below every computer', async () => {
    computersByHub = { 'hub-b': [makeComputer()] }
    await renderRemote()
    const rows = Array.from(screen.getByTestId('computers-table').querySelectorAll('tbody > tr'))
    const addRow = screen.getByTestId('computer-add-row')
    expect(rows.at(-1)).toBe(addRow)
    expect(addRow.contains(screen.getByTestId('computer-add-open'))).toBe(true)
  })

  it('still offers enroll on a hub with no computers at all', async () => {
    // The rail is the only thing in the body then — losing the add leaf with the
    // list would leave an empty hub with no way to fill it.
    computersByHub = { 'hub-b': [] }
    await act(async () => {
      render(<ComputerActionsProvider>{card('hub-b', 'Hub B', false)}</ComputerActionsProvider>)
    })
    expect(screen.queryAllByTestId('computer-row').length).toBe(0)
    expect(screen.getByTestId('computer-add-open')).toBeDefined()
  })

  it('merges status and last-seen into one field', async () => {
    // They were two columns, and a connected computer read "Connected" in both.
    computersByHub = {
      local: [makeComputer({ connected: false, lastSeenAt: null, name: 'never-seen' })]
    }
    await renderLocal()
    expect(screen.getByText(/Never connected/)).toBeDefined()
  })

  // --- two hubs: actions cannot leak across the boundary ---------------------

  it('mints against the hub whose block was used', async () => {
    computersByHub = { local: [], 'hub-b': [] }
    await renderTwoHubs()
    // Only Hub B offers enrollment — the local card has no add leaf at all, which
    // is itself the assertion that a mint cannot be aimed at the local hub.
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-add-open'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-add'))
    })
    expect(remoteMintSpy).toHaveBeenCalled()
    expect(mintSpy).not.toHaveBeenCalled()
    // The dialog names the hub, so a pasted token is never attributed to the wrong one.
    await waitFor(() => {
      expect(screen.getByTestId('computer-minted-hub').textContent).toContain('Hub B')
    })
  })

  it('revokes a remote row against the REMOTE hub, with that row’s id', async () => {
    computersByHub = {
      local: [makeComputer({ id: 'r-1', name: 'mac-studio' })],
      'hub-b': [makeComputer({ id: 'r-remote', name: 'vps-1' })]
    }
    await renderTwoHubs()
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('computer-revoke')[1]!)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    })
    expect(remoteRevokeSpy).toHaveBeenCalledWith({ computerId: 'r-remote' })
    expect(revokeSpy).not.toHaveBeenCalled()
  })

  // The app's filesystem work runs on the computer that owns the workspace, so a
  // folder outside these roots is one the UI genuinely cannot open. Offered for
  // EVERY computer, local included — the local computer's default jail is only $HOME,
  // and a project on an external drive would otherwise be unreachable with no
  // way to say so.
  // The marker is deliberately quiet: nothing at all when the computer can do git
  // work, because a row per computer saying "fine" is noise. It appears only when
  // there is something an operator can act on.
  it('offers the allowed-folders editor on every computer row', async () => {
    computersByHub = {
      local: [
        makeComputer({ id: 'r-1', name: 'local-computer' }),
        makeComputer({ id: 'r-2', name: 'other' })
      ]
    }
    await renderLocal()
    expect(screen.getAllByTestId('computer-edit-roots')).toHaveLength(2)
  })

  // The dialog is a SINGLE instance living outside any hub's scope, so it is
  // handed thunks bound to the asking hub's client. Without that, editing a
  // remote computer's jail would read and write the local hub's.
  it('reads and writes a remote computer’s folders against that computer’s own hub', async () => {
    computersByHub = {
      local: [makeComputer({ id: 'r-1', name: 'mac-studio' })],
      'hub-b': [makeComputer({ id: 'r-remote', name: 'vps-1' })]
    }
    await renderTwoHubs()
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('computer-edit-roots')[1]!)
    })
    await waitFor(() => {
      expect(editRootsSpy).toHaveBeenCalledWith({
        op: 'load',
        hub: 'hub-b',
        computerId: 'r-remote'
      })
    })

    await act(async () => {
      fireEvent.change(screen.getByTestId('computer-roots-input'), {
        target: { value: '/srv/projects' }
      })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-roots-save'))
    })

    expect(editRootsSpy).toHaveBeenCalledWith({
      op: 'save',
      hub: 'hub-b',
      computerId: 'r-remote',
      roots: ['/home/kalle', '/srv/projects']
    })
  })

  // A loopback token cannot be used by a computer on another machine. Minting can't
  // refuse (the co-located case is the norm), so the dialog must say so.
  it('warns when the minted token targets loopback', async () => {
    computersByHub = { 'hub-lo': [] }
    await renderRemote('hub-lo', 'Loopback hub')
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-add-open'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-add'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('computer-token-loopback-warning')).toBeDefined()
    })
  })

  it('does NOT warn when the minted token targets a public address', async () => {
    computersByHub = { 'hub-b': [] }
    await renderRemote()
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-add-open'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-add'))
    })
    await waitFor(() => expect(screen.getByTestId('computer-minted-token')).toBeDefined())
    expect(screen.queryByTestId('computer-token-loopback-warning')).toBeNull()
  })

  // --- local computer: restart / start ----------------------------------------
  //
  // The local computer is the app's own supervised child, so it is the ONE row this
  // client can act on as a process. These pin that boundary: the affordance must
  // never appear on a computer we cannot actually control.

  it('offers restart on the local hub’s local-computer row only', async () => {
    computersByHub = {
      local: [makeComputer({ id: 'r-local', name: 'local-computer' }), makeComputer()]
    }
    await renderLocal()
    expect(screen.getAllByTestId('computer-row').length).toBe(2)
    expect(screen.getAllByTestId('computer-local-restart').length).toBe(1)
    expect(screen.queryByTestId('computer-local-missing')).toBeNull()
  })

  it('does NOT offer restart for a REMOTE hub’s own local-computer', async () => {
    // Both hubs have a computer by that name — only the one on OUR machine is a
    // process this app can cycle. Restarting the other is not ours to do.
    computersByHub = {
      local: [makeComputer({ id: 'r-local', name: 'local-computer' })],
      'hub-b': [makeComputer({ id: 'r-remote-local', name: 'local-computer' })]
    }
    await renderTwoHubs()
    expect(screen.getAllByTestId('computer-row').length).toBe(2)
    expect(screen.getAllByTestId('computer-local-restart').length).toBe(1)
  })

  it('restarts only after the confirm, since it kills every terminal on the machine', async () => {
    computersByHub = { local: [makeComputer({ id: 'r-local', name: 'local-computer' })] }
    await renderLocal()
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-local-restart'))
    })
    expect(restartLocalComputerSpy).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-local-restart-confirm'))
    })
    expect(restartLocalComputerSpy).toHaveBeenCalledTimes(1)
  })

  it('offers Start when the local hub has no local computer at all', async () => {
    // The boot-time join-token mint failed → nothing on this machine can execute,
    // and there is no row to hang a restart on. Starting destroys nothing, so it
    // skips the confirm.
    computersByHub = { local: [makeComputer()] }
    await renderLocal()
    expect(screen.getByTestId('computer-local-missing')).toBeDefined()
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-local-start'))
    })
    expect(restartLocalComputerSpy).toHaveBeenCalledTimes(1)
  })

  it('never claims a REMOTE hub is missing its local computer', async () => {
    computersByHub = { local: [], 'hub-b': [] }
    await renderTwoHubs()
    expect(screen.getAllByTestId('computer-local-missing').length).toBe(1)
  })

  // --- the local hub is not an enrollment target ------------------------------

  it('offers no enrollment on the local hub at all', async () => {
    // A token minted here would carry a loopback dial address: redeemable only by
    // something already on this machine, where a computer already exists.
    computersByHub = { local: [makeComputer({ id: 'r-local', name: 'local-computer' })] }
    await renderLocal()
    expect(screen.queryByTestId('computer-add-open')).toBeNull()
    expect(screen.queryByTestId('computer-add-row')).toBeNull()
  })

  it('terminates the rail on the last computer when there is no add leaf', async () => {
    // The elbow has to move with the last leaf, or the connector runs past the
    // final row into empty space.
    computersByHub = {
      local: [
        makeComputer({ id: 'r-local', name: 'local-computer' }),
        makeComputer({ id: 'r-2', name: 'other' })
      ]
    }
    await renderLocal()
    const rows = Array.from(screen.getByTestId('computers-table').querySelectorAll('tbody > tr'))
    expect(rows.length).toBe(2)
    expect(rows.at(-1)).toBe(screen.getAllByTestId('computer-row').at(-1))
  })

  it('drops the list chrome on a one-computer hub', async () => {
    // Rail, plural heading and refresh-the-LIST all presuppose more than one
    // computer. The local hub has exactly one, forever.
    computersByHub = { local: [makeComputer({ id: 'r-local', name: 'local-computer' })] }
    await renderLocal()
    expect(screen.queryByText('Computers')).toBeNull()
    expect(screen.queryByTestId('computer-refresh')).toBeNull()
  })

  it('derives the row geometry FROM the header, not in parallel with it', async () => {
    // The two rows are different mechanisms — a flex header over a fixed-layout
    // table — so nothing makes them agree except these widths matching. Compare
    // them directly rather than asserting each against a remembered number, and
    // assert the header carries NO gap: a gap between flex slots has no
    // counterpart in table cells, so it silently offsets every column.
    computersByHub = { local: [makeComputer({ id: 'r-local', name: 'local-computer' })] }
    await renderLocal()

    const header = screen.getByTestId('hub-row-local')
    expect(header.className).not.toMatch(/\bgap-/)
    const widthOf = (el: Element): string =>
      (el.className.match(/\bw-(?:\d+|full|auto)\b/) ?? ['(auto)'])[0]

    // Trailing slots of the header: status, primary, more.
    const headerSlots = Array.from(header.children).slice(1).map(widthOf)
    // Trailing cells of the row: status, actions, spacer.
    const rowCells = Array.from(screen.getByTestId('computer-row').querySelectorAll('td'))
    const rowTrailing = rowCells.slice(-3).map(widthOf)

    expect(rowTrailing).toEqual(headerSlots)
    // ...and the leading cell matches the star button's footprint (icon-sm = size-8).
    expect(widthOf(rowCells[0]!)).toBe('w-8')
  })

  it('gives a computer row the same column geometry as the hub header above it', async () => {
    // The header reserves w-8 (star) … w-36 (status) w-24 (primary) w-8 (more).
    // A row that does not mirror those widths puts its status and its action under
    // nothing in particular, which is what "the rows don't line up" looks like.
    computersByHub = { local: [makeComputer({ id: 'r-local', name: 'local-computer' })] }
    await renderLocal()
    const cells = Array.from(screen.getByTestId('computer-row').querySelectorAll('td'))
    const cls = cells.map((c) => c.className)
    // Five cells against the header's four slots plus its leading star.
    expect(cells.length).toBe(5)
    expect(cls[0]).toContain('w-8') // leading marker == the star's footprint
    expect(cls[1]).toContain('pl-2') // name starts where the hub's name starts
    expect(cls[2]).toContain('w-32') // status column == the header's status slot
    expect(cls[3]).toContain('w-24') // actions == the header's primary slot
    expect(cls[4]).toContain('w-8') // spacer under the header's `⋯`
  })

  it('keeps the list chrome on a hub that can hold several computers', async () => {
    computersByHub = { 'hub-b': [makeComputer()] }
    await renderRemote()
    expect(screen.getByText('Computers')).toBeDefined()
    expect(screen.getByTestId('computer-refresh')).toBeDefined()
    // Identical geometry to the local card's row — the rail simply fills the
    // leading cell the marker fills there.
    const cells = screen.getByTestId('computer-row').querySelectorAll('td')
    expect(cells.length).toBe(5)
  })

  it('still names an unreachable one-computer hub, with no heading to hang it on', async () => {
    queryState = 'error'
    computersByHub = { local: [] }
    await renderLocal()
    expect(screen.getByTestId('hub-computers-summary').textContent).toBe('could not reach this hub')
  })

  it('does not let the local computer be revoked', async () => {
    // Revoking it deletes the credential the app re-dials with; nothing on this
    // machine could execute until a relaunch re-enrolled one.
    computersByHub = { local: [makeComputer({ id: 'r-local', name: 'local-computer' })] }
    await renderLocal()
    expect(screen.getAllByTestId('computer-row').length).toBe(1)
    expect(screen.queryByTestId('computer-revoke')).toBeNull()
    // The action it DOES keep is the process one.
    expect(screen.getByTestId('computer-local-restart')).toBeDefined()
  })

  it('still revokes a non-local computer enrolled on the local hub', async () => {
    // Installs that enrolled one before the local hub stopped offering enrollment
    // must keep a way to remove it.
    computersByHub = {
      local: [
        makeComputer({ id: 'r-local', name: 'local-computer' }),
        makeComputer({ id: 'r-legacy', name: 'old-box' })
      ]
    }
    await renderLocal()
    const revokes = screen.getAllByTestId('computer-revoke')
    expect(revokes.length).toBe(1)
    await act(async () => {
      fireEvent.click(revokes[0]!)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    })
    expect(revokeSpy).toHaveBeenCalledWith({ computerId: 'r-legacy' })
  })

  // --- loading + refresh ------------------------------------------------------

  it('does not flash “not running” before the query settles', async () => {
    queryState = 'loading'
    computersByHub = { local: [] }
    await renderLocal()
    expect(screen.queryByTestId('computer-local-missing')).toBeNull()
  })

  it('shows skeleton leaves on first load, not a word', async () => {
    // The rail keeps its shape while the answer is in flight, so the section does
    // not jump when the rows arrive.
    queryState = 'loading'
    computersByHub = { 'hub-b': [] }
    await renderRemote()
    expect(screen.getAllByTestId('computer-row-skeleton').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('hub-computers-summary')).toBeNull()
    // Enroll stays reachable — waiting on a list is no reason to block adding to it.
    expect(screen.getByTestId('computer-add-open')).toBeDefined()
  })

  it('drops the skeleton once rows are in', async () => {
    computersByHub = { local: [makeComputer({ id: 'r-local', name: 'local-computer' })] }
    await renderLocal()
    expect(screen.queryByTestId('computer-row-skeleton')).toBeNull()
    expect(screen.getAllByTestId('computer-row').length).toBe(1)
  })

  it('re-checks connection status on demand', async () => {
    // `computers.list` does not poll, so a computer that reconnected looks identical to
    // one still down until something invalidates the query.
    computersByHub = { 'hub-b': [makeComputer()] }
    await renderRemote()
    await act(async () => {
      fireEvent.click(screen.getByTestId('computer-refresh'))
    })
    expect(refetchSpy).toHaveBeenCalledWith('hub-b')
  })

  it('refreshes only its OWN hub', async () => {
    computersByHub = { 'hub-b': [makeComputer()], 'hub-lo': [makeComputer({ id: 'r-2' })] }
    await renderTwoRemotes()
    const buttons = screen.getAllByTestId('computer-refresh')
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
    computersByHub = { 'hub-b': [] }
    await renderRemote()
    expect(screen.getByTestId('computer-refresh').hasAttribute('disabled')).toBe(true)
  })
})
