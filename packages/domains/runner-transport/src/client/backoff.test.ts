import { describe, expect, it } from 'vitest'
import { computeBackoffDelayMs } from './backoff'

describe('computeBackoffDelayMs', () => {
  it('grows exponentially from initialDelayMs and caps at maxDelayMs', () => {
    const opts = { initialDelayMs: 100, maxDelayMs: 1_000, multiplier: 2, jitterRatio: 0 }
    const delays = [1, 2, 3, 4, 5, 6].map((attempt) => computeBackoffDelayMs(attempt, opts))
    expect(delays).toEqual([100, 200, 400, 800, 1_000, 1_000])
  })

  it('defaults to 100ms → 30s doubling', () => {
    // The FIRST retry is fast on purpose: the common disconnect is a hub restart
    // that is listening again within a few hundred ms, and with runners as the only
    // execution path any work attempted inside that gap fails outright.
    expect(computeBackoffDelayMs(1)).toBe(100)
    expect(computeBackoffDelayMs(2)).toBe(200)
    // Growth is unchanged, so a genuinely-down hub still backs off to the cap.
    expect(computeBackoffDelayMs(10)).toBe(30_000)
  })

  it('applies deterministic jitter through the injected random source', () => {
    const opts = { initialDelayMs: 100, maxDelayMs: 10_000, multiplier: 2, jitterRatio: 0.5 }
    expect(computeBackoffDelayMs(1, opts, () => 1)).toBe(150) // +50%
    expect(computeBackoffDelayMs(1, opts, () => 0)).toBe(50) // -50%
    expect(computeBackoffDelayMs(1, opts, () => 0.5)).toBe(100) // centered
  })

  it('never exceeds maxDelayMs or goes negative under jitter', () => {
    const opts = { initialDelayMs: 100, maxDelayMs: 120, multiplier: 2, jitterRatio: 1 }
    expect(computeBackoffDelayMs(1, opts, () => 1)).toBeLessThanOrEqual(120)
    expect(computeBackoffDelayMs(1, opts, () => 0)).toBeGreaterThanOrEqual(0)
  })
})
