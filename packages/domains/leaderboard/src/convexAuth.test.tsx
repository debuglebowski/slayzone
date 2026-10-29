// @vitest-environment jsdom
/**
 * Convex only runs while third-party services are allowed — the real TelemetryProvider
 * deciding (stored tier + the hub's `SLAYZONE_HUB_ENABLE_TELEMETRY` from `hub.describe`)
 * and the real ConvexAuthBootstrap obeying. posthog-js and Convex are mocked: the test
 * counts what would have reached either.
 *
 *   - a hub with telemetry off, or the user's `off` tier: no PostHog init, no Convex
 *     client, no Convex session, leaderboard + feedback reported unavailable;
 *   - otherwise both start, exactly as before;
 *   - turning it off at run time closes the Convex client without remounting the app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { createTrpcTest } from '@slayzone/transport/testing'

// Telemetry counts as configured (a build key), so only the tier and the hub decide.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  g.__POSTHOG_API_KEY__ = 'phc_test'
  g.__POSTHOG_HOST__ = 'https://eu.i.posthog.com'
  g.__DEV__ = true
})

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  reset: vi.fn(),
  register: vi.fn(),
  identify: vi.fn(),
  capture: vi.fn(),
  opt_out_capturing: vi.fn(),
  clear_opt_in_out_capturing: vi.fn(),
  has_opted_out_capturing: vi.fn(() => false)
}))
vi.mock('posthog-js', () => ({ default: posthog }))

const convex = vi.hoisted(() => ({
  constructed: [] as string[],
  closed: [] as string[],
  sessionMounts: 0
}))
vi.mock('convex/react', () => {
  class ConvexReactClient {
    constructor(readonly url: string) {
      convex.constructed.push(url)
    }
    async close(): Promise<void> {
      convex.closed.push(this.url)
    }
  }
  return {
    ConvexReactClient,
    ConvexProvider: ({ children }: { children: ReactNode }) => children,
    useConvexAuth: () => ({ isLoading: false, isAuthenticated: false }),
    useMutation: () => vi.fn()
  }
})
vi.mock('@convex-dev/auth/react', async () => {
  const { useEffect: useMountEffect } = await import('react')
  return {
    ConvexAuthProvider: ({ children }: { children: ReactNode }) => {
      useMountEffect(() => {
        convex.sessionMounts += 1
      }, [])
      return children
    },
    useAuthActions: () => ({ signIn: vi.fn(), signOut: vi.fn() })
  }
})

import { TelemetryProvider, useTelemetry } from '@slayzone/telemetry/client'
import { ConvexAuthBootstrap, ConvexScope, useLeaderboardAuth } from './convexAuth'

const CONVEX_URL = 'https://happy-animal-123.convex.cloud'

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

let appMounts = 0
let setTier: (tier: 'off' | 'anonymous' | 'opted_in') => void = () => {}
function App() {
  useEffect(() => {
    appMounts += 1
  }, [])
  setTier = useTelemetry().setTier
  const auth = useLeaderboardAuth()
  return (
    <>
      <span data-testid="leaderboard">{String(auth.configured)}</span>
      <ConvexScope>
        <span data-testid="feedback">feedback</span>
      </ConvexScope>
    </>
  )
}

/** `hubTelemetry`: the hub's `enableTelemetry` switch as `hub.describe` reports it. */
function renderApp(stored: string | null, hubTelemetry: boolean) {
  const trpc = createTrpcTest({
    procedures: {
      'settings.get': () => stored,
      'settings.set': () => null,
      'app.meta.getVersion': () => '9.9.9',
      'hub.describe': () => ({ scopes: null, switches: { enableTelemetry: hubTelemetry } })
    }
  })
  const Wrapper = trpc.wrapper
  render(
    <Wrapper>
      <TelemetryProvider>
        <ConvexAuthBootstrap convexUrl={CONVEX_URL}>
          <App />
        </ConvexAuthBootstrap>
      </TelemetryProvider>
    </Wrapper>
  )
}

const leaderboard = () => screen.getByTestId('leaderboard').textContent
const feedbackShown = () => screen.queryByTestId('feedback') !== null
const posthogReached = () =>
  posthog.init.mock.calls.length +
  posthog.capture.mock.calls.length +
  posthog.identify.mock.calls.length

beforeEach(() => {
  for (const fn of Object.values(posthog)) fn.mockClear()
  convex.constructed.length = 0
  convex.closed.length = 0
  convex.sessionMounts = 0
  appMounts = 0
})

afterEach(() => {
  cleanup()
})

describe('a hub with SLAYZONE_HUB_ENABLE_TELEMETRY=0', () => {
  it('never reaches PostHog or Convex, whatever the user had chosen', async () => {
    renderApp('opted_in', false)
    await flush()
    expect(posthogReached(), 'no PostHog init / capture / identify').toBe(0)
    expect(convex.constructed, 'no Convex client').toEqual([])
    expect(convex.sessionMounts, 'no Convex session').toBe(0)
    expect(leaderboard(), 'leaderboard reported unavailable').toBe('false')
    expect(feedbackShown(), 'feedback (a Convex consumer) not rendered').toBe(false)
  })
})

describe("the user's off tier", () => {
  it('never reaches PostHog or Convex', async () => {
    renderApp('off', true)
    await flush()
    expect(posthogReached()).toBe(0)
    expect(convex.constructed).toEqual([])
    expect(convex.sessionMounts).toBe(0)
    expect(leaderboard()).toBe('false')
  })
})

describe('telemetry allowed (unchanged)', () => {
  it('starts PostHog and the Convex session', async () => {
    renderApp('anonymous', true)
    await flush()
    expect(posthog.init).toHaveBeenCalledTimes(1)
    expect(convex.constructed).toEqual([CONVEX_URL])
    expect(convex.sessionMounts).toBe(1)
    expect(leaderboard()).toBe('true')
    expect(feedbackShown()).toBe(true)
  })

  it('turning it off at run time closes Convex and opts PostHog out, the app stays mounted', async () => {
    renderApp('anonymous', true)
    await flush()
    expect(appMounts).toBe(1)
    act(() => {
      setTier('off')
    })
    await flush()
    expect(convex.closed, 'the Convex client is closed').toEqual([CONVEX_URL])
    expect(posthog.opt_out_capturing).toHaveBeenCalledTimes(1)
    expect(leaderboard()).toBe('false')
    expect(feedbackShown()).toBe(false)
    expect(appMounts, 'the app tree was not remounted').toBe(1)

    // And back on: a fresh Convex client, still no remount.
    act(() => {
      setTier('anonymous')
    })
    await flush()
    expect(convex.constructed).toEqual([CONVEX_URL, CONVEX_URL])
    expect(leaderboard()).toBe('true')
    expect(appMounts).toBe(1)
  })
})

// The context default (no TelemetryProvider above): Convex never starts.
describe('ConvexAuthBootstrap outside a TelemetryProvider', () => {
  it('fails closed', async () => {
    const trpc = createTrpcTest({ procedures: {} })
    const Wrapper = trpc.wrapper
    render(
      <Wrapper>
        <ConvexAuthBootstrap convexUrl={CONVEX_URL}>
          <App />
        </ConvexAuthBootstrap>
      </Wrapper>
    )
    await flush()
    expect(convex.constructed).toEqual([])
    expect(leaderboard()).toBe('false')
  })
})
