// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

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

/**
 * The LIVE federation, which is a different registry from the draft one this tab
 * edits — null simulates the Chromium fork, which renders with no
 * FederationProvider at all.
 */
let federation: {
  hubs: Array<{ id: string; kind: string; label: string; url?: string }>
  defaultHubId: string
} | null = null

/** Whose `<HubScope>` is currently rendering, recorded by the mock below. */
let renderingHubId = ''

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
  useHubRegistryStore: { getState: () => ({ addHubs: vi.fn(), setTokens: vi.fn() }) },
  useFederationOrNull: () => federation,
  HubScope: ({ hubId, children }: any) => {
    renderingHubId = hubId
    return <>{children}</>
  }
}))

/**
 * The card's own behaviour is covered in HubCard.test.tsx. Here it only needs to
 * report WHETHER a hub got the computer-owning card and under WHICH scope — this
 * file is about which hubs can have a computer list at all.
 *
 * Both exports are stubbed, and both render the hub's identity + controls slots:
 * the Sign in / Verify / signed-in assertions below live in those slots, and a
 * not-connected remote goes through the SHELL rather than the card.
 */
const header = (headerTestId: string, identity: any, status: any, primary: any, more: any) => (
  <div data-testid={headerTestId}>
    {identity}
    {status}
    {primary}
    {more}
  </div>
)

vi.mock('./HubCard', () => ({
  HubCard: ({ hubId, isLocalHub, identity, status, primary, more, headerTestId }: any) => (
    <div data-testid={`hub-group-${hubId}`}>
      {header(headerTestId, identity, status, primary, more)}
      <div
        data-testid="hub-card-live"
        data-hub={hubId}
        data-scope={renderingHubId}
        data-local={String(isLocalHub)}
      />
    </div>
  ),
  HubCardShell: ({ hubId, headerTestId, identity, status, primary, more, body }: any) => (
    <div data-testid={`hub-group-${hubId}`}>
      {header(headerTestId, identity, status, primary, more)}
      {body}
    </div>
  ),
  HubStatus: ({ tone, label }: any) => (
    <span data-testid="hub-status" data-tone={tone}>
      {label}
    </span>
  ),
  ComputersHeading: ({ note, noteTestId }: any) => (
    <div>
      <span>Computers</span>
      {note ? <span data-testid={noteTestId}>{note}</span> : null}
    </div>
  )
}))

