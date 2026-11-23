// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'

// The mocks render the plain intrinsic element, so the intrinsic's own prop type
// is the honest signature. (Type-only imports survive vi.mock's hoisting because
// they are erased before the factory ever runs.)
const toastMock = vi.fn()
const toastCustom = vi.fn()
const toastSuccess = vi.fn()
const toastDismiss = vi.fn()
vi.mock('@slayzone/ui', () => {
  return {
    toast: Object.assign((...args: unknown[]) => toastMock(...args), {
      custom: (...args: unknown[]) => toastCustom(...args),
      success: (...args: unknown[]) => toastSuccess(...args),
      dismiss: (...args: unknown[]) => toastDismiss(...args)
    }),
    Button: ({ children, ...props }: ComponentProps<'button'>) => (
      <button {...props}>{children}</button>
    ),
    Checkbox: (props: ComponentProps<'input'>) => <input type="checkbox" {...props} />,
    Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      open ? <div data-testid="dialog">{children}</div> : null,
    DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>
  }
})

vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: ComponentProps<'div'>) => <div {...props}>{children}</div>,
    path: (props: ComponentProps<'path'>) => <path {...props} />,
    p: ({ children, ...props }: ComponentProps<'p'>) => <p {...props}>{children}</p>
  }
}))

vi.mock('lucide-react', () => ({
  Terminal: () => <span data-testid="terminal-icon" />,
  ArrowRight: () => <span />,
  Loader2: () => <span />,
  X: () => <span />
}))

// tRPC client mock — CliInstallDialog now calls trpcClient.* (imperative vanilla
// client) instead of window.api.*. The mock mirrors the tanstack client shape:
// nested router → procedure → { query | mutate }.
const trpcClientMock = {
  settings: {
    get: { query: vi.fn() },
    set: { mutate: vi.fn() }
  },
  app: {
    meta: {
      checkCliInstalled: { query: vi.fn() },
      installCli: { mutate: vi.fn() }
    }
  }
}

vi.mock('@slayzone/transport/client', () => ({
  useTRPCClient: () => trpcClientMock,
  // settings' typed view (`@slayzone/settings` client/trpc.ts) is built from this.
  typedTrpc: () => ({ useTRPCClient: () => trpcClientMock })
}))

import { CliInstallDialog } from '@slayzone/settings/client/CliInstallDialog'

