/**
 * `getOrCreateHubClient` — the per-hub WS client registry.
 *
 * The case this file exists for: a hub's bearer token can only ever arrive AFTER
 * that hub has been added, because signing in requires a row to sign in to. The
 * add already opened the socket, so a cache keyed on id alone hands back the
 * untokened client forever and the hub stays permanently unauthenticated —
 * silently, since `connectionParams` is only sent at connect time. That was a
 * real break of `HubsSettingsTab.signIn()`'s no-relaunch path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Ids of sockets whose `close()` was actually CALLED (not merely created). */
const closed: string[] = []
let wsSeq = 0

vi.mock('@trpc/client', () => ({
  createWSClient: vi.fn((opts: { url: string; connectionParams?: unknown }) => {
    const id = `ws-${++wsSeq}`
    return {
      id,
      url: opts.url,
      // Recorded so a test can assert the token actually reached the socket
      // rather than merely being stored beside it.
      connectionParams: opts.connectionParams,
      close: vi.fn(() => closed.push(id)),
      connectionState: { subscribe: vi.fn() }
    }
  }),
  createTRPCClient: vi.fn(() => ({ marker: `client-${wsSeq}` })),
  wsLink: vi.fn(() => ({}))
}))
vi.mock('@trpc/tanstack-react-query', () => ({
  createTRPCContext: () => ({ TRPCProvider: null, useTRPC: null, useTRPCClient: null })
}))
vi.mock('superjson', () => ({ default: {} }))
vi.mock('./connectDeadlineLink', () => ({ connectDeadlineLink: vi.fn(() => ({})) }))

const { getOrCreateHubClient, _resetHubClients } = await import('./trpc')

const URL_A = 'ws://127.0.0.1:9001/trpc'

/** The token a socket was actually opened with, read back off the fake. */
async function openedToken(ws: unknown): Promise<string | undefined> {
  const params = (ws as { connectionParams?: () => Promise<{ token: string }> }).connectionParams
  return params ? (await params()).token : undefined
}

beforeEach(() => {
  _resetHubClients()
  closed.length = 0
})

describe('getOrCreateHubClient', () => {
  it('returns the SAME client for an unchanged (id, token)', () => {
    const first = getOrCreateHubClient({ id: 'remote-b', url: URL_A, token: 't1' })
    const second = getOrCreateHubClient({ id: 'remote-b', url: URL_A, token: 't1' })
    expect(second).toBe(first)
    expect(closed).toHaveLength(0)
  })

  it('rebuilds — and closes the old socket — when a token first arrives', async () => {
    // Exactly the add-then-sign-in order: added untokened, token arrives later.
    const untokened = getOrCreateHubClient({ id: 'remote-b', url: URL_A })
    expect(await openedToken(untokened.wsClient)).toBeUndefined()

    const authed = getOrCreateHubClient({ id: 'remote-b', url: URL_A, token: 'fresh' })
    expect(authed).not.toBe(untokened)
    expect(await openedToken(authed.wsClient)).toBe('fresh')
    // The stranded socket must not be left dangling — it would keep reconnecting
    // unauthenticated alongside the good one.
    expect(closed).toHaveLength(1)
  })

  it('rebuilds when a token changes or is cleared', () => {
    const a = getOrCreateHubClient({ id: 'remote-b', url: URL_A, token: 't1' })
    const b = getOrCreateHubClient({ id: 'remote-b', url: URL_A, token: 't2' })
    expect(b).not.toBe(a)
    const c = getOrCreateHubClient({ id: 'remote-b', url: URL_A })
    expect(c).not.toBe(b)
  })

  it('never rebuilds the DEFAULT hub', () => {
    // Its client IS the boot singleton every module-scope getTrpcClient() holds;
    // swapping it would leave those callers on a closed socket.
    const first = getOrCreateHubClient({ id: 'local', url: URL_A, isDefault: true })
    const second = getOrCreateHubClient({ id: 'local', url: URL_A, isDefault: true, token: 'x' })
    expect(second).toBe(first)
    expect(closed).toHaveLength(0)
  })

  it('keeps hubs isolated — a rebuild of one leaves the other alone', () => {
    const other = getOrCreateHubClient({ id: 'remote-c', url: URL_A, token: 'keep' })
    getOrCreateHubClient({ id: 'remote-b', url: URL_A })
    getOrCreateHubClient({ id: 'remote-b', url: URL_A, token: 'new' })
    expect(getOrCreateHubClient({ id: 'remote-c', url: URL_A, token: 'keep' })).toBe(other)
  })
})