vi.mock('./ComputerActions', () => ({
  ComputerActionsProvider: ({ children }: any) => <>{children}</>
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
    // Menu content renders inline: these tests are about WHICH actions a hub
    // offers, not about the menu's open/close mechanics (Radix owns that).
    DropdownMenu: ({ children }: any) => <>{children}</>,
    DropdownMenuTrigger: ({ children }: any) => <>{children}</>,
    DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
    DropdownMenuItem: ({ children, onSelect, disabled, ...props }: any) => (
      <button onClick={onSelect} disabled={disabled} {...props}>
        {children}
      </button>
    ),
    DropdownMenuCheckboxItem: ({ children, checked, onCheckedChange, disabled, ...props }: any) => (
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
        aria-label={typeof children === 'string' ? children : undefined}
        {...props}
      />
    ),
    DropdownMenuSeparator: () => <hr />,
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
  return {
    Trash2: Icon,
    RotateCw: Icon,
    Plus: Icon,
    X: Icon,
    Pencil: Icon,
    PlugZap: Icon,
    Star: Icon,
    MoreHorizontal: Icon
  }
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
    federation = null
    renderingHubId = ''
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

/**
 * Computers are listed INSIDE their hub. Which means the tab has to reconcile two
 * different registries: the draft boot-config it edits, and the live federation a
 * computer list can actually be queried through. A hub present in the first but not
 * the second must say so — an empty list there would be a false claim about that
 * hub's configuration rather than a description of a hub we haven't connected to.
 */
describe('HubsSettingsTab — nested computers', () => {
  beforeEach(() => {
    registryHubs = []
    hubTokens = {}
    probeReplies = {}
    federation = null
    renderingHubId = ''
  })
  afterEach(cleanup)

  const LIVE_LOCAL = {
    id: 'local',
    kind: 'local',
    label: 'Local',
    url: 'ws://127.0.0.1:51100/trpc'
  }
  const LIVE_REMOTE = { id: 'hub:remote', kind: 'remote', label: 'Remote', url: REMOTE_URL }

  /** Every live computer-owning card on screen, as `{hub, scope}` pairs. */
  const blocks = (): Array<{ hub: string | null; scope: string | null; local: string | null }> =>
    screen.queryAllByTestId('hub-card-live').map((el) => ({
      hub: el.getAttribute('data-hub'),
      scope: el.getAttribute('data-scope'),
      local: el.getAttribute('data-local')
    }))

  it('gives every connected hub its own block, inside that hub’s scope', async () => {
    seed({ ok: true, normalizedUrl: REMOTE_URL, authRequired: false })
    federation = { hubs: [LIVE_LOCAL, LIVE_REMOTE], defaultHubId: 'local' }
    render(<HubsSettingsTab />)
    await rowSettled()
    await waitFor(() => expect(blocks().length).toBe(2))
    // Each block's ambient scope must be its OWN hub — that is what makes its
    // mint and revoke hub-correct by construction rather than by lookup.
    expect(blocks()).toEqual([
      { hub: 'local', scope: 'local', local: 'true' },
      { hub: 'hub:remote', scope: 'hub:remote', local: 'false' }
    ])
  })

  it('marks a hub that is not connected yet instead of showing an empty list', async () => {
    // In the draft registry, absent from the live federation: added but not yet
    // saved + relaunched.
    seed({ ok: true, normalizedUrl: REMOTE_URL, authRequired: false })
    federation = { hubs: [LIVE_LOCAL], defaultHubId: 'local' }
    render(<HubsSettingsTab />)
    await rowSettled()
    await waitFor(() => expect(blocks().length).toBe(1))
    expect(blocks()[0]?.hub).toBe('local')
    expect(screen.getByTestId('hub-computers-unavailable').textContent).toContain(
      'not connected yet'
    )
  })

  it('says the local hub is off rather than listing computers for it', async () => {
    // No local entry in the registry = "run a local hub" is off. Nothing on this
    // machine can execute, so a computer list would be meaningless.
    registryHubs = [{ id: 'hub:remote', kind: 'remote', label: 'Remote', url: REMOTE_URL }]
    probeReplies = { [REMOTE_URL]: { ok: true, normalizedUrl: REMOTE_URL, authRequired: false } }
    federation = { hubs: [LIVE_REMOTE], defaultHubId: 'hub:remote' }
    render(<HubsSettingsTab />)
    await rowSettled()
    await waitFor(() => expect(blocks().length).toBe(1))
    expect(blocks()[0]?.hub).toBe('hub:remote')
    expect(screen.getByTestId('hub-computers-unavailable').textContent).toContain(
      'local hub is off'
    )
  })

  it('gives every hub the same status vocabulary', async () => {
    // The point of the fixed slots: the column means the same thing all the way
    // down, so a list of hubs can be scanned rather than read one card at a time.
    seed({ ok: true, normalizedUrl: REMOTE_URL, authRequired: true })
    federation = { hubs: [LIVE_LOCAL, LIVE_REMOTE], defaultHubId: 'local' }
    render(<HubsSettingsTab />)
    await rowSettled()
    await waitFor(() => expect(screen.getAllByTestId('hub-status').length).toBe(2))
    expect(screen.getAllByTestId('hub-status').map((e) => e.textContent)).toEqual([
      'Running',
      'Signed out'
    ])
  })

  it('reports a failed verify as Unreachable, outranking a stored token', async () => {
    // A Verify result is the freshest thing we know about a hub, so it wins over
    // "we have a token for it" — a signed-in hub that just refused a connection
    // is not "Signed in" in any sense the operator cares about.
    seed({ ok: false, error: 'ECONNREFUSED' }, { 'hub:remote': 'tok' })
    federation = { hubs: [LIVE_LOCAL, LIVE_REMOTE], defaultHubId: 'local' }
    render(<HubsSettingsTab />)
    await rowSettled()
    await waitFor(() => expect(screen.getByTestId('hub-signed-in')).toBeTruthy())
    fireEvent.click(screen.getByTestId('hub-verify'))
    await waitFor(() =>
      expect(screen.getAllByTestId('hub-status').map((e) => e.textContent)).toContain('Unreachable')
    )
  })

  it('marks exactly one hub as default, and cannot unset it', async () => {
    seed({ ok: true, normalizedUrl: REMOTE_URL, authRequired: false })
    federation = { hubs: [LIVE_LOCAL, LIVE_REMOTE], defaultHubId: 'local' }
    render(<HubsSettingsTab />)
    await rowSettled()
    // Local holds it: its star is checked and disabled (there is always a default,
    // so the only meaningful click is on a hub that does NOT hold it).
    expect(screen.getByTestId('hub-default-local').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('hub-default-local').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('hub-default-remote').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByTestId('hub-default-remote'))
    await waitFor(() =>
      expect(screen.getByTestId('hub-default-remote').getAttribute('aria-checked')).toBe('true')
    )
    expect(screen.getByTestId('hub-default-local').getAttribute('aria-checked')).toBe('false')
  })

  it('fork (no federation at all): the local hub still lists its computers', async () => {
    // The Chromium fork renders this surface outside a FederationProvider. It must
    // degrade to the single-hub view rather than throwing — which is why the
    // component uses the OrNull variant.
    registryHubs = [{ id: 'local', kind: 'local', label: 'Local' }]
    federation = null
    render(<HubsSettingsTab />)
    await waitFor(() => expect(blocks().length).toBe(1))
    // No scope was entered — the ambient client is the only hub there is.
    expect(blocks()[0]).toEqual({ hub: 'local', scope: '', local: 'true' })
  })
})
