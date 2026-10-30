// @vitest-environment jsdom
/**
 * `applyTelemetryTier` — the one way PostHog changes. The `off` tier (a user's choice, or
 * a hub with `SLAYZONE_HUB_ENABLE_TELEMETRY=0`) must never load or start posthog-js, and
 * must stop one that already runs before anything else is sent.
 *
 * posthog-js is mocked; the build-time key is stubbed so telemetry counts as configured.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const posthog = vi.hoisted(() => {
  let optedOut = false
  return {
    imported: 0,
    init: vi.fn(),
    reset: vi.fn(() => {
      optedOut = false
    }),
    register: vi.fn(),
    identify: vi.fn(),
    capture: vi.fn(),
    opt_out_capturing: vi.fn(() => {
      optedOut = true
    }),
    clear_opt_in_out_capturing: vi.fn(() => {
      optedOut = false
    }),
    has_opted_out_capturing: vi.fn(() => optedOut)
  }
})

vi.mock('posthog-js', () => {
  posthog.imported += 1
  return { default: posthog }
})

type TelemetryModule = typeof import('./telemetry')

/** A fresh module (its state is module-level) with a configured PostHog key. */
async function load(): Promise<TelemetryModule> {
  vi.resetModules()
  vi.stubGlobal('__POSTHOG_API_KEY__', 'phc_test')
  vi.stubGlobal('__POSTHOG_HOST__', 'https://eu.i.posthog.com')
  vi.stubGlobal('__DEV__', true)
  return import('./telemetry')
}

/** Calls that reach PostHog's network: init, capture, identify. */
function networkCalls(): number {
  return (
    posthog.init.mock.calls.length +
    posthog.capture.mock.calls.length +
    posthog.identify.mock.calls.length
  )
}

beforeEach(() => {
  posthog.imported = 0
  for (const fn of Object.values(posthog)) if (typeof fn === 'function') fn.mockClear()
  posthog.reset()
  posthog.reset.mockClear()
  localStorage.clear()
})

describe('applyTelemetryTier', () => {
  it('off: posthog-js is never loaded, initialized or sent anything', async () => {
    const t = await load()
    await t.applyTelemetryTier('off')
    t.trackForHub(null, 'task_created', { provider: 'claude-code', from_template: false })
    t.trackForHub(null, 'keyboard_shortcut_used', { key: 'mod+k' })
    expect(posthog.imported, 'posthog-js chunk never imported').toBe(0)
    expect(networkCalls(), 'no init / capture / identify').toBe(0)
    expect(await t.getPosthogInstance(), 'no instance while off').toBe(null)
    expect(posthog.imported, 'not even for getPosthogInstance').toBe(0)
  })

  it('anonymous: posthog starts and captures (unchanged)', async () => {
    const t = await load()
    await t.applyTelemetryTier('anonymous')
    expect(posthog.init).toHaveBeenCalledTimes(1)
    expect(posthog.init.mock.calls[0]?.[1]).toMatchObject({ persistence: 'memory' })
    t.trackForHub(null, 'keyboard_shortcut_used', { key: 'mod+k' })
    expect(posthog.capture).toHaveBeenCalledWith('keyboard_shortcut_used', { key: 'mod+k' })
  })

  it('opted_in: posthog starts with a persisted id (unchanged)', async () => {
    const t = await load()
    await t.applyTelemetryTier('opted_in')
    expect(posthog.init.mock.calls[0]?.[1]).toMatchObject({ persistence: 'localStorage+cookie' })
    expect(posthog.identify).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('slayzone_telemetry_id')).toBeTruthy()
  })

  it('running → off: opted out first, then nothing is captured (not even the heartbeat close)', async () => {
    const t = await load()
    await t.applyTelemetryTier('anonymous')
    posthog.capture.mockClear()
    await t.applyTelemetryTier('off')
    expect(posthog.opt_out_capturing).toHaveBeenCalledTimes(1)
    t.trackForHub(null, 'keyboard_shortcut_used', { key: 'mod+k' })
    t.trackForHub(null, 'heartbeat', { active_ms: 1, active_minutes: 0 })
    expect(posthog.capture, 'nothing captured once off').not.toHaveBeenCalled()
  })

  it('off while posthog-js is still loading: it is never initialized', async () => {
    const t = await load()
    const starting = t.applyTelemetryTier('anonymous')
    await t.applyTelemetryTier('off')
    await starting
    expect(posthog.init, 'superseded by off before init').not.toHaveBeenCalled()
    t.trackForHub(null, 'keyboard_shortcut_used', { key: 'mod+k' })
    expect(posthog.capture).not.toHaveBeenCalled()
  })

  it('off → anonymous: starts again and clears the opt-out, without an $opt_in event', async () => {
    const t = await load()
    await t.applyTelemetryTier('anonymous')
    await t.applyTelemetryTier('off')
    await t.applyTelemetryTier('anonymous')
    expect(posthog.has_opted_out_capturing()).toBe(false)
    t.trackForHub(null, 'keyboard_shortcut_used', { key: 'mod+k' })
    expect(posthog.capture).toHaveBeenCalledWith('keyboard_shortcut_used', { key: 'mod+k' })
    expect(posthog.capture).not.toHaveBeenCalledWith('$opt_in', expect.anything())
  })

  it('a stored opt-out from an earlier off session is cleared when a later tier starts', async () => {
    const t = await load()
    posthog.opt_out_capturing() // left in storage by a previous session's `off`
    await t.applyTelemetryTier('anonymous')
    expect(posthog.clear_opt_in_out_capturing).toHaveBeenCalledTimes(1)
    expect(posthog.has_opted_out_capturing()).toBe(false)
  })

  it('applying the tier in force again is a no-op', async () => {
    const t = await load()
    await t.applyTelemetryTier('anonymous')
    await t.applyTelemetryTier('anonymous')
    expect(posthog.init).toHaveBeenCalledTimes(1)
  })
})

