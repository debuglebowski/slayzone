import { use, useSyncExternalStore } from 'react'

// `never[]` params keep the constraint contravariance-safe: a concrete
// `(id: string) => Promise<T>` is assignable to it, which `unknown[]` would
// reject under strictFunctionTypes.
type Fetcher = (...args: never[]) => Promise<unknown>
type Fetchers = Record<string, Fetcher>
type FetcherReturn<F> = F extends (...args: never[]) => Promise<infer R> ? R : never
type FetcherArgs<F> = F extends (...args: infer A) => unknown ? A : never

interface CacheEntry {
  promise: Promise<unknown>
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
      // Keyed by plain string here, so the concrete fetcher's parameter types
      // are unrecoverable — arg correctness is enforced by the public
      // useData/prefetch signatures, which carry FetcherArgs<F[K]>.
      const fetcher = fetchers[key] as (...args: unknown[]) => Promise<unknown>
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
      promise.catch(() => {
        // Body is empty on purpose: this handler exists only to mark the
        // rejection handled, never to consume it — use() re-throws the same
        // rejection into the error boundary.
      })
      cache.set(k, entry)
    }
    return entry
  }

  return {
    useData(key, ...args) {
      // Subscribe to cache changes so invalidation triggers re-render
      useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const entry = getOrFetch(key, args)
      // Entries are stored untyped (one string-keyed map for every fetcher);
      // the public signature is what ties a key back to its fetcher's return.
      type Data = FetcherReturn<F[typeof key]>
      if (entry.settled) {
        // Data already resolved — return synchronously, bypassing use() scheduling delay
        if (entry.error !== undefined) throw entry.error
        return entry.value as Data
      }
      // Not yet resolved — fall through to use() which will suspend
      return use(entry.promise) as Data
    },

    prefetch(key, ...args) {
      getOrFetch(key, args)
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
