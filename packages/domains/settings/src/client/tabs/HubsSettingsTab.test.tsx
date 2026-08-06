// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

/**
 * Sign in is offered only when a hub ACTUALLY gates its client API.
 *
 * A hub enforces bearer auth only in remote mode (`hubAuthRequired` in
 * apps/hub/src/server.ts); a loopback/LAN hub accepts an untokened connection, so
 * a Sign in button there is a prompt to do something pointless. The hub reports
 * the bit on `/health` (public, answered before the auth gate), which the tab
 * probes per remote row.
 *
 * The fallback direction is the load-bearing part: when the answer can't be had —
 * hub unreachable, or too old to report the field — the button STAYS, because
 * hiding it would remove the only way to authenticate against a hub that may
 * well be gating.
 */

type ProbeReply = { ok: boolean; normalizedUrl?: string; error?: string; authRequired?: boolean }

let registryHubs: Array<{ id: string; kind: string; label: string; url?: string }> = []
let hubTokens: Record<string, string> = {}
/** Keyed by the probed url — what that hub's /health answers. */
let probeReplies: Record<string, ProbeReply> = {}

vi.mock('@slayzone/transport/client', () => ({
  electronBootstrap: {
    getHubRegistry: () => Promise.resolve({ hubs: registryHubs, defaultHubId: 'local' }),
    getHubTokens: () => Promise.resolve(hubTokens),
    probeServerHealth: (url: string) =>
      Promise.resolve(probeReplies[url] ?? { ok: false, error: 'Unreachable' }),
    hubLogin: () => Promise.resolve({ ok: true as const, token: 't' }),
    restartSidecar: () => Promise.resolve({ ok: true as const }),
    setBootSettings: () => Promise.resolve({ ok: true as const }),
    relaunch: () => Promise.resolve()
  },
  useHubRegistryStore: { getState: () => ({ addHubs: vi.fn(), setTokens: vi.fn() }) }
}))

vi.mock('@slayzone/ui', () => {
  const Pass = ({ children }: any) => <>{children}</>
  return {
    Button: ({ children, onClick, disabled, ...props }: any) => (
      <button onClick={onClick} disabled={disabled} {...props}>
        {children}
      </button>
    ),
    Input: (props: any) => <input {...props} />,
    Switch: ({ checked, onCheckedChange, ...props }: any) => (
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
        {...props}
      />
    ),
    toast: { success: vi.fn(), error: vi.fn() },
    cn: (...parts: any[]) => parts.filter(Boolean).join(' '),
    Dialog: ({ open, children }: any) => (open ? <>{children}</> : null),
    DialogContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    DialogHeader: Pass,
    DialogTitle: ({ children }: any) => <div>{children}</div>,
    DialogDescription: ({ children }: any) => <div>{children}</div>,
    DialogFooter: Pass
  }
})

vi.mock('lucide-react', () => {
  const Icon = () => <span />
  return { Trash2: Icon, RotateCw: Icon, Plus: Icon, X: Icon, Pencil: Icon, PlugZap: Icon }
})

vi.mock('./SettingsTabIntro', () => ({ SettingsTabIntro: () => <div /> }))

const { HubsSettingsTab } = await import('./HubsSettingsTab')

const REMOTE_URL = 'ws://hub.example.com:7800/trpc'

/** One remote hub in the registry, whose /health answers `reply`. */
function seed(reply: ProbeReply, tokens: Record<string, string> = {}): void {
  registryHubs = [
    { id: 'local', kind: 'local', label: 'Local' },
    { id: 'hub:remote', kind: 'remote', label: 'Remote', url: REMOTE_URL }
  ]
  hubTokens = tokens
  probeReplies = { [REMOTE_URL]: reply }
}

/** Resolves once the row's probe has landed (Verify is the same round trip). */
async function rowSettled(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('hub-row-remote')).toBeTruthy())
  await waitFor(() => expect(screen.getByTestId('hub-verify')).toBeTruthy())
}

describe('HubsSettingsTab — Sign in visibility', () => {
  beforeEach(() => {
    registryHubs = []
    hubTokens = {}
    probeReplies = {}
  })
  afterEach(cleanup)

  it('hides Sign in when the hub reports it does not gate', async () => {
    seed({ ok: true, normalizedUrl: REMOTE_URL, authRequired: false })
    render(<HubsSettingsTab />)
    await rowSettled()
    // The probe resolves in a microtask; assert on a settled tree.
    await waitFor(() => expect(screen.queryByTestId('hub-signin-open')).toBeNull())
  })

  it('shows Sign in when the hub reports it gates', async () => {
    seed({ ok: true, normalizedUrl: REMOTE_URL, authRequired: true })
    render(<HubsSettingsTab />)
    await waitFor(() => expect(screen.getByTestId('hub-signin-open')).toBeTruthy())
  })

  it('keeps Sign in for a hub too old to report authRequired', async () => {
    seed({ ok: true, normalizedUrl: REMOTE_URL })
    render(<HubsSettingsTab />)
    await waitFor(() => expect(screen.getByTestId('hub-signin-open')).toBeTruthy())
  })

  it('keeps Sign in when the hub could not be reached', async () => {
    seed({ ok: false, error: 'ECONNREFUSED' })
    render(<HubsSettingsTab />)
    await waitFor(() => expect(screen.getByTestId('hub-signin-open')).toBeTruthy())
  })

  it('never offers Sign in once a token is stored, gating or not', async () => {
    seed({ ok: true, normalizedUrl: REMOTE_URL, authRequired: true }, { 'hub:remote': 'tok' })
    render(<HubsSettingsTab />)
    await rowSettled()
    await waitFor(() => expect(screen.getByTestId('hub-signed-in')).toBeTruthy())
    expect(screen.queryByTestId('hub-signin-open')).toBeNull()
  })
})
