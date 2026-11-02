// @vitest-environment jsdom
/**
 * A hub served in this process (`FederationProvider`'s `inProcessLinks`, the mobile
 * app's demo hub): its scope's `useTRPC()` resolves every operation against the
 * in-process backend (`inProcessLink`), no socket opens, its connection reads open
 * from the first frame, and leaving `hubs` forgets it like any hub. Real
 * FederationProvider, HubScope, client runtime and React Query — nothing mocked.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useQuery } from '@tanstack/react-query'
import type { AnyTRPCRouter } from '@trpc/server'
import { useSubscription } from '@trpc/tanstack-react-query'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { FederationProvider } from './FederationProvider'
import { HubScope } from './HubScope'
import { useHubConnection } from './hubConnection'
import { type InProcessBackend, inProcessLink } from './inProcessLink'
import { _resetHubClients, getHubClient } from './runtime'
import { trpcFor } from './view'

const { useTRPC } = trpcFor<AnyTRPCRouter>()

type Proxy = {
  hub: { describe: { queryOptions: () => unknown } }
  notify: { onTick: { subscriptionOptions: (input: undefined, opts: unknown) => unknown } }
}

function Label(): React.ReactNode {
  const trpc = useTRPC() as unknown as Proxy
  const q = useQuery(trpc.hub.describe.queryOptions() as never) as {
    data?: { label: string }
    error: Error | null
  }
  return <span>{q.error ? `error: ${q.error.message}` : (q.data?.label ?? 'loading')}</span>
}

function Ticks(): React.ReactNode {
  const trpc = useTRPC() as unknown as Proxy
  const [ticks, setTicks] = useState(0)
  useSubscription(
    trpc.notify.onTick.subscriptionOptions(undefined, {
      onData: (n: number) => setTicks(n)
    }) as never
  )
  return <span>{`ticks ${ticks}`}</span>
}

function Connection({ hubId }: { hubId: string }): React.ReactNode {
  const connection = useHubConnection(hubId)
  return <span>{connection ? connection.status : 'unlisted'}</span>
}

const DEMO = {
  id: 'hub:demo',
  kind: 'remote' as const,
  label: 'Demo',
  url: 'wss://demo.invalid/trpc'
}

afterEach(() => {
  cleanup()
  _resetHubClients()
})

describe('in-process hub', () => {
  it('answers from its backend, reads open, and pushes its subscriptions', async () => {
    let emit: ((n: number) => void) | null = null
    const backend: InProcessBackend = {
      procedures: { 'hub.describe': () => ({ label: 'demo hub' }) },
      subscriptions: {
        'notify.onTick': (_input, push) => {
          emit = push as (n: number) => void
          return () => {
            emit = null
          }
        }
      }
    }
    const links = { [DEMO.id]: inProcessLink(backend) }
    render(
      <FederationProvider hubs={[DEMO]} defaultHubId="local" inProcessLinks={links}>
        <HubScope hubId={DEMO.id}>
          <Label />
          <Ticks />
        </HubScope>
        <Connection hubId={DEMO.id} />
      </FederationProvider>
    )
    // Open from the first frame: no connect, nothing to wait for.
    expect(screen.queryByText('open')).not.toBeNull()
    await waitFor(() => expect(screen.queryByText('demo hub')).not.toBeNull())
    await waitFor(() => expect(emit).not.toBeNull())
    act(() => emit?.(3))
    expect(screen.queryByText('ticks 3')).not.toBeNull()
  })

  it('fails an operation it has no handler for, loudly', async () => {
    const links = { [DEMO.id]: inProcessLink({}) }
    render(
      <FederationProvider hubs={[DEMO]} defaultHubId="local" inProcessLinks={links}>
        <HubScope hubId={DEMO.id}>
          <Label />
        </HubScope>
      </FederationProvider>
    )
    await waitFor(() =>
      expect(screen.queryByText('error: unexpected op hub.describe')).not.toBeNull()
    )
  })

  it('is forgotten when it leaves the federation, and a new instance starts fresh', async () => {
    let instance = 1
    const linkOf = () =>
      inProcessLink({ procedures: { 'hub.describe': () => ({ label: `demo ${instance}` }) } })
    const first = { [DEMO.id]: linkOf() }
    const view = render(
      <FederationProvider hubs={[DEMO]} defaultHubId="local" inProcessLinks={first}>
        <HubScope hubId={DEMO.id}>
          <Label />
        </HubScope>
      </FederationProvider>
    )
    await waitFor(() => expect(screen.queryByText('demo 1')).not.toBeNull())
    const client = getHubClient(DEMO.id)
    expect(client).not.toBeNull()

    view.rerender(
      <FederationProvider hubs={[]} defaultHubId="local" inProcessLinks={{}}>
        {null}
      </FederationProvider>
    )
    expect(getHubClient(DEMO.id)).toBeNull()

    // Entered again: a new hub instance, a new client and an empty cache.
    instance = 2
    view.rerender(
      <FederationProvider
        hubs={[DEMO]}
        defaultHubId="local"
        inProcessLinks={{ [DEMO.id]: linkOf() }}
      >
        <HubScope hubId={DEMO.id}>
          <Label />
        </HubScope>
      </FederationProvider>
    )
    await waitFor(() => expect(screen.queryByText('demo 2')).not.toBeNull())
    expect(getHubClient(DEMO.id)).not.toBe(client)
  })
})
