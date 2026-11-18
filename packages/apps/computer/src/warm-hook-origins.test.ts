import { afterEach, describe, expect, test, vi } from 'vitest'
import { WARM_ORIGIN_ENDED_MAX, WARM_ORIGIN_TTL_MS, WarmHookOrigins } from './warm-hook-origins'

afterEach(() => vi.useRealTimers())

describe('WarmHookOrigins', () => {
  test('a live, unadopted warm process names its hooks — only with its boot task id', () => {
    const o = new WarmHookOrigins()
    o.spawned('w1', 'boot-1')
    expect(o.originOf({ warmId: 'w1', taskId: 'boot-1' })).toBe('w1')
    expect(o.originOf({ warmId: 'w1', taskId: 'other' })).toBeNull()
    expect(o.originOf({ warmId: 'w2', taskId: 'boot-1' })).toBeNull()
    expect(o.originOf({ taskId: 'boot-1' })).toBeNull()
    expect(o.originOf({ warmId: 'w1' })).toBeNull()
  })

  test('adoption makes it an ordinary session: no longer warm', () => {
    const o = new WarmHookOrigins()
    o.spawned('w1', 'boot-1')
    o.adopted('w1')
    expect(o.originOf({ warmId: 'w1', taskId: 'boot-1' })).toBeNull()
    // A late exit report for an adopted id records nothing.
    o.ended('w1')
    expect(o.originOf({ warmId: 'w1', taskId: 'boot-1' })).toBeNull()
  })

  test('ended unadopted: still names its hooks (its SessionEnd fires after the kill) until the TTL', () => {
    vi.useFakeTimers()
    const o = new WarmHookOrigins()
    o.spawned('w1', 'boot-1')
    o.ended('w1')
    expect(o.originOf({ warmId: 'w1', taskId: 'boot-1' })).toBe('w1')
    vi.advanceTimersByTime(WARM_ORIGIN_TTL_MS - 1)
    expect(o.originOf({ warmId: 'w1', taskId: 'boot-1' })).toBe('w1')
    vi.advanceTimersByTime(2)
    expect(o.originOf({ warmId: 'w1', taskId: 'boot-1' })).toBeNull()
  })

  test('ended entries are capped, oldest first; live ones are never evicted', () => {
    vi.useFakeTimers()
    const o = new WarmHookOrigins()
    o.spawned('live', 'boot-live')
    for (let i = 0; i <= WARM_ORIGIN_ENDED_MAX; i++) {
      o.spawned(`w${i}`, `boot-${i}`)
      o.ended(`w${i}`)
    }
    expect(o.originOf({ warmId: 'w0', taskId: 'boot-0' })).toBeNull()
    expect(o.originOf({ warmId: 'w1', taskId: 'boot-1' })).toBe('w1')
    expect(
      o.originOf({ warmId: `w${WARM_ORIGIN_ENDED_MAX}`, taskId: `boot-${WARM_ORIGIN_ENDED_MAX}` })
    ).toBe(`w${WARM_ORIGIN_ENDED_MAX}`)
    vi.advanceTimersByTime(WARM_ORIGIN_TTL_MS * 10)
    expect(o.originOf({ warmId: 'live', taskId: 'boot-live' })).toBe('live')
  })

  test('a warm process with no task id in its context is never attributed', () => {
    const o = new WarmHookOrigins()
    o.spawned('w1', undefined)
    expect(o.originOf({ warmId: 'w1', taskId: 'anything' })).toBeNull()
  })
})