function mockApi(
  overrides: {
    onboarded?: string | null
    dismissed?: string | null
    updateDismissed?: string | null
    installed?: boolean
    status?: Record<string, unknown>
  } = {}
) {
  const {
    onboarded = 'true',
    dismissed = null,
    updateDismissed = null,
    installed = true
  } = overrides
  trpcClientMock.settings.get.query.mockImplementation((input: { key: string }) => {
    if (input.key === 'onboarding_completed') return Promise.resolve(onboarded)
    if (input.key === 'cli_install_dismissed') return Promise.resolve(dismissed)
    if (input.key === 'cli_update_dismissed_version') return Promise.resolve(updateDismissed)
    return Promise.resolve(null)
  })
  trpcClientMock.settings.set.mutate.mockResolvedValue(undefined)
  trpcClientMock.app.meta.checkCliInstalled.query.mockResolvedValue(
    overrides.status ?? { installed }
  )
  trpcClientMock.app.meta.installCli.mutate.mockResolvedValue({ ok: true })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('CliInstallDialog', () => {
  it('should NOT show when CLI is installed', async () => {
    mockApi({ installed: true })
    render(<CliInstallDialog />)

    // Wait for async check to complete
    await waitFor(() => {
      expect(trpcClientMock.app.meta.checkCliInstalled.query).toHaveBeenCalled()
    })

    expect(screen.queryByText('Install the slay CLI')).toBeNull()
  })

  it('should show when CLI is not installed, onboarding done, not dismissed', async () => {
    mockApi({ installed: false })
    render(<CliInstallDialog />)

    await waitFor(() => {
      expect(screen.getByText('Install the slay CLI')).toBeDefined()
    })
  })

  it('should NOT show (nor probe) when onboarding not completed', async () => {
    mockApi({ onboarded: null, installed: false })
    render(<CliInstallDialog />)

    await waitFor(() => {
      expect(trpcClientMock.settings.get.query).toHaveBeenCalled()
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(trpcClientMock.app.meta.checkCliInstalled.query).not.toHaveBeenCalled()
    expect(screen.queryByText('Install the slay CLI')).toBeNull()
  })

  it('should NOT show (nor probe) when user dismissed it', async () => {
    mockApi({ dismissed: 'true', installed: false })
    render(<CliInstallDialog />)

    await waitFor(() => {
      expect(trpcClientMock.settings.get.query).toHaveBeenCalled()
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(trpcClientMock.app.meta.checkCliInstalled.query).not.toHaveBeenCalled()
    expect(screen.queryByText('Install the slay CLI')).toBeNull()
    expect(toastCustom).not.toHaveBeenCalled()
  })

  const outdated = {
    installed: true,
    path: '/home/u/.local/node/bin/slay',
    version: '0.36.0',
    expectedVersion: '0.37.2',
    outdated: true,
    appManaged: false
  }

  it('outdated CLI → non-blocking notice, no dialog', async () => {
    mockApi({ status: outdated })
    render(<CliInstallDialog />)

    await waitFor(() => expect(toastCustom).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Install the slay CLI')).toBeNull()
    renderLatestNotice()
    expect(screen.getByText('slay CLI update available')).toBeDefined()
    expect(screen.getByText('v0.36.0')).toBeDefined()
    expect(screen.getByText('v0.37.2')).toBeDefined()
    // Not ours to touch: says where it lives, offers no Update.
    expect(screen.getByText(outdated.path)).toBeDefined()
    expect(screen.queryByText('Update')).toBeNull()
  })

  it('app-managed outdated CLI → Update refreshes it in place', async () => {
    mockApi({ status: { ...outdated, path: '/usr/local/bin/slay', appManaged: true } })
    render(<CliInstallDialog />)

    await waitFor(() => expect(toastCustom).toHaveBeenCalledTimes(1))
    renderLatestNotice()
    expect(screen.queryByText('/usr/local/bin/slay')).toBeNull()
    fireEvent.click(screen.getByText('Update'))

    expect(trpcClientMock.app.meta.installCli.mutate).toHaveBeenCalledTimes(1)
    cleanup()
    renderLatestNotice()
    expect(screen.getByText('Updating…')).toBeDefined()
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1))
    expect(String(toastSuccess.mock.calls[0][0])).toContain('0.37.2')
  })

  it('failed update → error + Retry in the same notice', async () => {
    mockApi({ status: { ...outdated, appManaged: true } })
    trpcClientMock.app.meta.installCli.mutate.mockResolvedValue({ ok: false, error: 'EPERM' })
    render(<CliInstallDialog />)

    await waitFor(() => expect(toastCustom).toHaveBeenCalledTimes(1))
    renderLatestNotice()
    fireEvent.click(screen.getByText('Update'))
    await waitFor(() => expect(toastCustom).toHaveBeenCalledTimes(3))
    cleanup()
    renderLatestNotice()
    expect(screen.getByText('EPERM')).toBeDefined()
    expect(screen.getByText('Retry')).toBeDefined()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('Skip this version → remembers the app version', async () => {
    mockApi({ status: outdated })
    render(<CliInstallDialog />)

    await waitFor(() => expect(toastCustom).toHaveBeenCalledTimes(1))
    renderLatestNotice()
    fireEvent.click(screen.getByText('Skip this version'))
    expect(trpcClientMock.settings.set.mutate).toHaveBeenCalledWith({
      key: 'cli_update_dismissed_version',
      value: '0.37.2'
    })
    expect(toastDismiss).toHaveBeenCalledWith('cli-update-notice')
  })

  it('outdated notice already dismissed for this version → silent', async () => {
    mockApi({ status: outdated, updateDismissed: '0.37.2' })
    render(<CliInstallDialog />)

    await waitFor(() => {
      expect(trpcClientMock.app.meta.checkCliInstalled.query).toHaveBeenCalled()
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(toastCustom).not.toHaveBeenCalled()
  })

  it('current CLI → nothing', async () => {
    mockApi({ status: { ...outdated, version: '0.37.2', outdated: false } })
    render(<CliInstallDialog />)

    await waitFor(() => {
      expect(trpcClientMock.app.meta.checkCliInstalled.query).toHaveBeenCalled()
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(toastCustom).not.toHaveBeenCalled()
    expect(screen.queryByText('Install the slay CLI')).toBeNull()
  })
})

/** Mount what the latest `toast.custom` call would render. */
function renderLatestNotice() {
  const calls = toastCustom.mock.calls
  const renderFn = calls[calls.length - 1][0] as (id: string) => ReactNode
  render(<>{renderFn('cli-update-notice')}</>)
}