/**
 * A hub's `SLAYZONE_HUB_ENABLE_TELEMETRY=0` covers that hub's own data: an event about a
 * task or project on it is never sent, while events about the home hub (the one this
 * app's own data lives on) and about hubs that permit telemetry still are.
 */
describe('trackForHub', () => {
  async function running(): Promise<TelemetryModule> {
    const t = await load()
    await t.applyTelemetryTier('anonymous')
    t.setHubTelemetryPolicy({
      homeHubId: 'local',
      permits: new Map<string, boolean | null>([
        ['hub:off', false],
        ['hub:on', true],
        ['hub:asking', null]
      ])
    })
    posthog.capture.mockClear()
    return t
  }
  const sent = () => posthog.capture.mock.calls.map((c) => (c as unknown[])[0])

  it('drops events about a hub that turned telemetry off', async () => {
    const t = await running()
    t.trackForHub('hub:off', 'task_snoozed')
    expect(posthog.capture).not.toHaveBeenCalled()
  })

  it('drops events about a hub that has not answered yet, or that it does not know (fail closed)', async () => {
    const t = await running()
    t.trackForHub('hub:asking', 'task_snoozed')
    t.trackForHub('hub:never-heard-of', 'task_snoozed')
    expect(posthog.capture).not.toHaveBeenCalled()
  })

  it('sends events about the home hub (by id or null) and about a hub that permits it', async () => {
    const t = await running()
    t.trackForHub('local', 'task_unsnoozed')
    t.trackForHub(null, 'zen_mode_toggled')
    t.trackForHub('hub:on', 'task_snoozed')
    expect(sent()).toEqual(['task_unsnoozed', 'zen_mode_toggled', 'task_snoozed'])
  })

  it('before any policy is known only the home hub is reported on', async () => {
    const t = await load()
    await t.applyTelemetryTier('anonymous')
    posthog.capture.mockClear()
    t.trackForHub(null, 'zen_mode_toggled')
    t.trackForHub('hub:on', 'task_snoozed')
    expect(sent()).toEqual(['zen_mode_toggled'])
  })
})
