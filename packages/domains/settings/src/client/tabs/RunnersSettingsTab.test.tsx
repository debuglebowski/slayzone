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

const mintSpy = vi.fn(() => Promise.resolve({ token: 'szjt1.MOCKTOKEN', label: 'x' } as any))
const revokeSpy = vi.fn(() => Promise.resolve({ ok: true as const }))

// tRPC transport. The component reads `trpc.runners.*` query/mutation builders.
// No bootstrap IPCs — enrollment is always available (a hub always accepts runners).
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    runners: {
      list: { queryOptions: () => ({}), queryFilter: () => ({}) },
      mintJoinToken: { mutationOptions: () => ({ __key: 'mint' }) },
      revokeRunner: { mutationOptions: () => ({ __key: 'revoke' }) }
    }
  })
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
    AlertDialog: Pass,
    AlertDialogAction: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
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

beforeEach(() => {
  runnersData = []
  mintSpy.mockClear()
  revokeSpy.mockClear()
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
})
