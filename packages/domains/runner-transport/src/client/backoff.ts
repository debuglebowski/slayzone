/**
 * Reconnect backoff policy for the hub dialer. Pure and injectable so the
 * schedule is unit-testable without timers.
 *
 * @module runner/client/backoff
 */

export interface BackoffOptions {
  /**
   * Delay before the first retry. Default 100ms.
   *
   * Deliberately small: the overwhelmingly common disconnect is the HUB
   * restarting, where the runner's socket closes and the hub is listening again
   * within a few hundred ms. A full second of dead time there is user-visible —
   * and since runners are now the only execution path, work attempted inside that
   * window fails rather than quietly running on the hub.
   *
   * The exponential growth below still protects a hub that is genuinely down: 100ms
   * → 200 → 400 … so a persistent outage backs off just as before, only starting
   * from a value tuned for the common case instead of the rare one.
   */
  initialDelayMs: number
  /** Upper bound for any retry delay. Default 30s. */
  maxDelayMs: number
  /** Exponential growth factor. Default 2. */
  multiplier: number
  /** 0..1 — each delay is jittered by up to ±(ratio × delay). Default 0. */
  jitterRatio: number
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialDelayMs: 100,
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
