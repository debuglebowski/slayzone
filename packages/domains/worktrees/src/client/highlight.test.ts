/**
 * Tests for highlight.ts tokenize cache + in-flight dedupe.
 *
 * Mocks `./tokenize-worker?worker` with a controllable stub so we can drive
 * responses synchronously and exercise the LRU behavior without spinning up
 * a real Web Worker.
 *
 * Run: pnpm --filter @slayzone/worktrees exec vitest run src/client/highlight.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Controllable in-test worker. Each postMessage request is captured; tests
// resolve it via `respond(id, spans)`. `sent` lists outgoing requests so we
// can assert dedupe (one worker call for N concurrent callers).
type SentReq = { id: string; content: string; path: string }

const workerState: {
  instances: MockWorker[]
  sent: SentReq[]
} = { instances: [], sent: [] }

class MockWorker {
  listeners: Record<string, Array<(ev: unknown) => void>> = {}
  terminated = false

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(cb)
  }

  removeEventListener(type: string, cb: (ev: unknown) => void): void {
    const arr = this.listeners[type]
    if (!arr) return
    const i = arr.indexOf(cb)
    if (i >= 0) arr.splice(i, 1)
  }

  postMessage(msg: SentReq): void {
    workerState.sent.push(msg)
  }

  terminate(): void {
    this.terminated = true
  }

  // Helpers used directly by tests.
  emitMessage(data: unknown): void {
    const evs = this.listeners['message']
    if (!evs) return
    for (const cb of evs) cb({ data })
  }

  emitError(message: string): void {
    const evs = this.listeners['error']
    if (!evs) return
    for (const cb of evs) cb({ message })
  }
}

vi.mock('./tokenize-worker?worker', () => ({
  default: class {
    constructor() {
      const w = new MockWorker()
      workerState.instances.push(w)
      return w as unknown as object
    }
  },
}))

// Type-only import so tests can reference the signature; real module is
// dynamically imported per-test after `vi.resetModules()` so the module-level
// worker slot + LRU state is fresh each time.
type HighlightModule = typeof import('./highlight')
let mod: HighlightModule

async function loadMod(): Promise<void> {
  vi.resetModules()
  workerState.sent.length = 0
  workerState.instances.length = 0
  mod = await import('./highlight')
  mod._clearTokenizeCache()
}

function findWorker(): MockWorker {
  const w = workerState.instances[workerState.instances.length - 1]
  if (!w) throw new Error('no worker instance created')
  return w
}

function respond(id: string, spans: unknown[][] = []): void {
  findWorker().emitMessage({ id, spans })
}

function respondError(id: string, err: string): void {
  findWorker().emitMessage({ id, error: err })
}

beforeEach(async () => {
  await loadMod()
})

describe('highlight tokenize cache', () => {
  it('second call for same content returns cached result without a worker round-trip', async () => {
    const p = mod.tokenizeContent('const x = 1', 'a.ts')
    expect(workerState.sent).toHaveLength(1)
    const id = workerState.sent[0].id
    respond(id, [[{ from: 0, to: 5, classes: 'kw' }]])
    const spans1 = await p
    expect(spans1).toEqual([[{ from: 0, to: 5, classes: 'kw' }]])

    const spans2 = await mod.tokenizeContent('const x = 1', 'a.ts')
    // Cache hit — no second worker call.
    expect(workerState.sent).toHaveLength(1)
    expect(spans2).toEqual(spans1)
  })

  it('in-flight dedupe: concurrent calls share one worker request', async () => {
    const p1 = mod.tokenizeContent('abc', 'a.ts')
    const p2 = mod.tokenizeContent('abc', 'a.ts')
    const p3 = mod.tokenizeContent('abc', 'a.ts')
    // All three callers dedupe onto one Promise → one worker request.
    expect(workerState.sent).toHaveLength(1)
    const id = workerState.sent[0].id
    respond(id, [[{ from: 0, to: 3, classes: 'id' }]])
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1).toEqual(r2)
    expect(r2).toEqual(r3)
  })

  it('rejected pending Promise is purged from cache so next call retries', async () => {
    const p1 = mod.tokenizeContent('bad', 'err.ts')
    const id1 = workerState.sent[0].id
    respondError(id1, 'parse failed')
    // highlight.ts catches in .catch → resolves to [] (with console.warn).
    const r1 = await p1
    expect(r1).toEqual([])

    // Next call for same key must NOT hit cached rejection — should make a
    // fresh worker request. (Error path calls cacheDelete on the pending
    // promise entry before it could be observed as cached.)
    const p2 = mod.tokenizeContent('bad', 'err.ts')
    expect(workerState.sent).toHaveLength(2)
    respond(workerState.sent[1].id, [[{ from: 0, to: 3, classes: 'id' }]])
    const r2 = await p2
    expect(r2).toEqual([[{ from: 0, to: 3, classes: 'id' }]])
  })

  it('LRU count cap: inserting more than MAX_ENTRIES (128) evicts the oldest', async () => {
    // Warm one known entry, then fill past MAX_ENTRIES with distinct content.
    const oldContent = 'old-marker'
    const oldP = mod.tokenizeContent(oldContent, 'o.ts')
    respond(workerState.sent[workerState.sent.length - 1].id, [
      [{ from: 0, to: 3, classes: 'initial' }],
    ])
    const oldRef = await oldP

    // Insert 129 unique entries → pushes oldContent past the cap.
    for (let i = 0; i < 129; i++) {
      const p = mod.tokenizeContent(`filler-${i}`, 'f.ts')
      respond(workerState.sent[workerState.sent.length - 1].id, [])
      await p
    }

    // oldContent must be evicted: re-requesting spawns a new worker call.
    const sentBefore = workerState.sent.length
    const reP = mod.tokenizeContent(oldContent, 'o.ts')
    expect(workerState.sent.length).toBe(sentBefore + 1)
    respond(workerState.sent[workerState.sent.length - 1].id, [
      [{ from: 0, to: 3, classes: 'fresh' }],
    ])
    const reRef = await reP
    // Different span payload to prove we re-fetched vs returned cached.
    expect(reRef).not.toEqual(oldRef)
  })

  it('LRU promote-on-hit: touched entry survives later eviction wave', async () => {
    // Insert two entries; touch the first; then fill past the cap such that
    // without promote the first would die. With promote, second should die.
    const a = 'survivor-content'
    const b = 'victim-content'

    const pa = mod.tokenizeContent(a, 'a.ts')
    respond(workerState.sent[workerState.sent.length - 1].id, [
      [{ from: 0, to: 3, classes: 'a' }],
    ])
    await pa

    const pb = mod.tokenizeContent(b, 'b.ts')
    respond(workerState.sent[workerState.sent.length - 1].id, [
      [{ from: 0, to: 3, classes: 'b' }],
    ])
    await pb

    // Touch `a` — promotes to MRU (delete + reinsert).
    await mod.tokenizeContent(a, 'a.ts')

    // Fill enough fillers to push `b` out but not `a`. Cache is currently:
    // [b, a] (a was promoted). MAX_ENTRIES=128. Inserting 127 fillers brings
    // size to 129 → one eviction: head=b. a remains.
    for (let i = 0; i < 127; i++) {
      const pf = mod.tokenizeContent(`filler-${i}`, 'f.ts')
      respond(workerState.sent[workerState.sent.length - 1].id, [])
      await pf
    }

    // Verify a still cached: no new worker call on a.
    const sentBeforeA = workerState.sent.length
    await mod.tokenizeContent(a, 'a.ts')
    expect(workerState.sent.length).toBe(sentBeforeA)

    // Verify b evicted: new worker call on b.
    const sentBeforeB = workerState.sent.length
    const pReB = mod.tokenizeContent(b, 'b.ts')
    expect(workerState.sent.length).toBe(sentBeforeB + 1)
    respond(workerState.sent[workerState.sent.length - 1].id, [])
    await pReB
  })

  it('LRU byte cap: huge content eviction driven by MAX_BYTES, not count', async () => {
    // MAX_BYTES = 16 MiB; estimateSpansBytes = content.length * 4. So a single
    // 5 MiB content = 20 MiB accounted bytes → must evict even when no other
    // entries exist. Skip-large-file guard kicks at 200 KB, caching [] with
    // bytes=0. To exercise the byte cap cleanly we need content just under the
    // skip limit but repeated. Use multiple ~150KB entries; estimate = 600 KB
    // each. 30 entries ≈ 18 MB → byte cap trips before count cap (128).
    const size = 150_000
    const mk = (id: number): string => `${id}:` + 'a'.repeat(size - 3)

    // Insert 30 distinct entries.
    for (let i = 0; i < 30; i++) {
      const p = mod.tokenizeContent(mk(i), `f${i}.ts`)
      respond(workerState.sent[workerState.sent.length - 1].id, [])
      await p
    }

    // Count cap (128) is NOT hit. Byte cap IS. The earliest entry (i=0) is the
    // oldest in insertion order; by now should be byte-evicted.
    const sentBefore = workerState.sent.length
    const pRe = mod.tokenizeContent(mk(0), 'f0.ts')
    expect(workerState.sent.length).toBe(sentBefore + 1)
    respond(workerState.sent[workerState.sent.length - 1].id, [])
    await pRe
  })
})
