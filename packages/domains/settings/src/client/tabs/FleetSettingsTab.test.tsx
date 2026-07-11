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
let bootConfigReturn: { fleetMode: boolean } = { fleetMode: false }

const getBootConfigSpy = vi.fn(() => Promise.resolve(bootConfigReturn))
const setBootSettingsSpy = vi.fn(() => Promise.resolve({ ok: true as const }))
const relaunchSpy = vi.fn(() => Promise.resolve())

const mintSpy = vi.fn(() => Promise.resolve({ token: 'szjt1.MOCKTOKEN', label: 'x' } as any))
const revokeSpy = vi.fn(() => Promise.resolve({ ok: true as const }))

// tRPC transport + bootstrap. The component reads `trpc.runners.*` query/mutation
// option builders + the `electronBootstrap` bootstrap IPCs.
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    runners: {
      list: { queryOptions: () => ({}), queryFilter: () => ({}) },
      mintJoinToken: { mutationOptions: () => ({ __key: 'mint' }) },
      revokeRunner: { mutationOptions: () => ({ __key: 'revoke' }) }
    }
  }),
  electronBootstrap: {
    getBootConfig: () => getBootConfigSpy(),
    setBootSettings: (p: unknown) => setBootSettingsSpy(p),
    relaunch: () => relaunchSpy()
  }
}))

// react-query: useQuery surfaces the runners list; useMutation routes to the
// mint/revoke spy by the `__key` marker its mutationOptions() stub carries.
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: runnersData }),
  useMutation: (opts: { __key?: string }) => ({
    mutateAsync: opts?.__key === 'revoke' ? revokeSpy : mintSpy,
    isPending: false
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() })
}))

// @slayzone/ui — light stubs. Switch → a role=switch button toggling on click;
// AlertDialog family are passthroughs so the confirm action is always reachable.
vi.mock('@slayzone/ui', () => {
  const Pass = ({ children }: any) => <>{children}</>
  return {
    Button: ({ children, onClick, disabled, ...props }: any) => (
      <button onClick={onClick} disabled={disabled} {...props}>
        {children}
      </button>
    ),
    Switch: ({ checked, onCheckedChange, disabled, ...props }: any) => (
      <button
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        {...props}
      />
    ),
    Input: (props: any) => <input {...props} />,
    Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
    Card: Pass,
    CardHeader: Pass,
    CardTitle: ({ children }: any) => <div>{children}</div>,
    CardDescription: ({ children }: any) => <div>{children}</div>,
    CardContent: Pass,
    AlertDialog: Pass,
    AlertDialogAction: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
    AlertDialogCancel: ({ children }: any) => <button>{children}</button>,
    AlertDialogContent: Pass,
    AlertDialogDescription: Pass,
    AlertDialogFooter: Pass,
    AlertDialogHeader: Pass,
    AlertDialogTitle: ({ children }: any) => <div>{children}</div>,
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

import { FleetSettingsTab } from './FleetSettingsTab'

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

beforeEach(() => {
  runnersData = []
  bootConfigReturn = { fleetMode: false }
  getBootConfigSpy.mockClear()
  setBootSettingsSpy.mockClear()
  relaunchSpy.mockClear()
  mintSpy.mockClear()
  revokeSpy.mockClear()
})

afterEach(cleanup)

describe('FleetSettingsTab', () => {
  it('renders the Fleet tab header and mode toggle', async () => {
    await act(async () => {
      render(<FleetSettingsTab />)
    })
    expect(screen.getByRole('heading', { name: 'Fleet' })).toBeDefined()
    expect(screen.getByTestId('fleet-mode-toggle')).toBeDefined()
  })

  it('reflects the booted fleet_mode (on) in the toggle', async () => {
    bootConfigReturn = { fleetMode: true }
    await act(async () => {
      render(<FleetSettingsTab />)
    })
    await waitFor(() => {
      expect(screen.getByTestId('fleet-mode-toggle').getAttribute('aria-checked')).toBe('true')
    })
    expect(getBootConfigSpy).toHaveBeenCalled()
  })

  it('writes fleet_mode + relaunches when toggled on and saved', async () => {
    await act(async () => {
      render(<FleetSettingsTab />)
    })
    // Wait for getBootConfig to resolve → toggle enabled (not disabled).
    await waitFor(() => {
      expect(screen.getByTestId('fleet-mode-toggle').hasAttribute('disabled')).toBe(false)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('fleet-mode-toggle'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('fleet-save-relaunch'))
    })
    expect(setBootSettingsSpy).toHaveBeenCalledWith({ fleet_mode: true })
    expect(relaunchSpy).toHaveBeenCalled()
  })

  it('enrollment is disabled + explained until fleet is booted on', async () => {
    await act(async () => {
      render(<FleetSettingsTab />)
    })
    expect(screen.getByTestId('fleet-enroll-disabled')).toBeDefined()
    expect(screen.getByTestId('fleet-add-runner').hasAttribute('disabled')).toBe(true)
  })

  it('mints an enrollment token when fleet is booted on', async () => {
    bootConfigReturn = { fleetMode: true }
    await act(async () => {
      render(<FleetSettingsTab />)
    })
    await waitFor(() => {
      expect(screen.getByTestId('fleet-add-runner').hasAttribute('disabled')).toBe(false)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('fleet-add-runner'))
    })
    expect(mintSpy).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByTestId('fleet-minted-token')).toBeDefined()
    })
  })

  it('dismisses the minted token via the Done control', async () => {
    bootConfigReturn = { fleetMode: true }
    await act(async () => {
      render(<FleetSettingsTab />)
    })
    await waitFor(() => {
      expect(screen.getByTestId('fleet-add-runner').hasAttribute('disabled')).toBe(false)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('fleet-add-runner'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('fleet-minted-token')).toBeDefined()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('fleet-token-dismiss'))
    })
    expect(screen.queryByTestId('fleet-minted-token')).toBeNull()
  })

  it('clears a minted token when fleet mode is toggled off', async () => {
    bootConfigReturn = { fleetMode: true }
    await act(async () => {
      render(<FleetSettingsTab />)
    })
    await waitFor(() => {
      expect(screen.getByTestId('fleet-add-runner').hasAttribute('disabled')).toBe(false)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('fleet-add-runner'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('fleet-minted-token')).toBeDefined()
    })
    // Toggle fleet off — the on-screen one-time secret must not linger.
    await act(async () => {
      fireEvent.click(screen.getByTestId('fleet-mode-toggle'))
    })
    expect(screen.queryByTestId('fleet-minted-token')).toBeNull()
  })

  it('renders enrolled runners as rows', async () => {
    runnersData = [
      makeRunner(),
      makeRunner({ id: 'r-2', name: 'linux-box', platform: 'linux-x64', connected: false })
    ]
    await act(async () => {
      render(<FleetSettingsTab />)
    })
    expect(screen.getAllByTestId('fleet-runner-row').length).toBe(2)
    expect(screen.getByText('mac-studio')).toBeDefined()
    expect(screen.getByText('linux-box')).toBeDefined()
    expect(screen.getByText('darwin-arm64')).toBeDefined()
  })

  it('fires the revoke mutation after confirming', async () => {
    runnersData = [makeRunner()]
    await act(async () => {
      render(<FleetSettingsTab />)
    })
    // Row revoke button opens the confirm dialog (sets the target).
    await act(async () => {
      fireEvent.click(screen.getByTestId('fleet-revoke'))
    })
    // Confirm — AlertDialogAction labelled "Revoke".
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    })
    expect(revokeSpy).toHaveBeenCalledWith({ runnerId: 'r-1' })
  })
})
