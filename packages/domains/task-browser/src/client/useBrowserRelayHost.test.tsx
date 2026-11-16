// @vitest-environment jsdom
// The relay host's progress heartbeat lives only as long as the hub still wants the
// answer: it stops on the hub's `cancel` and at the op's own deadline, never pinging
// forever for an abandoned eval (review 3 LOW).
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { BrowserRelayFrame } from '../shared'

let onData: ((f: BrowserRelayFrame) => void) | null = null
const progress = vi.fn((_i: unknown) => Promise.resolve())
const reply = vi.fn((_i: unknown) => Promise.resolve())
const sync = vi.fn((_i: unknown) => Promise.resolve())
const client = {
  app: {
    browserRelay: {
      progress: { mutate: progress },
      reply: { mutate: reply },
      sync: { mutate: sync },
      engaged: { mutate: () => Promise.resolve() }
    }
  }
}
const trpc = {
  app: {
    browserRelay: {
      serve: {
        subscriptionOptions: (_i: unknown, o: { onData: (f: BrowserRelayFrame) => void }) => o
      }
    }
  }
}
vi.mock('./trpc', () => ({ useTRPC: () => trpc, useTRPCClient: () => client }))
vi.mock('@slayzone/transport/client', () => ({
  useSubscription: (o: { onData: (f: BrowserRelayFrame) => void }) => {
    onData = o.onData
  }
}))
vi.mock('./useHubIsLocal', () => ({ useHubIsLocal: () => false }))
// A host whose script never settles (`new Promise(() => {})`).
const host = { call: () => new Promise(() => {}), on: () => () => {} }
vi.mock('./browser-host', () => ({ getBrowserHost: () => host, BROWSER_CLIENT_KEY: 'k' }))

const { useBrowserRelayHost } = await import('./useBrowserRelayHost')

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  progress.mockClear()
})

function start() {
  const h = renderHook(() => useBrowserRelayHost('t'))
  act(() => {
    onData!({ type: 'hello', hostId: 'h1' })
    h.result.current.tabLive('x')
    h.result.current.setActiveTab('x')
  })
  act(() => {
    onData!({
      type: 'request',
      requestId: 'r1',
      taskId: 't',
      tabId: 'x',
      origin: 'elsewhere',
      op: 'execJs',
      code: 'new Promise(() => {})'
    })
  })
  return h
}

it('reports progress while working, and stops when the hub cancels', async () => {
  start()
  await act(() => vi.advanceTimersByTimeAsync(10_500))
  expect(progress).toHaveBeenCalledTimes(1)
  act(() => onData!({ type: 'cancel', requestId: 'r1' }))
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(progress).toHaveBeenCalledTimes(1)
})

it('stops at the op deadline even without a cancel', async () => {
  start()
  await act(() => vi.advanceTimersByTimeAsync(5 * 60_000))
  // execJs deadline 15 s → at most one beat (at 10 s).
  expect(progress.mock.calls.length).toBeLessThanOrEqual(1)
})
