/**
 * Cross-process result dedup for IPC handlers.
 *
 * Wraps an `ipcMain.handle` listener so that consecutive calls with the same
 * args returning identical content return a tiny sentinel instead of the full
 * payload. The renderer-side preload wrapper detects the sentinel and reuses
 * its cached previous value — eliminating both the IPC serialization cost on
 * the main side and the deserialization cost on the renderer side when state
 * is unchanged.
 *
 * Use only on read-only handlers whose return values are JSON-serializable.
 * Mutation handlers (anything writing state) should NOT be wrapped — the
 * caller usually wants the raw return regardless.
 */

export const IPC_UNCHANGED_SENTINEL = '__ipc_unchanged__' as const

export interface IpcUnchangedSentinel {
  readonly __ipc_unchanged__: true
}

export function isIpcUnchangedSentinel(value: unknown): value is IpcUnchangedSentinel {
  return value !== null && typeof value === 'object' && (value as { __ipc_unchanged__?: unknown }).__ipc_unchanged__ === true
}

const UNCHANGED: IpcUnchangedSentinel = Object.freeze({ __ipc_unchanged__: true })

export interface SenderLifecycle<E> {
  /** Stable per-sender identifier. Return null to bypass dedup for this call. */
  getKey: (event: E) => number | string | null
  /**
   * Subscribe once per sender to lifecycle events that invalidate the cache
   * (e.g. renderer reload, sender destroyed). Called at most once per sender —
   * the wrapper deduplicates registration internally.
   */
  subscribe: (event: E, onClear: () => void) => void
}

interface DedupOptions<E, R = unknown> {
  /**
   * Per-key entry cap. Defaults to 64 — enough for typical args (project paths,
   * branch names) without unbounded growth.
   */
  maxEntries?: number
  /**
   * Override the hash function used to compare results. Defaults to
   * `JSON.stringify`. Provide a stable hash when the result contains
   * time-sensitive fields (e.g. relative date strings) that drift over time
   * but don't represent a real content change.
   */
  hashFn?: (result: R) => string
  /**
   * Optional sender-scoped cache. When provided, the dedup cache is keyed by
   * sender identity and cleared via the lifecycle callback — so a renderer
   * reload invalidates main's cache in lockstep with the renderer's wiped
   * preload cache. Without this, the cache is process-global and renderer
   * reloads will cause `IPC_UNCHANGED_SENTINEL` to be returned to a preload
   * that has no cached value (preload then returns `undefined`).
   */
  sender?: SenderLifecycle<E>
}

/**
 * Wraps an `ipcMain.handle` listener with content-hash dedup. The wrapped
 * listener:
 * - Calls the underlying handler exactly once per invocation (no caching of
 *   the work itself — only the comparison).
 * - Hashes the result and args via `JSON.stringify`, ignoring the first
 *   argument (the Electron `IpcMainInvokeEvent`, which is non-serializable).
 * - Returns `IPC_UNCHANGED_SENTINEL` when args+result hash matches the
 *   previous call for the same args; otherwise returns the result and stores
 *   the new hash.
 *
 * When `options.sender` is provided, the cache is sender-scoped and lifecycle
 * events clear it — required to stay in sync with the preload-side cache
 * across renderer reloads (otherwise the preload returns `undefined` for
 * unchanged sentinels it never cached). See `SenderLifecycle`.
 */
export function withResultDedup<E, A extends unknown[], R>(
  handler: (event: E, ...args: A) => R | Promise<R>,
  options: DedupOptions<E, R> = {}
): (event: E, ...args: A) => Promise<R | IpcUnchangedSentinel> {
  const maxEntries = options.maxEntries ?? 64
  const hashFn = options.hashFn ?? ((r: R) => JSON.stringify(r))
  const sender = options.sender

  const globalCache = new Map<string, string>()
  const scopedCache = new Map<number | string, Map<string, string>>()
  const registered = new Set<number | string>()

  const evictIfFull = (bucket: Map<string, string>) => {
    if (bucket.size > maxEntries) {
      const oldestKey = bucket.keys().next().value
      if (oldestKey !== undefined) bucket.delete(oldestKey)
    }
  }

  return async (event: E, ...args: A): Promise<R | IpcUnchangedSentinel> => {
    const result = await handler(event, ...args)

    let argsKey: string
    try { argsKey = JSON.stringify(args) } catch { return result }
    let resultHash: string
    try { resultHash = hashFn(result) } catch { return result }

    if (!sender) {
      if (globalCache.get(argsKey) === resultHash) return UNCHANGED
      globalCache.set(argsKey, resultHash)
      evictIfFull(globalCache)
      return result
    }

    const senderKey = sender.getKey(event)
    if (senderKey === null) return result

    let bucket = scopedCache.get(senderKey)
    if (!bucket) {
      bucket = new Map<string, string>()
      scopedCache.set(senderKey, bucket)
    }
    if (!registered.has(senderKey)) {
      registered.add(senderKey)
      sender.subscribe(event, () => {
        scopedCache.delete(senderKey)
        registered.delete(senderKey)
      })
    }
    if (bucket.get(argsKey) === resultHash) return UNCHANGED
    bucket.set(argsKey, resultHash)
    evictIfFull(bucket)
    return result
  }
}
