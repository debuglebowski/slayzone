// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useContext } from 'react'
import { createTrpcTest } from '@slayzone/transport/testing'
import type { TelemetryTier } from '../shared/types'

const telemetry = vi.hoisted(() => ({
  applyTelemetryTier: vi.fn(async () => {}),
  track: vi.fn(),
  stopHeartbeat: vi.fn(),
  stopIpcTelemetryBridge: vi.fn(),
  getPosthogInstance: vi.fn(async () => null)
}))
vi.mock('./telemetry', () => telemetry)

import { TelemetryContext, TelemetryProvider } from './TelemetryProvider'

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

let setTierFromUi: (tier: TelemetryTier) => void
function Probe() {
  const ctx = useContext(TelemetryContext)
  setTierFromUi = ctx.setTier
  return (
    <>
      <span data-testid="tier">{ctx.tier}</span>
      <span data-testid="services">{ctx.thirdPartyServices}</span>
      <span data-testid="locked">{String(ctx.lockedByHub)}</span>
    </>
  )
}

/** `hubTelemetry`: what the hub's `hub.describe` reports for `enableTelemetry` (undefined = an older hub). */
function setup(stored: string | null, hubTelemetry?: boolean) {
  let value = stored
  const sets: unknown[] = []
  const trpc = createTrpcTest({
    procedures: {
      'settings.get': () => value,
      'settings.set': (input) => {
        sets.push(input)
        return null
      },
      'app.meta.getVersion': () => '9.9.9',
      'hub.describe': () => ({
        scopes: null,
        switches: hubTelemetry === undefined ? {} : { enableTelemetry: hubTelemetry }
      })
    }
  })
  const Wrapper = trpc.wrapper
  render(
    <Wrapper>
      <TelemetryProvider>
        <Probe />
      </TelemetryProvider>
    </Wrapper>
  )
  return {
    sets,
    queryClient: trpc.queryClient,
    setStored: (v: string | null) => {
      value = v
    }
  }
}

const tier = () => screen.getByTestId('tier').textContent
const services = () => screen.getByTestId('services').textContent
const locked = () => screen.getByTestId('locked').textContent
const appliedTiers = () => telemetry.applyTelemetryTier.mock.calls.map((c) => (c as unknown[])[0])

beforeEach(() => {
  for (const fn of Object.values(telemetry)) fn.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('TelemetryProvider tier hydration', () => {
  it('adopts the stored tier once and starts telemetry with it', async () => {
    const { queryClient, setStored } = setup('opted_in', true)
    expect(tier()).toBe('anonymous')
    expect(services(), 'nothing third-party before the answers are in').toBe('pending')
    expect(telemetry.applyTelemetryTier).not.toHaveBeenCalled()
    await flush()
    expect(tier()).toBe('opted_in')
    expect(services()).toBe('allowed')
    expect(appliedTiers()).toEqual(['opted_in'])

    // A later change of the stored value is not re-adopted.
    setStored('anonymous')
    await act(async () => {
      await queryClient.invalidateQueries()
    })
    await flush()
    expect(tier()).toBe('opted_in')
    expect(appliedTiers()).toEqual(['opted_in'])
  })

  it('anything unknown → anonymous', async () => {
    setup('weird', true)
    await flush()
    expect(tier()).toBe('anonymous')
    expect(appliedTiers()).toEqual(['anonymous'])
  })

  it('a hub older than the switch (no enableTelemetry) changes nothing', async () => {
    setup(null)
    await flush()
    expect(tier()).toBe('anonymous')
    expect(services()).toBe('allowed')
    expect(locked()).toBe('false')
  })

  it('setTier from the UI updates the tier and persists it', async () => {
    const { sets } = setup(null, true)
    await flush()
    act(() => {
      setTierFromUi('opted_in')
    })
    expect(tier()).toBe('opted_in')
    await flush()
    expect(appliedTiers()).toEqual(['anonymous', 'opted_in'])
    expect(sets).toContainEqual({ key: 'telemetry_tier', value: 'opted_in' })
  })
})

describe('TelemetryProvider off tier', () => {
  it('stored off: third-party services blocked, PostHog only ever told off', async () => {
    setup('off', true)
    await flush()
    expect(tier()).toBe('off')
    expect(services()).toBe('blocked')
    expect(appliedTiers()).toEqual(['off'])
  })

  it('off from the UI: blocked at once, persisted, PostHog stopped', async () => {
    const { sets } = setup('anonymous', true)
    await flush()
    expect(services()).toBe('allowed')
    act(() => {
      setTierFromUi('off')
    })
    expect(services()).toBe('blocked')
    await flush()
    expect(appliedTiers()).toEqual(['anonymous', 'off'])
    expect(sets).toContainEqual({ key: 'telemetry_tier', value: 'off' })
  })

  it('back on from the UI: allowed again', async () => {
    setup('off', true)
    await flush()
    act(() => {
      setTierFromUi('anonymous')
    })
    await flush()
    expect(services()).toBe('allowed')
    expect(appliedTiers()).toEqual(['off', 'anonymous'])
  })
})

describe('TelemetryProvider with a hub that turned telemetry off', () => {
  it('forces off over the stored tier, locked, nothing ever started', async () => {
    const { sets } = setup('opted_in', false)
    await flush()
    expect(tier()).toBe('off')
    expect(locked()).toBe('true')
    expect(services()).toBe('blocked')
    expect(appliedTiers(), 'PostHog never started').toEqual(['off'])

    // The user cannot turn it back on: nothing changes, nothing is stored.
    act(() => {
      setTierFromUi('opted_in')
    })
    await flush()
    expect(tier()).toBe('off')
    expect(appliedTiers()).toEqual(['off'])
    expect(sets).toEqual([])
  })

  it('a hub that cannot be asked counts as off (fail closed)', async () => {
    const trpc = createTrpcTest({
      procedures: {
        'settings.get': () => 'anonymous',
        'settings.set': () => null,
        'app.meta.getVersion': () => '9.9.9',
        'hub.describe': () => {
          throw new Error('hub down')
        }
      }
    })
    const Wrapper = trpc.wrapper
    render(
      <Wrapper>
        <TelemetryProvider>
          <Probe />
        </TelemetryProvider>
      </Wrapper>
    )
    await flush()
    expect(services()).toBe('blocked')
    expect(appliedTiers()).toEqual(['off'])
  })
})
