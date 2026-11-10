/**
 * The computer keeps its own usage-log cursors (robustness plan §9, P0; hub v209) and
 * moves one only after the hub acknowledged the page that stored its records. A lost
 * reply re-parses the same bytes (same record ids: the hub's INSERT OR IGNORE keeps
 * one copy).
 */
import { describe, expect, test } from 'vitest'
import type { ParseResult, UsageCursors } from './collect'
import { createUsageCollector, type UsageCursorStore } from './collector'

function memoryStore(initial: UsageCursors = {}) {
  const cursors: UsageCursors = { ...initial }
  const store: UsageCursorStore = {
    all: () => ({ ...cursors }),
    seed(c) {
      for (const [file, cur] of Object.entries(c)) cursors[file] ??= cur
    },
    commit(entries) {
      for (const e of entries)
        cursors[e.sourceFile] = { offset: e.offset, modifiedMs: e.modifiedMs }
    }
  }
  return { store, cursors }
}

const rec = (id: string) => ({
  id,
  provider: 'claude-code',
  model: 'm',
  sessionId: 's',
  timestamp: '2026-11-01T00:00:00Z',
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  cwd: null,
  taskId: null
})

/** A log that grows: parses from the cursor (offset = record count). */
function fakeLog(file: string, ids: string[]) {
  const seen: UsageCursors[] = []
  const collect = async (cursors: UsageCursors): Promise<ParseResult[]> => {
    seen.push(cursors)
    const from = cursors[file]?.offset ?? 0
    if (from >= ids.length) return []
    return [
      {
        sourceFile: file,
        fileMtimeMs: ids.length,
        endOffset: ids.length,
        records: ids.slice(from).map(rec)
      }
    ]
  }
  return { collect, seen }
}

describe('usage collector', () => {
  test('a cursor moves only after the hub acknowledges the page', async () => {
    const { store, cursors } = memoryStore()
    const log = fakeLog('/f', ['a', 'b'])
    const c = createUsageCollector({ store: () => store, collect: log.collect })
    const first = await c.handle({})
    expect(first.results[0]?.records.map((r) => r.id)).toEqual(['a', 'b'])
    expect(first.receipt).toBeDefined()
    expect(cursors['/f'], 'not before the ack').toBeUndefined()
    // The reply was lost (no ack): the next collect parses the same records again.
    const again = await c.handle({})
    expect(again.results[0]?.records.map((r) => r.id)).toEqual(['a', 'b'])
    // Acknowledged: the cursor moves; a bare ack parses nothing.
    expect(await c.handle({ ack: again.receipt })).toEqual({ results: [] })
    expect(cursors['/f']).toEqual({ offset: 2, modifiedMs: 2 })
    expect(log.seen).toHaveLength(2)
    expect(await c.handle({}), 'nothing new: no receipt').toEqual({ results: [] })
  })

  test('the seed fills only cursors this computer does not keep', async () => {
    const { store, cursors } = memoryStore({ '/mine': { offset: 9, modifiedMs: 9 } })
    const log = fakeLog('/f', ['a', 'b', 'c'])
    const c = createUsageCollector({ store: () => store, collect: log.collect })
    const reply = await c.handle({
      seed: { '/mine': { offset: 1, modifiedMs: 1 }, '/f': { offset: 2, modifiedMs: 2 } }
    })
    expect(log.seen[0]).toEqual({
      '/mine': { offset: 9, modifiedMs: 9 },
      '/f': { offset: 2, modifiedMs: 2 }
    })
    expect(reply.results[0]?.records.map((r) => r.id)).toEqual(['c'])
    expect(cursors['/mine']).toEqual({ offset: 9, modifiedMs: 9 })
  })

  test('pages commit in order; a file split across pages moves with its last chunk', async () => {
    const { store, cursors } = memoryStore()
    const ids = Array.from({ length: 60 }, (_, i) => `r-${i}`)
    const log = fakeLog('/big', ids)
    const c = createUsageCollector({ store: () => store, collect: log.collect, pageBytes: 2048 })
    let reply = await c.handle({})
    const got: string[] = []
    let pages = 0
    for (;;) {
      pages++
      got.push(...reply.results.flatMap((r) => r.records.map((x) => x.id)))
      if (!reply.next) break
      reply = await c.handle({ ack: reply.receipt, page: reply.next })
      expect(cursors['/big'], 'not before its last chunk is stored').toBeUndefined()
    }
    expect(pages).toBeGreaterThan(2)
    expect(got).toEqual(ids)
    await c.handle({ ack: reply.receipt })
    expect(cursors['/big']).toEqual({ offset: 60, modifiedMs: 60 })
  })

  test('an unknown or expired token answers nothing', async () => {
    const { store } = memoryStore()
    const c = createUsageCollector({ store: () => store, collect: async () => [] })
    expect(await c.handle({ page: { token: 'gone', index: 1 } })).toEqual({ results: [] })
    expect(await c.handle({ ack: { token: 'gone', index: 0 } })).toEqual({ results: [] })
  })
})
