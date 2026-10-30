// @vitest-environment jsdom
/**
 * A hub's connection as the UI reads it: the socket's own state (@trpc/client's
 * `connectionState`), not a guess from whether some query is still pending. Mapped
 * to `idle` / `connecting` (with the error that ended the last attempt, if any) /
 * `open`, live.
 */
import { createServer, type AddressInfo } from 'node:net'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { behaviorSubject } from '@trpc/server/observable'
import { TRPCClientError } from '@trpc/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionStateSource } from './connectDeadlineLink'
import { FederationProvider } from './FederationProvider'
import {
  toHubConnection,
  useConnectionState,
  useHubConnection,
  type HubConnection
} from './hubConnection'
import { closeHubClient } from './runtime'

type State = ReturnType<ConnectionStateSource['get']>

const closedError = TRPCClientError.from(new Error('WebSocket closed'))

describe('toHubConnection', () => {
  it("names @trpc/client's states for what they are", () => {
    expect(toHubConnection({ type: 'state', state: 'idle', error: null })).toEqual({
      status: 'idle',
      error: null
    })
    expect(toHubConnection({ type: 'state', state: 'connecting', error: null })).toEqual({
      status: 'connecting',
      error: null
    })
    // `pending` is @trpc/client's word for an open socket.
    expect(toHubConnection({ type: 'state', state: 'pending', error: null })).toEqual({
      status: 'open',
      error: null
    })
  })

  it('keeps the error that ended the last attempt while it reconnects', () => {
    const conn = toHubConnection({ type: 'state', state: 'connecting', error: closedError })
    expect(conn.status).toBe('connecting')
    expect(conn.error?.message).toBe('WebSocket closed')
  })
})

function Show({ conn }: { conn: HubConnection | null }) {
  if (!conn) return <span>no hub</span>
  return <span>{`${conn.status}:${conn.error ? 'error' : 'none'}`}</span>
}

function FromSource({ source }: { source: ConnectionStateSource }) {
  return <Show conn={useConnectionState(source)} />
}

describe('useConnectionState', () => {
  afterEach(cleanup)

  it('follows the socket state live', () => {
    const source = behaviorSubject<State>({ type: 'state', state: 'connecting', error: null })
    render(<FromSource source={source} />)
    expect(screen.getByText('connecting:none')).toBeTruthy()

    act(() => source.next({ type: 'state', state: 'pending', error: null }))
    expect(screen.getByText('open:none')).toBeTruthy()

    act(() => source.next({ type: 'state', state: 'connecting', error: closedError }))
    expect(screen.getByText('connecting:error')).toBeTruthy()
  })

  it('stops listening when unmounted', () => {
    const source = behaviorSubject<State>({ type: 'state', state: 'connecting', error: null })
    let listeners = 0
    const counted: ConnectionStateSource = {
      ...source,
      get: () => source.get(),
      subscribe: (observer) => {
        listeners++
        const sub = source.subscribe(observer)
        return {
          unsubscribe: () => {
            listeners--
            sub.unsubscribe()
          }
        }
      }
    } as ConnectionStateSource
    const { unmount } = render(<FromSource source={counted} />)
    expect(listeners).toBe(1)
    unmount()
    expect(listeners).toBe(0)
  })
})

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

function OfHub({ hubId }: { hubId: string }) {
  return <Show conn={useHubConnection(hubId)} />
}

describe('useHubConnection', () => {
  afterEach(() => {
    cleanup()
    closeHubClient('remote-dead')
  })

  it("reports a hub nobody answers as connecting, with the failed attempt's error", async () => {
    const hubs = [
      {
        id: 'remote-dead',
        kind: 'remote' as const,
        label: 'Dead',
        url: `ws://127.0.0.1:${await deadPort()}/trpc`
      }
    ]
    render(
      <FederationProvider hubs={hubs} defaultHubId="local" tokens={{ 'remote-dead': 't' }}>
        <OfHub hubId="remote-dead" />
      </FederationProvider>
    )
    await waitFor(() => expect(screen.getByText('connecting:error')).toBeTruthy())
  })

  it('is null for a hub the federation does not list', () => {
    render(
      <FederationProvider hubs={[]} defaultHubId="local">
        <OfHub hubId="ghost" />
      </FederationProvider>
    )
    expect(screen.getByText('no hub')).toBeTruthy()
  })
})
