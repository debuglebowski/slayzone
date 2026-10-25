import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/** A `React.lazy` component that can also be fetched ahead of its first render. */
export type PreloadableLazy<T extends ComponentType<any>> = LazyExoticComponent<T> & {
  preload: () => Promise<void>
}

/**
 * `React.lazy` plus `.preload()`. Both go through the same `factory`, so warming a
 * chunk can never target a different module than the one the component renders
 * (no second hand-copied import specifier to drift).
 */
export function lazyWithPreload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>
): PreloadableLazy<T> {
  let pending: Promise<{ default: T }> | undefined
  const load = (): Promise<{ default: T }> =>
    (pending ??= factory().catch((err: unknown) => {
      // Forget a failed fetch so the real render retries instead of re-throwing it.
      pending = undefined
      throw err
    }))
  return Object.assign(lazy(load), { preload: () => load().then(() => undefined) })
}

/** Below this much idle time left in the frame, wait for a longer idle period. */
const MIN_IDLE_MS = 8
/** Upper bound per item, so a never-idle renderer still warms eventually. */
const IDLE_TIMEOUT_MS = 10_000

/**
 * Run `loaders` one at a time, each in its own idle period, in order. A chunk's
 * parse/evaluate lands on the main thread when its import resolves, so loading
 * them one per idle callback (and awaiting each) spreads that cost out instead of
 * stacking it into one burst right after boot. Returns a cancel function.
 */
export function preloadOnIdle(loaders: ReadonlyArray<() => Promise<unknown>>): () => void {
  const ric: typeof requestIdleCallback =
    typeof requestIdleCallback === 'function'
      ? requestIdleCallback
      : (cb) =>
          window.setTimeout(
            () => cb({ didTimeout: true, timeRemaining: () => 0 } as IdleDeadline),
            200
          )
  const cic: typeof cancelIdleCallback =
    typeof cancelIdleCallback === 'function' ? cancelIdleCallback : (id) => window.clearTimeout(id)

  let next = 0
  let handle: number | undefined
  let cancelled = false

  const schedule = (): void => {
    if (cancelled || next >= loaders.length) return
    handle = ric(onIdle, { timeout: IDLE_TIMEOUT_MS })
  }
  const onIdle = (deadline: IdleDeadline): void => {
    handle = undefined
    if (cancelled) return
    if (!deadline.didTimeout && deadline.timeRemaining() < MIN_IDLE_MS) return schedule()
    const load = loaders[next++]
    load()
      .catch(() => {
        // Warming is an optimization: a failed prefetch just means the real
        // lazy import pays the fetch cost (and reports its own error).
      })
      .then(schedule)
  }

  schedule()
  return () => {
    cancelled = true
    if (handle !== undefined) cic(handle)
  }
}
