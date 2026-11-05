// @vitest-environment jsdom
/**
 * Phase 2 de-risk — the load-bearing federation invariant: two HubScopes for two
 * different hubs must resolve `useTRPC()` to their OWN hub's client AND keep
 * their React-Query caches isolated, so the SAME query key backed by the SAME
 * project id on two hubs never bleeds across.
 *
 * We stub the WS-client factory (`getOrCreateHubClient`) so no real socket opens;
 * each fake client returns a hub-distinguishing value for `hub.describe`. The
 * real FederationProvider + HubScope + TRPCProvider + per-hub QueryClient wiring
 * is exercised end to end.
 */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createTRPCClient, type TRPCLink } from '@trpc/client'
import type { AnyTRPCRouter } from '@trpc/server'
import { observable } from '@trpc/server/observable'

// Fake per-hub clients keyed by hub id. Built with the REAL createTRPCClient so
// the tanstack integration's untyped-client symbol is present (a plain object
// hangs forever) — a custom terminating link resolves `hub.describe` locally to
// a label naming its hub, so a bleed (wrong client / shared cache) is visible.
const describeCalls: Record<string, number> = {}
function localLink(id: string): TRPCLink<AnyTRPCRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        if (op.path === 'hub.describe') {
          describeCalls[id] = (describeCalls[id] ?? 0) + 1
          observer.next({
            result: {
              data: { label: `hub:${id}`, version: '0', authRequired: false }
            }
          })
          observer.complete()
        } else {
          // Any other op answers with the hub that served it — what the
          // host-routing tests read.
          if (op.type === 'subscription') observer.next({ result: { type: 'started' } })
          observer.next({ result: { type: 'data', data: `${id}|${op.path}` } })
          if (op.type !== 'subscription') observer.complete()
        }
        return () => undefined
      })
}
function fakeClientFor(id: string, links: TRPCLink<AnyTRPCRouter>[] = []): unknown {
  return createTRPCClient<AnyTRPCRouter>({ links: [...links, localLink(id)] })
}

// Records the LAST opts getOrCreateHubClient was called with, per hub id — so a
// test can assert the token/isDefault routing contract (the security-relevant
// branch: the default hub must get NO token, each remote must get ONLY its own).
const clientOpts: Record<string, { url: string; isDefault?: boolean; token?: string }> = {}
/** Hub ids whose socket `closeHubClient` was asked to close, in order. */
const closedHubs: string[] = []

vi.mock('./runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime')>()
  const clients = new Map<string, { id: string; url: string; client: unknown; wsClient: unknown }>()
  return {
    ...actual,
    getOrCreateHubClient: (opts: {
      id: string
      url: string
      isDefault?: boolean
      links?: TRPCLink<AnyTRPCRouter>[]
      token?: string
    }) => {
      clientOpts[opts.id] = { url: opts.url, isDefault: opts.isDefault, token: opts.token }
      let e = clients.get(opts.id)
      if (!e) {
        e = {
          id: opts.id,
          url: opts.url,
          client: fakeClientFor(opts.id, opts.links),
          wsClient: {}
        }
        clients.set(opts.id, e)
      }
      return e
    },
    getHubClient: (id: string) => clients.get(id) ?? null,
    closeHubClient: (id: string) => {
      closedHubs.push(id)
      return clients.delete(id)
    }
  }
})

const { FederationProvider } = await import('./FederationProvider')
const { HubScope } = await import('./HubScope')
const { trpcFor } = await import('./view')
const { useTRPC } = trpcFor<AnyTRPCRouter>()
const { useQuery } = await import('@tanstack/react-query')

function HubLabel(): React.ReactNode {
  const trpc = useTRPC() as unknown as {
    hub: { describe: { queryOptions: () => unknown } }
  }
  // Same query key ('hub.describe', no input) in BOTH scopes — the isolation
  // must come from the per-hub QueryClient, not from a differing key.
  const q = useQuery(trpc.hub.describe.queryOptions() as never) as { data?: { label: string } }
  return <span>{q.data?.label ?? 'loading'}</span>
}

const HUBS = [
  { id: 'local', kind: 'local' as const, label: 'Local', url: 'ws://127.0.0.1:1/trpc' },
  { id: 'remote-a', kind: 'remote' as const, label: 'A', url: 'wss://a.example/trpc' }
]

