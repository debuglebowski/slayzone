// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

vi.mock('@slayzone/ui', () => {
  return {
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
    Checkbox: (props: any) => <input type="checkbox" {...props} />,
    Dialog: ({ children, open }: any) => open ? <div data-testid="dialog">{children}</div> : null,
    DialogContent: ({ children }: any) => <div>{children}</div>,
  }
})

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    path: (props: any) => <path {...props} />,
    p: ({ children, ...props }: any) => <p {...props}>{children}</p>,
  },
}))

vi.mock('lucide-react', () => ({
  Terminal: () => <span data-testid="terminal-icon" />,
}))

import { CliInstallDialog } from './CliInstallDialog'

function mockApi(overrides: { onboarded?: string | null; dismissed?: string | null; installed?: boolean } = {}) {
  const { onboarded = 'true', dismissed = null, installed = true } = overrides
  ;(window as any).api = {
    settings: {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === 'onboarding_completed') return Promise.resolve(onboarded)
        if (key === 'cli_install_dismissed') return Promise.resolve(dismissed)
        return Promise.resolve(null)
      }),
      set: vi.fn().mockResolvedValue(undefined),
    },
    app: {
      cliStatus: vi.fn().mockResolvedValue({ installed }),
      installCli: vi.fn().mockResolvedValue({ ok: true }),
    },
  }
}

afterEach(cleanup)

describe('CliInstallDialog', () => {
  it('should NOT show when CLI is installed', async () => {
    mockApi({ installed: true })
    render(<CliInstallDialog />)

    // Wait for async check to complete
    await waitFor(() => {
      expect(window.api.app.cliStatus).toHaveBeenCalled()
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
      expect(window.api.app.cliStatus).toHaveBeenCalled()
    })

    expect(screen.queryByText('Install the slay CLI')).toBeNull()
  })

  it('should NOT show when user dismissed it', async () => {
    mockApi({ dismissed: 'true', installed: false })
    render(<CliInstallDialog />)

    await waitFor(() => {
      expect(window.api.app.cliStatus).toHaveBeenCalled()
    })

    expect(screen.queryByText('Install the slay CLI')).toBeNull()
  })
})
