/**
 * Reconnect backoff policy for the hub dialer. Pure and injectable so the
 * schedule is unit-testable without timers.
 *
 * @module fleet/client/backoff
 */

export interface BackoffOptions {
  /** Delay before the first retry. Default 1s. */
  initialDelayMs: number
  /** Upper bound for any retry delay. Default 30s. */
  maxDelayMs: number
  /** Exponential growth factor. Default 2. */
  multiplier: number
  /** 0..1 — each delay is jittered by up to ±(ratio × delay). Default 0. */
  jitterRatio: number
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitterRatio: 0
}

/**
 * Delay before retry `attempt` (1-based: attempt 1 → initialDelayMs).
 * `random` is injectable for deterministic tests.
 */
export function computeBackoffDelayMs(
  attempt: number,
  options: Partial<BackoffOptions> = {},
  random: () => number = Math.random
): number {
  const { initialDelayMs, maxDelayMs, multiplier, jitterRatio } = { ...DEFAULT_BACKOFF, ...options }
  const exponent = Math.max(0, attempt - 1)
  const base = Math.min(maxDelayMs, initialDelayMs * multiplier ** exponent)
  if (jitterRatio <= 0) return Math.round(base)
  const jitter = base * jitterRatio * (random() * 2 - 1)
  return Math.round(Math.min(maxDelayMs, Math.max(0, base + jitter)))
}
