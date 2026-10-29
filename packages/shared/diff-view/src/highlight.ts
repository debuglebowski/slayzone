import TokenizeWorker from './tokenize-worker?worker'
import type { HlSpan, TokenizeRequest, TokenizeResponse } from './tokenize-worker'

export type { HlSpan } from './tokenize-worker'

type Pending = {
  resolve: (spans: HlSpan[][]) => void
  reject: (err: Error) => void
}

// ── Worker pool (M4) ─────────────────────────────────────────────────
// Pool size of 1 keeps current behaviour: each worker duplicates the full
// Lezer language bundle, so a pool of 2 doubles memory cost. With the M3
// content-hash cache in front, repeat tokenize requests never hit a worker,
// so a single worker is sufficient. Bump to >=2 only after measurement shows
// serial queue is the bottleneck.
const WORKER_POOL_SIZE = 1

type Slot = {
  worker: Worker | null
  pending: Map<string, Pending>
}

const slots: Slot[] = Array.from({ length: WORKER_POOL_SIZE }, () => ({
  worker: null,
  pending: new Map<string, Pending>()
}))
const loggedErrorPaths = new Set<string>()
let nextId = 0
let rrCursor = 0

function getWorker(slotIdx: number): Worker {
  const slot = slots[slotIdx]
  if (slot.worker) return slot.worker
  const w = new TokenizeWorker()
  slot.worker = w
  w.addEventListener('message', (event: MessageEvent<TokenizeResponse>) => {
    const msg = event.data
    const p = slot.pending.get(msg.id)
    if (!p) return
    slot.pending.delete(msg.id)
    if ('error' in msg) {
      p.reject(new Error(msg.error))
    } else {
      p.resolve(msg.spans)
    }
  })
  w.addEventListener('error', (ev) => {
    // Fail all outstanding requests on this slot — worker crashed.
    // Cache remains valid; pending-dedupe Promises reject so callers retry.
    const err = new Error(ev.message || 'tokenize worker error')
    for (const p of slot.pending.values()) p.reject(err)
    slot.pending.clear()
    slot.worker?.terminate()
    slot.worker = null
  })
  return w
}

// ── Content-hash tokenize cache (M3) ─────────────────────────────────
// Key = `${ext}\0${content}`. Content strings here are single-file diff
// buffers (tens of KB at most); using the raw string as part of the key
// is cheaper than hashing and collision-free. Map-based LRU: delete-and-
// reinsert on hit promotes to MRU; eviction drops the oldest entry.
// In-flight dedupe: a pending Promise is stored in the same slot so
// concurrent callers for identical content share one worker round-trip.
// Rejected Promises are purged so transient failures don't poison cache.
// Count cap bounds small-file churn; byte cap bounds the total resident
// span data across many large files.
const MAX_ENTRIES = 128
// 16 MB total across resolved entries — prevents unbounded growth from many
// large-file span sets; pending Promises contribute 0 until they resolve.
const MAX_BYTES = 16 * 1024 * 1024
type CacheValue = HlSpan[][] | Promise<HlSpan[][]>
type CacheEntry = { value: CacheValue; bytes: number }
const tokenizeCache = new Map<string, CacheEntry>()
let tokenizeCacheBytes = 0

// Heuristic: span density roughly tracks content length; `len * 4` approximates
// the UTF-16 key (len*2 since ext prefix is tiny) + proportional spans cost.
function estimateSpansBytes(content: string): number {
  return content.length * 4
}

// ── Skip-large-file guard (I) ────────────────────────────────────────
// Lezer tokenization is O(content length) with a steep constant factor from
// building the full parse tree. Past these thresholds the worker stalls and
// dominates the hot path — plain text is the right sustainable fallback.
// Logged once per path so we don't spam the console when the same file
// re-enters view repeatedly.
const MAX_HIGHLIGHT_BYTES = 200_000
const MAX_HIGHLIGHT_LINES = 5_000
const loggedSkipPaths = new Set<string>()

function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++
  }
  return n
}

function getExt(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot < 0 || dot === path.length - 1) return ''
  return path.slice(dot + 1).toLowerCase()
}

function evictTokenizeCache(): void {
  // Evict oldest-inserted entries until both caps satisfied.
  while (tokenizeCache.size > MAX_ENTRIES || tokenizeCacheBytes > MAX_BYTES) {
    const iter = tokenizeCache.keys().next()
    if (iter.done) break
    const oldestKey = iter.value
    const oldest = tokenizeCache.get(oldestKey)
    if (oldest === undefined) break
    tokenizeCache.delete(oldestKey)
    tokenizeCacheBytes -= oldest.bytes
    if (tokenizeCacheBytes < 0) tokenizeCacheBytes = 0
  }
}

