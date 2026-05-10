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

interface DedupOptions<R = unknown> {
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
 * The cache is per-handler (closed over). Main-process restart clears it —
 * fine, since the renderer's first call after boot always returns the full
 * payload (no prior hash).
 */
export function withResultDedup<E, A extends unknown[], R>(
  handler: (event: E, ...args: A) => R | Promise<R>,
  options: DedupOptions<R> = {}
): (event: E, ...args: A) => Promise<R | IpcUnchangedSentinel> {
  const maxEntries = options.maxEntries ?? 64
  const hashFn = options.hashFn ?? ((r: R) => JSON.stringify(r))
  const cache = new Map<string, string>()

  return async (event: E, ...args: A): Promise<R | IpcUnchangedSentinel> => {
    const result = await handler(event, ...args)

    let argsKey: string
    try { argsKey = JSON.stringify(args) } catch { return result }
    let resultHash: string
    try { resultHash = hashFn(result) } catch { return result }

    if (cache.get(argsKey) === resultHash) return UNCHANGED

    cache.set(argsKey, resultHash)
    if (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value
      if (oldestKey !== undefined) cache.delete(oldestKey)
    }
    return result
  }
}
