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
    hubUrl: 'ws://127.0.0.1:51100/runners'
  } as any)
)
const revokeSpy = vi.fn(() => Promise.resolve({ ok: true as const }))
const remoteMintSpy = vi.fn(() =>
  Promise.resolve({
    token: 'szjt1.REMOTETOKEN',
    label: 'x',
    hubUrl: 'wss://hub-b.example.com:8443/runners'
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

/** Which hub's subtree is rendering — set by the test's `<Scope>` wrapper. */
let renderingHubId = 'local'

vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => {
    const hub = renderingHubId
    return {
      runners: {
        list: { queryOptions: () => ({ __hub: hub }), queryFilter: () => ({ __hub: hub }) },
        mintJoinToken: { mutationOptions: () => ({ __key: 'mint', __hub: hub }) },
        revokeRunner: { mutationOptions: () => ({ __key: 'revoke', __hub: hub }) }
      }
    }
  },
  electronBootstrap: { restartLocalRunner: () => restartLocalRunnerSpy() }
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { __hub?: string }) => ({
    data: (opts?.__hub !== undefined ? runnersByHub[opts.__hub] : undefined) ?? [],
    isSuccess: queryState === 'success',
    isError: queryState === 'error',
    isFetching: queryState === 'loading',
    // Records WHICH hub asked, so a refresh can be shown not to fan out.
    refetch: () => refetchSpy(opts?.__hub)
  }),
  useMutation: (opts: { __key?: string; __hub?: string }) => {
    const remote = opts?.__hub !== undefined && opts.__hub !== 'local'
    const revoke = opts?.__key === 'revoke'
    return {
      mutateAsync: revoke
        ? remote
          ? remoteRevokeSpy
          : revokeSpy
        : remote
          ? remoteMintSpy
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
 * The hub's identity and controls are SLOTS filled by `HubsSettingsTab` — the card
 * only positions them, next to the runner count and enroll control it owns. Stand
 * -ins here, so the header the tests see has the same shape as production's.
 */
const identityFor = (label: string) => <span data-testid="hub-identity">{label}</span>
const controlsFor = (label: string) => <button data-testid="hub-controls">{label} controls</button>

const card = (hubId: string, hubLabel: string, isLocalHub: boolean) => (
  <Scope hubId={hubId}>
    <HubCard
      hubId={hubId}
      hubLabel={hubLabel}
      isLocalHub={isLocalHub}
      headerTestId={isLocalHub ? 'hub-row-local' : 'hub-row-remote'}
      identity={identityFor(hubLabel)}
      controls={controlsFor(hubLabel)}
    />
  </Scope>
)

/** One local hub's card, inside the shared actions provider. */
async function renderLocal(): Promise<void> {
  await act(async () => {
    render(<RunnerActionsProvider>{card('local', 'Local', true)}</RunnerActionsProvider>)
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
    await renderLocal()
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
    await renderLocal()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add-open'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add'))
    })
    expect(mintSpy).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByTestId('runner-minted-token')).toBeDefined()
    })
  })

  it('dismisses the minted token via the Done control', async () => {
    await renderLocal()
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
      local: [makeRunner(), makeRunner({ id: 'r-2', name: 'linux-box', connected: false })]
    }
    await renderLocal()
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
    expect(header.contains(screen.getByTestId('hub-controls'))).toBe(true)
    expect(header.contains(screen.getByTestId('runners-table'))).toBe(false)
    expect(header.contains(screen.getByTestId('runner-add-open'))).toBe(false)
  })

  it('hangs enroll off the rail as the LAST leaf, below every runner', async () => {
    runnersByHub = { local: [makeRunner({ id: 'r-local', name: 'local-runner' })] }
    await renderLocal()
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
    // Second block is Hub B's.
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('runner-add-open')[1]!)
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

  // A loopback token cannot be used by a runner on another machine. Minting can't
  // refuse (the co-located case is the norm), so the dialog must say so.
  it('warns when the minted token targets loopback', async () => {
    runnersByHub = { local: [] }
    await renderLocal()
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
    runnersByHub = { local: [], 'hub-b': [] }
    await renderTwoHubs()
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('runner-add-open')[1]!)
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
    runnersByHub = { local: [] }
    await renderLocal()
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
    runnersByHub = { local: [makeRunner({ id: 'r-local', name: 'local-runner' })] }
    await renderLocal()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-refresh'))
    })
    expect(refetchSpy).toHaveBeenCalledWith('local')
  })

  it('refreshes only its OWN hub', async () => {
    runnersByHub = { local: [makeRunner()], 'hub-b': [makeRunner({ id: 'r-2' })] }
    await renderTwoHubs()
    const buttons = screen.getAllByTestId('runner-refresh')
    expect(buttons.length).toBe(2)
    await act(async () => {
      fireEvent.click(buttons[1]!)
    })
    // Each card holds its own query, so a refresh cannot fan out to a hub the user
    // did not ask about.
    expect(refetchSpy).toHaveBeenCalledTimes(1)
    expect(refetchSpy).toHaveBeenCalledWith('hub-b')
  })

  it('disables refresh while a fetch is already in flight', async () => {
    queryState = 'loading'
    runnersByHub = { local: [] }
    await renderLocal()
    expect(screen.getByTestId('runner-refresh').hasAttribute('disabled')).toBe(true)
  })
})