describe('federation: per-hub client + cache isolation', () => {
  afterEach(cleanup)

  it('each HubScope resolves useTRPC to its own hub client (no bleed)', async () => {
    render(
      <FederationProvider hubs={HUBS} defaultHubId="local">
        <div data-testid="local-scope">
          <HubScope hubId="local">
            <HubLabel />
          </HubScope>
        </div>
        <div data-testid="remote-scope">
          <HubScope hubId="remote-a">
            <HubLabel />
          </HubScope>
        </div>
      </FederationProvider>
    )
    await waitFor(() => {
      expect(screen.getByTestId('local-scope').textContent).toBe('hub:local')
      expect(screen.getByTestId('remote-scope').textContent).toBe('hub:remote-a')
    })
    // Both hubs' describe ran independently — a shared cache would have served
    // one hub's cached result to the other and skipped the second fetch.
    expect(describeCalls['local']).toBeGreaterThanOrEqual(1)
    expect(describeCalls['remote-a']).toBeGreaterThanOrEqual(1)
  })

  it('an unresolvable hub id renders the fallback', () => {
    render(
      <FederationProvider hubs={HUBS} defaultHubId="local">
        <HubScope hubId="ghost" fallback={<span>offline</span>}>
          <HubLabel />
        </HubScope>
      </FederationProvider>
    )
    expect(screen.queryByText('offline')).not.toBeNull()
  })

  it('a hub entry with no url is unresolvable → fallback (offline remote in the registry)', () => {
    const withUrllessRemote = [
      HUBS[0],
      { id: 'remote-b', kind: 'remote' as const, label: 'B', url: '' }
    ]
    render(
      <FederationProvider hubs={withUrllessRemote} defaultHubId="local">
        <HubScope hubId="remote-b" fallback={<span>no-url</span>}>
          <HubLabel />
        </HubScope>
      </FederationProvider>
    )
    expect(screen.queryByText('no-url')).not.toBeNull()
  })
})

describe('federation: per-hub bearer-token routing (no cross-hub token leak)', () => {
  afterEach(() => {
    cleanup()
    for (const k of Object.keys(clientOpts)) delete clientOpts[k]
  })

  const THREE_HUBS = [
    { id: 'local', kind: 'local' as const, label: 'Local', url: 'ws://127.0.0.1:1/trpc' },
    { id: 'remote-a', kind: 'remote' as const, label: 'A', url: 'wss://a.example/trpc' },
    { id: 'remote-b', kind: 'remote' as const, label: 'B', url: 'wss://b.example/trpc' }
  ]

  it('sends each remote hub ONLY its own token, and the default hub NONE', async () => {
    const tokens = {
      'remote-a': 'tok-A',
      'remote-b': 'tok-B',
      local: 'tok-LOCAL-should-be-ignored'
    }
    render(
      <FederationProvider hubs={THREE_HUBS} defaultHubId="local" tokens={tokens}>
        <HubScope hubId="local">
          <HubLabel />
        </HubScope>
        <HubScope hubId="remote-a">
          <HubLabel />
        </HubScope>
        <HubScope hubId="remote-b">
          <HubLabel />
        </HubScope>
      </FederationProvider>
    )
    await waitFor(() => {
      expect(clientOpts.local).toBeDefined()
      expect(clientOpts['remote-a']).toBeDefined()
      expect(clientOpts['remote-b']).toBeDefined()
    })
    // The DEFAULT (local) hub is trusted-loopback → no token frame even though the
    // tokens map carries one for its id (isDefault short-circuits it to undefined).
    expect(clientOpts.local.isDefault).toBe(true)
    expect(clientOpts.local.token).toBeUndefined()
    // Each remote carries ONLY its own token — never another hub's.
    expect(clientOpts['remote-a'].isDefault).toBe(false)
    expect(clientOpts['remote-a'].token).toBe('tok-A')
    expect(clientOpts['remote-b'].isDefault).toBe(false)
    expect(clientOpts['remote-b'].token).toBe('tok-B')
  })

  it('a remote hub with no token entry gets an undefined token (not another hub’s)', async () => {
    const tokens = { 'remote-a': 'tok-A' } // remote-b intentionally absent
    render(
      <FederationProvider hubs={THREE_HUBS} defaultHubId="local" tokens={tokens}>
        <HubScope hubId="remote-b">
          <HubLabel />
        </HubScope>
      </FederationProvider>
    )
    await waitFor(() => expect(clientOpts['remote-b']).toBeDefined())
    expect(clientOpts['remote-b'].token).toBeUndefined()
  })
})

