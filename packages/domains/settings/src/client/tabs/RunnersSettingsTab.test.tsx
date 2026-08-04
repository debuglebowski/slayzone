// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'

// --- Mutable per-test state (module-level so the mocks can read them) ---

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

let runnersData: MockRunner[] = []

/**
 * Per-hub runner lists, keyed by hub id — the multi-hub cases set this instead of
 * `runnersData`. A hub absent from the map falls back to `runnersData`, which is
 * what keeps every single-hub test below untouched.
 */
let runnersByHub: Record<string, MockRunner[]> = {}

/** The federation registry, or null to simulate rendering with no federation at
 *  all (the Chromium fork, which has no FederationProvider). */
let federation: { hubs: Array<{ id: string; kind: string; label: string; url?: string }>; defaultHubId: string } | null =
  null

const mintSpy = vi.fn(() =>
  Promise.resolve({
    token: 'szjt1.MOCKTOKEN',
    label: 'x',
    hubUrl: 'ws://127.0.0.1:51100/runners'
  } as any)
)
const revokeSpy = vi.fn(() => Promise.resolve({ ok: true as const }))
/** Mint/revoke reached through a NON-default hub's vanilla client (getHubClient). */
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
 * the main process, which the hub has no handle on. So this spy stands in for a
 * different transport than every other action in this tab.
 */
const restartLocalRunnerSpy = vi.fn(() => Promise.resolve({ ok: true as const }))

/**
 * Which hub's subtree is currently rendering.
 *
 * The mocked `HubScope` sets this in its render body; the mocked `useTRPC()` reads
 * it and STAMPS it onto the option objects it hands back, so the react-query mock
 * can answer per-hub without the production code carrying any test-only input.
 * Safe because React renders depth-first and synchronously here (every render is
 * wrapped in `act`), so a HubScope's body always runs immediately before its own
 * children's — never interleaved with a sibling's.
 */
let renderingHubId = 'local'

// tRPC transport. The component reads `trpc.runners.*` query/mutation builders.
// No bootstrap IPCs — enrollment is always available (a hub always accepts runners).
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
  // The ambient (default-hub) vanilla client the shell mints through when the
  // chosen hub IS the default.
  useTRPCClient: () => ({
    runners: {
      mintJoinToken: { mutate: mintSpy },
      revokeRunner: { mutate: revokeSpy }
    }
  }),
  // A non-default hub's client, resolved by id — the CreateProjectDialog idiom.
  getHubClient: (hubId: string) =>
    hubId === 'local'
      ? null
      : {
          client: {
            runners: {
              mintJoinToken: { mutate: remoteMintSpy },
              revokeRunner: { mutate: remoteRevokeSpy }
            }
          }
        },
  useFederationOrNull: () => federation,
  electronBootstrap: { restartLocalRunner: () => restartLocalRunnerSpy() },
  // Passthrough that records the hub whose subtree follows (see renderingHubId).
  HubScope: ({ hubId, children }: any) => {
    renderingHubId = hubId
    return <>{children}</>
  }
}))

