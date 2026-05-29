import { use, useSyncExternalStore } from 'react'

type Fetcher = (...args: any[]) => Promise<any>
type Fetchers = Record<string, Fetcher>
type FetcherReturn<F> = F extends (...args: any[]) => Promise<infer R> ? R : never
type FetcherArgs<F> = F extends (...args: infer A) => any ? A : never

interface CacheEntry {
  promise: Promise<any>
  value?: unknown
  error?: unknown
  settled: boolean
}

/**
 * React-aware Suspense cache for async data fetching.
 *
 * - Caches promises by key+args, deduplicates in-flight requests
 * - Integrates with React via useSyncExternalStore — invalidation triggers re-renders
 * - Components use the `useData` hook which calls React 19's `use()` internally
 * - Tracks resolved values so prefetched data returns synchronously (no Suspense delay)
 * - Eviction prevents unbounded memory growth
 */
export interface SuspenseCache<F extends Fetchers> {
  /**
   * React hook: returns resolved data, suspends if pending, throws if rejected.
   * Must be called inside a <Suspense> boundary.
   * If data was prefetched and resolved, returns synchronously without suspending.
   */
  useData<K extends keyof F & string>(key: K, ...args: FetcherArgs<F[K]>): FetcherReturn<F[K]>

  /** Start fetching data without suspending. Warms the cache so useData resolves instantly. */
  prefetch<K extends keyof F & string>(key: K, ...args: FetcherArgs<F[K]>): void

  /** Seed a resolved cache entry from already-loaded app state. */
  prime<K extends keyof F & string>(
    key: K,
    args: FetcherArgs<F[K]>,
    value: FetcherReturn<F[K]>
  ): void

  /** Invalidate a specific cache entry. Triggers re-render → re-suspend. */
  invalidate<K extends keyof F & string>(key: K, ...args: FetcherArgs<F[K]>): void

  /** Invalidate all entries for a given fetcher key. */
  invalidateAll<K extends keyof F & string>(key: K): void

  /** Remove a specific cache entry without triggering re-renders. Use on cleanup. */
  evict<K extends keyof F & string>(key: K, ...args: FetcherArgs<F[K]>): void
}

export function createSuspenseCache<F extends Fetchers>(fetchers: F): SuspenseCache<F> {
  const cache = new Map<string, CacheEntry>()
  const listeners = new Set<() => void>()
  // Version counter — useSyncExternalStore uses this to detect changes
  let version = 0

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function getSnapshot(): number {
    return version
  }

  function notify(): void {
    version++
    listeners.forEach((l) => l())
  }

  function cacheKey(key: string, args: unknown[]): string {
    return args.length === 0 ? key : `${key}:${JSON.stringify(args)}`
  }

  function getOrFetch(key: string, args: unknown[]): CacheEntry {
    const k = cacheKey(key, args)
    let entry = cache.get(k)
    if (!entry) {
      const fetcher = fetchers[key]
      const promise = fetcher(...args)
      entry = { promise, settled: false }
      const e = entry
      promise.then(
        (value) => {
          e.value = value
          e.settled = true
          notify()
        },
        (error) => {
          e.error = error
          e.settled = true
          notify()
        }
      )
      // Prevent unhandled rejection warnings. The original promise still rejects —
      // use() will re-throw into the error boundary. Failed entries stay in cache
      // until explicitly invalidated (allows error boundary to catch and display).
      promise.catch(() => {})
      cache.set(k, entry)
    }
    return entry
  }

  return {
    useData(key, ...args) {
      // Subscribe to cache changes so invalidation triggers re-render
      useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const entry = getOrFetch(key, args)
      if (entry.settled) {
        // Data already resolved — return synchronously, bypassing use() scheduling delay
        if (entry.error !== undefined) throw entry.error
        return entry.value
      }
      // Not yet resolved — fall through to use() which will suspend
      return use(entry.promise)
    },

    prefetch(key, ...args) {
      getOrFetch(key, args)
    },

    prime(key, args, value) {
      const k = cacheKey(key, args)
      const existing = cache.get(k)
      cache.set(k, {
        promise: Promise.resolve(value),
        value,
        settled: true
      })
      if (existing && !existing.settled) notify()
    },

    invalidate(key, ...args) {
      const k = cacheKey(key, args)
      if (cache.delete(k)) notify()
    },

    invalidateAll(key) {
      const prefix = `${key}:`
      let deleted = false
      for (const k of cache.keys()) {
        if (k === key || k.startsWith(prefix)) {
          cache.delete(k)
          deleted = true
        }
      }
      if (deleted) notify()
    },

    evict(key, ...args) {
      cache.delete(cacheKey(key, args))
    }
  }
}
