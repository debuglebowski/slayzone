// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'

// The mocks render the plain intrinsic element, so the intrinsic's own prop type
// is the honest signature. (Type-only imports survive vi.mock's hoisting because
// they are erased before the factory ever runs.)
vi.mock('@slayzone/ui', () => {
  return {
    Button: ({ children, ...props }: ComponentProps<'button'>) => (
      <button {...props}>{children}</button>
    ),
    Checkbox: (props: ComponentProps<'input'>) => <input type="checkbox" {...props} />,
    Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      open ? <div data-testid="dialog">{children}</div> : null,
    DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>
  }
})

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: ComponentProps<'div'>) => <div {...props}>{children}</div>,
    path: (props: ComponentProps<'path'>) => <path {...props} />,
    p: ({ children, ...props }: ComponentProps<'p'>) => <p {...props}>{children}</p>
  }
}))

vi.mock('lucide-react', () => ({
  Terminal: () => <span data-testid="terminal-icon" />
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
  useTRPCClient: () => trpcClientMock
}))

import { CliInstallDialog } from '@slayzone/settings'

function mockApi(
  overrides: { onboarded?: string | null; dismissed?: string | null; installed?: boolean } = {}
) {
  const { onboarded = 'true', dismissed = null, installed = true } = overrides
  trpcClientMock.settings.get.query.mockImplementation((input: { key: string }) => {
    if (input.key === 'onboarding_completed') return Promise.resolve(onboarded)
    if (input.key === 'cli_install_dismissed') return Promise.resolve(dismissed)
    return Promise.resolve(null)
  })
  trpcClientMock.settings.set.mutate.mockResolvedValue(undefined)
  trpcClientMock.app.meta.checkCliInstalled.query.mockResolvedValue({ installed })
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

  it('should NOT show when onboarding not completed', async () => {
    mockApi({ onboarded: null, installed: false })
    render(<CliInstallDialog />)

    await waitFor(() => {
      expect(trpcClientMock.app.meta.checkCliInstalled.query).toHaveBeenCalled()
    })

    expect(screen.queryByText('Install the slay CLI')).toBeNull()
  })

  it('should NOT show when user dismissed it', async () => {
    mockApi({ dismissed: 'true', installed: false })
    render(<CliInstallDialog />)

    await waitFor(() => {
      expect(trpcClientMock.app.meta.checkCliInstalled.query).toHaveBeenCalled()
    })

    expect(screen.queryByText('Install the slay CLI')).toBeNull()
  })
})
