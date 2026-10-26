// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useContext } from 'react'
import { createTrpcTest } from '@slayzone/transport/testing'

const telemetry = vi.hoisted(() => ({
  initTelemetry: vi.fn(async () => {}),
  setTelemetryTier: vi.fn(),
  track: vi.fn(),
  startHeartbeat: vi.fn(),
  stopHeartbeat: vi.fn(),
  startIpcTelemetryBridge: vi.fn(),
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

let setTierFromUi: (tier: 'anonymous' | 'opted_in') => void
function Probe() {
  const ctx = useContext(TelemetryContext)
  setTierFromUi = ctx.setTier
  return <span data-testid="tier">{ctx.tier}</span>
}

function setup(stored: string | null) {
  let value = stored
  const sets: unknown[] = []
  const trpc = createTrpcTest({
    procedures: {
      'settings.get': () => value,
      'settings.set': (input) => {
        sets.push(input)
        return null
      },
      'app.meta.getVersion': () => '9.9.9'
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

beforeEach(() => {
  for (const fn of Object.values(telemetry)) fn.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('TelemetryProvider tier hydration', () => {
  it('adopts the stored tier once and initializes telemetry with it', async () => {
    const { queryClient, setStored } = setup('opted_in')
    expect(tier()).toBe('anonymous')
    await flush()
    expect(tier()).toBe('opted_in')
    expect(telemetry.initTelemetry).toHaveBeenCalledTimes(1)
    expect(telemetry.initTelemetry).toHaveBeenCalledWith('opted_in')
    expect(telemetry.startHeartbeat).toHaveBeenCalledTimes(1)

    // A later change of the stored value is not re-adopted (init runs once).
    setStored('anonymous')
    await act(async () => {
      await queryClient.invalidateQueries()
    })
    await flush()
    expect(tier()).toBe('opted_in')
    expect(telemetry.initTelemetry).toHaveBeenCalledTimes(1)
  })

  it('anything but opted_in → anonymous', async () => {
    setup('weird')
    await flush()
    expect(tier()).toBe('anonymous')
    expect(telemetry.initTelemetry).toHaveBeenCalledWith('anonymous')
  })

  it('setTier from the UI updates the tier and persists it', async () => {
    const { sets } = setup(null)
    await flush()
    act(() => {
      setTierFromUi('opted_in')
    })
    expect(tier()).toBe('opted_in')
    expect(telemetry.setTelemetryTier).toHaveBeenCalledWith('opted_in')
    await flush()
    expect(sets).toContainEqual({ key: 'telemetry_tier', value: 'opted_in' })
  })
})
