/**
 * `initTrpcClient`'s `token` param — added for the web shell (packages/apps/
 * web-shell), whose hub enforces auth unconditionally and therefore MUST open
 * its primary WS connection with a bearer, unlike every prior caller (desktop's
 * default hub is loopback-trusted; the fork's standalone sidecar has auth off).
 *
 * Scope: this file exists for the `token` threading + idempotent-singleton
 * interaction, since `initTrpcClient`'s "first call wins" cache means a token
 * supplied on a LATER call (e.g. `renderer-app`'s own internal call inside
 * `mountApp()`) would be silently ignored — the web shell's boot sequence
 * depends on its own pre-init call being the one that decides the link stack.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

let wsSeq = 0

vi.mock('@trpc/client', () => ({
  createWSClient: vi.fn((opts: { url: string; connectionParams?: unknown }) => {
    wsSeq++
    return {
      id: `ws-${wsSeq}`,
      url: opts.url,
      connectionParams: opts.connectionParams,
      close: vi.fn(),
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

const { initTrpcClient, _setTrpcClientSingleton } = await import('./trpc')

const URL_A = 'wss://example.test/trpc'

async function openedToken(ws: unknown): Promise<string | undefined> {
  const params = (ws as { connectionParams?: () => Promise<{ token: string }> }).connectionParams
  return params ? (await params()).token : undefined
}

beforeEach(() => {
  // Forces the next initTrpcClient call to rebuild — the guard is an OR over
  // both singleton refs, so clearing just this one is sufficient.
  _setTrpcClientSingleton(null)
})

describe('initTrpcClient token threading', () => {
  it('omitted token → no connectionParams frame (byte-identical to every existing caller)', async () => {
    const { wsClient } = initTrpcClient(URL_A)
    expect(await openedToken(wsClient)).toBeUndefined()
  })

  it('a supplied token reaches the underlying WS client', async () => {
    const { wsClient } = initTrpcClient(URL_A, { token: 'szw_abc123' })
    expect(await openedToken(wsClient)).toBe('szw_abc123')
  })

  it('idempotent: a SECOND call with a token is ignored once the singleton exists untokened', async () => {
    // This is the exact hazard the web shell's boot sequence must avoid: if
    // renderer-app's own internal initTrpcClient(trpcUrl) call (no token, no
    // extra links) ran FIRST, a later call supplying the real token would be a
    // silent no-op cache hit — the web shell must win the race by calling
    // initTrpcClient with its token BEFORE mountApp() gets a chance to.
    const first = initTrpcClient(URL_A)
    const second = initTrpcClient(URL_A, { token: 'szw_should-be-ignored' })
    expect(second.client).toBe(first.client)
    expect(await openedToken(second.wsClient)).toBeUndefined()
  })
})
