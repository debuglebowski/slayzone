/**
 * A query against a hub whose socket will not open must FAIL, not wait forever.
 *
 * The first test here is the evidence for the whole link: with a plain
 * `createWSClient` + `wsLink` stack, a query issued while the socket is down is
 * parked in the request manager's OUTGOING queue and stays there — `batchSend`
 * awaits `open()`, and a failed `open()` returns the reconnect promise, which
 * only settles once the hub comes back. Nothing errors it in the meantime, so
 * every consumer sits on `isPending` forever (the symptom: a remote hub card
 * whose computer list is skeleton rows with no end).
 *
 * If a future @trpc/client errors those queued requests on its own, that first
 * test fails — which is the signal to reconsider this link, not to loosen it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { createTRPCClient, createWSClient, wsLink, type TRPCLink } from '@trpc/client'
import { observable, behaviorSubject } from '@trpc/server/observable'
import superjson from 'superjson'
import { connectDeadlineLink } from './connectDeadlineLink'
import { createTrpcWsClient } from './trpc'
import type { AppRouter } from '../server/router'

/** A port nothing listens on — bound, read, then released. */
async function deadPort(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

/** Terminating link that accepts an operation and never answers it. */
function silentLink(onTeardown?: () => void): TRPCLink<AppRouter> {
  return () => () =>
    observable(() => {
      return () => onTeardown?.()
    })
}

/** Terminating link that answers after `ms` — a slow procedure, not a dead hub. */
function slowLink(ms: number): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        const timer = setTimeout(() => {
          observer.next({ result: { data: { path: op.path } } })
          observer.complete()
        }, ms)
        return () => clearTimeout(timer)
      })
}

const closers: Array<() => void> = []
afterEach(() => {
  // Every ws client here is mid-reconnect-loop; close stops the retries.
  while (closers.length) closers.pop()?.()
})

describe('a hub whose socket never opens', () => {
  it('parks the query forever with a bare wsLink stack (why this link exists)', async () => {
    const port = await deadPort()
    const wsClient = createWSClient({ url: `ws://127.0.0.1:${port}/trpc` })
    closers.push(() => void wsClient.close())
    const client = createTRPCClient<AppRouter>({
      links: [wsLink({ client: wsClient, transformer: superjson })]
    })

    let settled: 'resolved' | 'rejected' | null = null
    void client.hub.describe.query().then(
      () => (settled = 'resolved'),
      () => (settled = 'rejected')
    )
    await new Promise((r) => setTimeout(r, 1_000))
    expect(settled).toBeNull()
  })

  it('rejects the query once the connect deadline passes', async () => {
    const port = await deadPort()
    const { client, wsClient } = createTrpcWsClient({
      url: `ws://127.0.0.1:${port}/trpc`,
      connectDeadlineMs: 300
    })
    closers.push(() => void wsClient.close())

    await expect(client.hub.describe.query()).rejects.toThrow(/unreachable/i)
  })
})

describe('connectDeadlineLink', () => {
  it('errors an operation that is still waiting on a connection', async () => {
    let toreDown = false
    const connectionState = behaviorSubject({
      type: 'state' as const,
      state: 'connecting' as const,
      error: null
    })
    const client = createTRPCClient<AppRouter>({
      links: [
        connectDeadlineLink({ connectionState, deadlineMs: 100 }),
        silentLink(() => (toreDown = true))
      ]
    })

    await expect(client.hub.describe.query()).rejects.toThrow(/unreachable/i)
    // The queued request must be dropped, not left in the manager's outgoing
    // list to be flushed at some later reconnect.
    expect(toreDown).toBe(true)
  })

  it('leaves a slow procedure alone once the hub is connected', async () => {
    const connectionState = behaviorSubject({
      type: 'state' as const,
      state: 'pending' as const,
      error: null
    })
    const client = createTRPCClient<AppRouter>({
      links: [connectDeadlineLink({ connectionState, deadlineMs: 50 }), slowLink(250)]
    })

    await expect(client.hub.describe.query()).resolves.toBeTruthy()
  })

  it('starts the deadline when a connected hub drops mid-operation', async () => {
    const connectionState = behaviorSubject({
      type: 'state' as const,
      state: 'pending' as const,
      error: null
    })
    const client = createTRPCClient<AppRouter>({
      links: [connectDeadlineLink({ connectionState, deadlineMs: 100 }), silentLink()]
    })

    const pending = client.hub.describe.query()
    connectionState.next({ type: 'state', state: 'connecting', error: null })
    await expect(pending).rejects.toThrow(/unreachable/i)
  })

  it('never deadlines a subscription — it owns its own reconnect semantics', async () => {
    const connectionState = behaviorSubject({
      type: 'state' as const,
      state: 'connecting' as const,
      error: null
    })
    const client = createTRPCClient<AppRouter>({
      links: [connectDeadlineLink({ connectionState, deadlineMs: 50 }), slowLink(200)]
    })

    const seen = await new Promise<string>((resolve, reject) => {
      const sub = client.agentLifecycle.onEvent.subscribe(undefined, {
        onData: () => {
          sub.unsubscribe()
          resolve('data')
        },
        onError: (err) => reject(err)
      })
    })
    expect(seen).toBe('data')
  })
})
