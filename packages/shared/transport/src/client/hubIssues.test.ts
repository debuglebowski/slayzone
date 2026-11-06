/**
 * What is wrong with a hub's connection, for the app-wide banner: the socket keeps
 * failing (`unreachable`), it is open but the hub does not take this app's sign-in
 * (`signin`), or it is open but the hub cannot even say who it is (`error`).
 */
import { behaviorSubject } from '@trpc/server/observable'
import { TRPCClientError } from '@trpc/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionStateSource } from './connectDeadlineLink'
import { isSignedOutDescribe, watchHubIssue, type HubIssue } from './hubIssues'

type State = ReturnType<ConnectionStateSource['get']>

const OPEN: State = { type: 'state', state: 'pending', error: null }
const IDLE: State = { type: 'state', state: 'idle', error: null }
const failing = (message: string): State => ({
  type: 'state',
  state: 'connecting',
  error: TRPCClientError.from(new Error(message))
})

const SIGNED_IN = { authRequired: true, scopes: ['full'] }
const SIGNED_OUT = { authRequired: true, scopes: null }

function harness(initial: State, describe: () => Promise<unknown>) {
  const source = behaviorSubject<State>(initial) as unknown as ConnectionStateSource & {
    next: (s: State) => void
  }
  const reports: Array<HubIssue | null> = []
  const stop = watchHubIssue({
    source,
    describe,
    graceMs: 5_000,
    onIssue: (issue) => reports.push(issue)
  })
  return { source, reports, stop, last: () => reports.at(-1) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-06T10:00:00Z'))
})
afterEach(() => vi.useRealTimers())

describe('isSignedOutDescribe', () => {
  it('a hub that requires login and found no principal on this socket = signed out', () => {
    expect(isSignedOutDescribe(SIGNED_OUT)).toBe(true)
  })
  it('a principal, a hub without login, or a hub too old to say = not signed out', () => {
    expect(isSignedOutDescribe(SIGNED_IN)).toBe(false)
    expect(isSignedOutDescribe({ authRequired: false, scopes: null })).toBe(false)
    expect(isSignedOutDescribe({ authRequired: true })).toBe(false)
    expect(isSignedOutDescribe(null)).toBe(false)
  })
})

describe('watchHubIssue', () => {
  it('a socket that keeps failing past the grace is unreachable, since its first failure', async () => {
    const h = harness(IDLE, () => Promise.resolve(SIGNED_IN))
    h.source.next(failing('WebSocket closed'))
    await vi.advanceTimersByTimeAsync(4_999)
    expect(h.reports).toEqual([])
    h.source.next(failing('still closed'))
    await vi.advanceTimersByTimeAsync(1)
    expect(h.last()).toEqual({
      kind: 'unreachable',
      since: Date.parse('2026-11-06T10:00:00Z'),
      detail: 'still closed'
    })
    h.stop()
  })

  it('a blip shorter than the grace reports nothing', async () => {
    const h = harness(OPEN, () => Promise.resolve(SIGNED_IN))
    await vi.advanceTimersByTimeAsync(0)
    h.source.next(failing('WebSocket closed'))
    await vi.advanceTimersByTimeAsync(1_000)
    h.source.next(OPEN)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.reports.filter(Boolean)).toEqual([])
    h.stop()
  })

  it('an open socket the hub holds no sign-in for is a sign-in issue', async () => {
    const h = harness(OPEN, () => Promise.resolve(SIGNED_OUT))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.last()?.kind).toBe('signin')
    h.stop()
  })

  it('reconnecting after a fix clears the issue', async () => {
    let answer: unknown = SIGNED_OUT
    const h = harness(OPEN, () => Promise.resolve(answer))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.last()?.kind).toBe('signin')
    answer = SIGNED_IN
    h.source.next(failing('session ended'))
    h.source.next(OPEN)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.last()).toBeNull()
    h.stop()
  })

  it('an open socket whose hub cannot answer describe is an error with the cause', async () => {
    const h = harness(OPEN, () => Promise.reject(new Error('boom')))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.last()).toMatchObject({ kind: 'error', detail: 'boom' })
    h.stop()
  })

  it('unreachable clears once the socket opens', async () => {
    const h = harness(failing('down'), () => Promise.resolve(SIGNED_IN))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.last()?.kind).toBe('unreachable')
    h.source.next(OPEN)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.last()).toBeNull()
    h.stop()
  })

  it('a describe answer that arrives after the socket dropped again is ignored', async () => {
    let resolve: (v: unknown) => void = () => {}
    const h = harness(OPEN, () => new Promise((r) => (resolve = r)))
    h.source.next(failing('down'))
    resolve(SIGNED_OUT)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.reports.some((r) => r?.kind === 'signin')).toBe(false)
    h.stop()
  })

  it('stop() ends the watch: no timer fires after it', async () => {
    const h = harness(failing('down'), () => Promise.resolve(SIGNED_IN))
    h.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.reports).toEqual([])
  })
})