// `bytes` is 0 for pending Promises (size unknown until resolved) and the
// estimated payload for resolved spans. Subtracts any prior entry's bytes
// before re-adding so the running total stays consistent on replace.
function cacheSet(key: string, value: CacheValue, bytes: number): void {
  const prev = tokenizeCache.get(key)
  if (prev !== undefined) {
    tokenizeCache.delete(key)
    tokenizeCacheBytes -= prev.bytes
    if (tokenizeCacheBytes < 0) tokenizeCacheBytes = 0
  }
  tokenizeCache.set(key, { value, bytes })
  tokenizeCacheBytes += bytes
  evictTokenizeCache()
}

function cacheDelete(key: string): void {
  const prev = tokenizeCache.get(key)
  if (prev === undefined) return
  tokenizeCache.delete(key)
  tokenizeCacheBytes -= prev.bytes
  if (tokenizeCacheBytes < 0) tokenizeCacheBytes = 0
}

/**
 * Tokenize content off the main thread. Resolves to per-line spans.
 * Returns `[]` for unsupported languages / empty content.
 *
 * Cached by (extension, content). Identical files across panels/tabs
 * parse exactly once. Concurrent calls for the same key share one
 * worker request via pending-Promise dedupe.
 */
export function tokenizeContent(content: string, path: string): Promise<HlSpan[][]> {
  if (!content) return Promise.resolve([])

  const key = `${getExt(path)}\0${content}`
  const cached = tokenizeCache.get(key)
  if (cached !== undefined) {
    // Hit — promote to MRU. Works for both resolved arrays and pending Promises.
    // Reuse cached bytes so running total stays consistent across promotion.
    cacheSet(key, cached.value, cached.bytes)
    return Promise.resolve(cached.value)
  }

  // Large-file bailout (I). Measure bytes first (cheap), then newlines only if
  // needed. Cache the empty-spans decision under the same key so we don't
  // re-measure on every call — plain text is the right fallback here.
  if (content.length > MAX_HIGHLIGHT_BYTES || countNewlines(content) + 1 > MAX_HIGHLIGHT_LINES) {
    if (!loggedSkipPaths.has(path)) {
      loggedSkipPaths.add(path)

      console.info(`[highlight] skipped large file: ${path} (${content.length} bytes)`)
    }
    const empty: HlSpan[][] = []
    // Empty-spans marker: tiny payload, effectively 0 bytes.
    cacheSet(key, empty, 0)
    return Promise.resolve(empty)
  }

  const id = `${nextId++}`
  const slotIdx = rrCursor
  rrCursor = (rrCursor + 1) % WORKER_POOL_SIZE
  const slot = slots[slotIdx]
  const req: TokenizeRequest = { id, content, path }

  const promise = new Promise<HlSpan[][]>((resolve, reject) => {
    slot.pending.set(id, { resolve, reject })
    try {
      getWorker(slotIdx).postMessage(req)
    } catch (err) {
      slot.pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  }).then(
    (spans) => {
      // Replace pending Promise with resolved spans (including empty [] for
      // unsupported languages — consistent caching). Only now do we know the
      // real byte cost, so accounting catches up here.
      cacheSet(key, spans, estimateSpansBytes(content))
      return spans
    },
    (err) => {
      // Purge the pending Promise so errors are never cached. Use cacheDelete
      // to keep the running byte total consistent (Promise bytes were 0, but
      // still go through the helper for safety).
      const entry = tokenizeCache.get(key)
      if (entry !== undefined && entry.value === promise) cacheDelete(key)
      throw err
    }
  )

  // Store the in-flight Promise so concurrent callers dedupe onto it. Pending
  // entries contribute 0 bytes — we don't know span size yet and don't want
  // to over-evict resolved entries to make room for an unmeasured Promise.
  cacheSet(key, promise, 0)

  return promise.catch((err) => {
    if (!loggedErrorPaths.has(path)) {
      loggedErrorPaths.add(path)

      console.warn(`[tokenize-worker] failed to tokenize ${path}:`, err)
    }
    return []
  })
}

/** Test/diagnostic hook. Clears the module-level tokenize cache. */
export function _clearTokenizeCache(): void {
  tokenizeCache.clear()
  tokenizeCacheBytes = 0
}