describe('federation: a hub removed from the list', () => {
  afterEach(() => {
    cleanup()
    closedHubs.length = 0
  })

  const A = { id: 'remote-a', kind: 'remote' as const, label: 'A', url: 'wss://a.example/trpc' }
  const LOCAL = {
    id: 'local',
    kind: 'local' as const,
    label: 'Local',
    url: 'ws://127.0.0.1:1/trpc'
  }

  function Tree({ hubs }: { hubs: Array<typeof A | typeof LOCAL> }) {
    return (
      <FederationProvider hubs={hubs} defaultHubId="local" tokens={{ 'remote-a': 'tok-A' }}>
        {hubs.map((h) => (
          <div key={h.id} data-testid={h.id}>
            <HubScope hubId={h.id}>
              <HubLabel />
            </HubScope>
          </div>
        ))}
      </FederationProvider>
    )
  }

  it('closes its socket and drops its cache: a later re-add starts fresh', async () => {
    const { rerender } = render(<Tree hubs={[LOCAL, A]} />)
    await waitFor(() => expect(screen.getByTestId('remote-a').textContent).toBe('hub:remote-a'))
    const fetchesBefore = describeCalls['remote-a']

    // Signed out of A: its socket must stop, its cached rows must go.
    rerender(<Tree hubs={[LOCAL]} />)
    await waitFor(() => expect(closedHubs).toEqual(['remote-a']))

    // Signed in again: a fresh QueryClient fetches again instead of serving the old
    // session's cached answer.
    rerender(<Tree hubs={[LOCAL, A]} />)
    await waitFor(() => expect(describeCalls['remote-a']).toBe(fetchesBefore + 1))
  })

  it('never closes the default hub', async () => {
    const { rerender } = render(<Tree hubs={[LOCAL, A]} />)
    await waitFor(() => expect(screen.getByTestId('local').textContent).toBe('hub:local'))
    rerender(<Tree hubs={[A]} />)
    // A render pass for the effect to run in.
    await waitFor(() => expect(screen.getByTestId('remote-a').textContent).toBe('hub:remote-a'))
    expect(closedHubs).toEqual([])
  })
})

describe('federation: desktop-host procedures route to the local hub', () => {
  afterEach(cleanup)

  // `app.shell`, `app.window`, `menu.*`… run only in the Electron host, reached
  // only through the LOCAL hub's bridge. A remote task pane calls them through
  // its remote hub's client; that client must forward them to the local hub.
  const { useTRPCClient } = trpcFor<AnyTRPCRouter>()
  type Untyped = Record<string, Record<string, Record<string, Record<string, never>>>>
  function Probe({ run }: { run: (c: Untyped) => Promise<unknown> }): React.ReactNode {
    const client = useTRPCClient() as unknown as Untyped
    const [out, setOut] = React.useState('pending')
    React.useEffect(() => {
      run(client).then(
        (v) => setOut(String(v)),
        (e: unknown) => setOut(`error:${(e as Error).message}`)
      )
    }, [client, run])
    return <span>{out}</span>
  }
  const call =
    (path: string, kind: 'query' | 'mutate' = 'query') =>
    (c: Untyped) => {
      const [a, b, d] = path.split('.')
      const proc = (d ? c[a][b][d] : c[a][b]) as unknown as Record<
        string,
        (i?: unknown) => Promise<unknown>
      >
      return proc[kind]()
    }
  const subscribeOnce = (path: string) => (c: Untyped) =>
    new Promise((resolve, reject) => {
      const [a, b] = path.split('.')
      const proc = c[a][b] as unknown as {
        subscribe: (
          i: unknown,
          o: { onData: (d: unknown) => void; onError: (e: unknown) => void }
        ) => { unsubscribe: () => void }
      }
      const sub = proc.subscribe(undefined, {
        onData: (d) => {
          // May fire synchronously, before `sub` is assigned.
          queueMicrotask(() => sub.unsubscribe())
          resolve(d)
        },
        onError: reject
      })
    })

  async function inRemoteScope(
    run: (c: Untyped) => Promise<unknown>,
    hubs = HUBS,
    defaultHubId = 'local',
    scopeId = 'remote-a'
  ): Promise<string> {
    render(
      <FederationProvider hubs={hubs} defaultHubId={defaultHubId}>
        <div data-testid="probe">
          <HubScope hubId={scopeId}>
            <Probe run={run} />
          </HubScope>
        </div>
      </FederationProvider>
    )
    await waitFor(() => expect(screen.getByTestId('probe').textContent).not.toBe('pending'))
    return screen.getByTestId('probe').textContent ?? ''
  }

  it('forwards an app.<host router> mutation to the local hub', async () => {
    expect(await inRemoteScope(call('app.shell.openExternal', 'mutate'))).toBe(
      'local|app.shell.openExternal'
    )
  })

  it('forwards a menu subscription to the local hub', async () => {
    expect(await inRemoteScope(subscribeOnce('menu.onCloseCurrentFocus'))).toBe(
      'local|menu.onCloseCurrentFocus'
    )
  })

  it('keeps hub-data app routers and every other path on the scoped hub', async () => {
    expect(await inRemoteScope(call('app.backup.list'))).toBe('remote-a|app.backup.list')
    cleanup()
    expect(await inRemoteScope(call('task.getAll'))).toBe('remote-a|task.getAll')
  })

  it('forwards nothing when no local hub is listed (mobile / legacy remote mode)', async () => {
    // Fresh ids: a hub's links are fixed when its client is first created.
    const remotes = [
      { id: 'remote-y', kind: 'remote' as const, label: 'Y', url: 'wss://y.example/trpc' },
      { id: 'remote-z', kind: 'remote' as const, label: 'Z', url: 'wss://z.example/trpc' }
    ]
    expect(
      await inRemoteScope(call('app.shell.openExternal', 'mutate'), remotes, 'remote-z', 'remote-y')
    ).toBe('remote-y|app.shell.openExternal')
  })
})