// react-query: useQuery surfaces the runners list for the hub stamped on its
// options; useMutation routes to the mint/revoke spy by the `__key` marker.
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { __hub?: string }) => ({
    data:
      opts?.__hub !== undefined && runnersByHub[opts.__hub] !== undefined
        ? runnersByHub[opts.__hub]
        : runnersData,
    // The "local runner is missing" row is gated on a SETTLED query, so that an
    // empty first render doesn't flash "Not running" at a healthy runner. These
    // mocks answer synchronously, i.e. always settled.
    isSuccess: true
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

// @slayzone/ui — light stubs. AlertDialog family are passthroughs so the confirm
// action is always reachable; Dialog respects `open` so the token modal only
// renders after minting (the dismiss test asserts it disappears).
vi.mock('@slayzone/ui', () => {
  const Pass = ({ children }: any) => <>{children}</>
  return {
    Button: ({ children, onClick, disabled, ...props }: any) => (
      <button onClick={onClick} disabled={disabled} {...props}>
        {children}
      </button>
    ),
    Input: (props: any) => <input {...props} />,
    Label: ({ children }: any) => <label>{children}</label>,
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
    // Radix Select stands in as a native <select> so the hub choice is drivable
    // with fireEvent.change (same approach as RunnerCard.test.tsx). SelectTrigger
    // carries the testid, so the select must be the element that receives it.
    Select: ({ value, onValueChange, children }: any) => (
      <select
        value={value}
        onChange={(e) => onValueChange?.(e.target.value)}
        data-testid="runner-add-hub"
      >
        {children}
      </select>
    ),
    SelectTrigger: Pass,
    SelectValue: () => null,
    SelectContent: Pass,
    SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
    toast: { success: vi.fn(), error: vi.fn() }
  }
})

vi.mock('./SettingsTabIntro', () => ({
  SettingsTabIntro: ({ title, description }: any) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  )
}))

import { RunnersSettingsTab } from './RunnersSettingsTab'

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

/** Two connected hubs — the federated case. Local is the default. */
const TWO_HUBS = {
  hubs: [
    { id: 'local', kind: 'local', label: 'Local', url: 'ws://127.0.0.1:51100/trpc' },
    { id: 'hub-b', kind: 'remote', label: 'Hub B', url: 'wss://hub-b.example.com:8443/trpc' }
  ],
  defaultHubId: 'local'
}

beforeEach(() => {
  runnersData = []
  runnersByHub = {}
  // Single hub is the DEFAULT state for every pre-existing test: a lone local hub
  // must render exactly as it did before federation reached this tab.
  federation = { hubs: [{ id: 'local', kind: 'local', label: 'Local', url: 'ws://127.0.0.1:51100/trpc' }], defaultHubId: 'local' }
  renderingHubId = 'local'
  mintSpy.mockClear()
  revokeSpy.mockClear()
  remoteMintSpy.mockClear()
  remoteRevokeSpy.mockClear()
  restartLocalRunnerSpy.mockClear()
})

afterEach(cleanup)

describe('RunnersSettingsTab', () => {
  it('renders the Runners tab header + always-available enrollment (no mode toggle)', async () => {
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
    expect(screen.getByRole('heading', { name: 'Runners' })).toBeDefined()
    // Enrollment is always available — the add-row is present (collapsed) with no
    // enable-toggle / boot-gate. Expanding it reveals an enabled Add button.
    expect(screen.getByTestId('runner-add-open').hasAttribute('disabled')).toBe(false)
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add-open'))
    })
    expect(screen.getByTestId('runner-add').hasAttribute('disabled')).toBe(false)
    expect(screen.queryByTestId('runners-enabled-toggle')).toBeNull()
    expect(screen.queryByTestId('runner-enroll-disabled')).toBeNull()
  })

  it('mints an enrollment token immediately (no mode to enable)', async () => {
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
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
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add-open'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('runner-minted-token')).toBeDefined()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-token-dismiss'))
    })
    expect(screen.queryByTestId('runner-minted-token')).toBeNull()
  })

  it('renders enrolled runners as rows', async () => {
    runnersData = [
      makeRunner(),
      makeRunner({ id: 'r-2', name: 'linux-box', platform: 'linux-x64', connected: false })
    ]
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
    expect(screen.getAllByTestId('runner-row').length).toBe(2)
    expect(screen.getByText('mac-studio')).toBeDefined()
    expect(screen.getByText('linux-box')).toBeDefined()
    expect(screen.getByText('darwin-arm64')).toBeDefined()
  })

  it('fires the revoke mutation after confirming', async () => {
    runnersData = [makeRunner()]
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
    // Row revoke button opens the confirm dialog (sets the target).
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-revoke'))
    })
    // Confirm — AlertDialogAction labelled "Revoke".
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    })
    expect(revokeSpy).toHaveBeenCalledWith({ runnerId: 'r-1' })
  })

  // --- Single hub: the pre-federation surface, unchanged ---------------------
  // The five tests above are the real regression guard (they never mention a hub);
  // these two pin the ABSENCE of the multi-hub affordances explicitly, since a
  // stray Hub column or picker on a one-hub install would be a visible regression.

  it('single hub: no Hub column and no hub picker', async () => {
    runnersData = [makeRunner()]
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
    expect(screen.queryByTestId('runner-hub-cell')).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Hub' })).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add-open'))
    })
    expect(screen.queryByTestId('runner-add-hub')).toBeNull()
  })

  it('no federation at all (fork): still renders rows, no picker', async () => {
    // The Chromium fork renders this surface with no FederationProvider, so
    // useFederationOrNull() is null. It must degrade to the single-hub view rather
    // than throwing (which is why the component uses the OrNull variant).
    federation = null
    runnersData = [makeRunner()]
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
    expect(screen.getAllByTestId('runner-row').length).toBe(1)
    expect(screen.queryByTestId('runner-hub-cell')).toBeNull()
  })

  // --- Multiple hubs: one merged table, hub-routed actions -------------------

  it('two hubs: both hubs’ runners in ONE table, each labelled by hub', async () => {
    runnersByHub = {
      local: [makeRunner({ id: 'r-1', name: 'mac-studio' })],
      'hub-b': [
        makeRunner({ id: 'r-2', name: 'vps-1' }),
        makeRunner({ id: 'r-3', name: 'vps-2' })
      ]
    }
    federation = TWO_HUBS
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
    // ONE table — a merged list, not a section per hub (matches the flat rail).
    expect(screen.getAllByTestId('runners-table').length).toBe(1)
    expect(screen.getAllByTestId('runner-row').length).toBe(3)
    const hubCells = screen.getAllByTestId('runner-hub-cell').map((c) => c.textContent)
    expect(hubCells).toEqual(['Local', 'Hub B', 'Hub B'])
    // The count is the union, so it can't silently report only the default hub.
    expect(screen.getByText('3 runners enrolled')).toBeDefined()
  })

  it('two hubs: minting against the chosen hub hits THAT hub', async () => {
    federation = TWO_HUBS
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add-open'))
    })
    // Defaults to the default hub; choosing Hub B must reroute the mint.
    await act(async () => {
      fireEvent.change(screen.getByTestId('runner-add-hub'), { target: { value: 'hub-b' } })
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

  it('two hubs: mint defaults to the default hub when the picker is untouched', async () => {
    federation = TWO_HUBS
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add-open'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add'))
    })
    expect(mintSpy).toHaveBeenCalled()
    expect(remoteMintSpy).not.toHaveBeenCalled()
  })

  it('two hubs: revoking a remote row hits the REMOTE hub, with that row’s id', async () => {
    runnersByHub = {
      local: [makeRunner({ id: 'r-1', name: 'mac-studio' })],
      'hub-b': [makeRunner({ id: 'r-remote', name: 'vps-1' })]
    }
    federation = TWO_HUBS
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
    // Second row is Hub B's (rows render in registry order).
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
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
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
    federation = TWO_HUBS
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add-open'))
    })
    // Hub B mints wss://hub-b.example.com:8443/runners — reachable off-box.
    await act(async () => {
      fireEvent.change(screen.getByTestId('runner-add-hub'), { target: { value: 'hub-b' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-add'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('runner-minted-token')).toBeDefined()
    })
    expect(screen.queryByTestId('runner-token-loopback-warning')).toBeNull()
  })

  // --- local runner: restart / start ---------------------------------------
  //
  // The local runner is the app's own supervised child, so it is the ONE row this
  // client can act on as a process. Everything below pins that boundary: the
  // affordance must never appear on a runner we cannot actually control.

  it('offers restart on the local hub’s local-runner row only', async () => {
    runnersData = [makeRunner({ id: 'r-local', name: 'local-runner' }), makeRunner()]
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
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
    federation = TWO_HUBS
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
    expect(screen.getAllByTestId('runner-row').length).toBe(2)
    expect(screen.getAllByTestId('runner-local-restart').length).toBe(1)
  })

  it('restarts only after the confirm, since it kills every terminal on the machine', async () => {
    runnersData = [makeRunner({ id: 'r-local', name: 'local-runner' })]
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
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
    runnersData = [makeRunner()]
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
    expect(screen.getByTestId('runner-local-missing')).toBeDefined()
    await act(async () => {
      fireEvent.click(screen.getByTestId('runner-local-start'))
    })
    expect(restartLocalRunnerSpy).toHaveBeenCalledTimes(1)
  })

  it('never claims a REMOTE hub is missing its local runner', async () => {
    runnersByHub = { local: [], 'hub-b': [] }
    federation = TWO_HUBS
    await act(async () => {
      render(<RunnersSettingsTab />)
    })
    expect(screen.getAllByTestId('runner-local-missing').length).toBe(1)
  })
})
