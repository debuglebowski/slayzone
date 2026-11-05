/**
 * Usage is parsed where the logs are — each connected computer — and the hub keeps
 * each computer's parse cursors apart (`usage_parse_state` keyed by computer AND
 * file: two computers' `~/.claude/projects/x.jsonl` are different files). Records
 * aggregate in one table; a computer that cannot answer is skipped this refresh.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { refreshUsageData, setUsageCollectRouting } from './cache'

const h = await createTestHarness()
const db = h.slayDb
const file = '/home/u/.claude/projects/p/s.jsonl'
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

const asked: Array<{ computerId: string; cursors: Record<string, unknown> }> = []

afterEach(() => setUsageCollectRouting(null))

describe('usage from computers', () => {
  test('each computer parses its own logs; cursors are kept per computer', async () => {
    setUsageCollectRouting({
      computers: () => ['c1', 'c2', 'gone'],
      collect: async (computerId, cursors) => {
        asked.push({ computerId, cursors })
        if (computerId === 'gone') throw new Error('offline')
        return {
          results: [
            {
              sourceFile: file,
              fileMtimeMs: computerId === 'c1' ? 10 : 20,
              endOffset: computerId === 'c1' ? 100 : 200,
              records: [rec(`${computerId}-r1`)]
            }
          ]
        }
      }
    })
    await refreshUsageData(db)
    const states = h.db
      .prepare('SELECT computer_id, last_offset FROM usage_parse_state ORDER BY computer_id')
      .all()
    expect(states).toEqual([
      { computer_id: 'c1', last_offset: 100 },
      { computer_id: 'c2', last_offset: 200 }
    ])
    const n = h.db.prepare('SELECT COUNT(*) AS n FROM usage_records').get() as { n: number }
    expect(n.n).toBe(2)

    asked.length = 0
    await refreshUsageData(db)
    expect(asked.find((a) => a.computerId === 'c1')?.cursors).toEqual({
      [file]: { offset: 100, modifiedMs: 10 }
    })
    expect(asked.find((a) => a.computerId === 'c2')?.cursors).toEqual({
      [file]: { offset: 200, modifiedMs: 20 }
    })
  })
})

// v194 kept the hub's own parse cursors under computer_id '' (this hub's disk). On
// the desktop the local computer reads those very files: its first collect must
// start from them, or it re-parses every log in one huge reply (81 MiB measured)
// that times out on every refresh. Another computer's disk is not this hub's.
describe("the hub's old cursors after v194", () => {
  test('the local computer takes them over; another computer does not', async () => {
    h.db.prepare('DELETE FROM usage_parse_state').run()
    h.db
      .prepare(
        "INSERT INTO usage_parse_state (computer_id, file_path, last_offset, last_modified_ms) VALUES ('', ?, 500, 50)"
      )
      .run(file)
    const seen: Record<string, Record<string, unknown>> = {}
    setUsageCollectRouting({
      computers: () => ['remote', 'local'],
      localComputerId: () => 'local',
      collect: async (computerId, cursors) => {
        seen[computerId] = cursors
        return { results: [] }
      }
    })
    await refreshUsageData(db)
    expect(seen.local).toEqual({ [file]: { offset: 500, modifiedMs: 50 } })
    expect(seen.remote).toEqual({})
    const rows = h.db
      .prepare('SELECT computer_id FROM usage_parse_state ORDER BY computer_id')
      .all()
    expect(rows, 'moved, not copied: the hub-disk rows are gone').toEqual([
      { computer_id: 'local' }
    ])
  })
})

// A large collect arrives in pages: each page's records and complete cursors are
// saved before the next is asked for, so a page that fails loses nothing already
// delivered; a file split across pages keeps its cursor until its last chunk.
describe('paged collect', () => {
  test('saves page by page and follows `next` until done', async () => {
    h.db.prepare('DELETE FROM usage_parse_state').run()
    h.db.prepare('DELETE FROM usage_records').run()
    const a = '/home/u/.claude/projects/p/a.jsonl'
    const b = '/home/u/.claude/projects/p/b.jsonl'
    const calls: unknown[] = []
    setUsageCollectRouting({
      computers: () => ['c1'],
      collect: async (_computerId, _cursors, page) => {
        calls.push(page ?? null)
        if (!page)
          return {
            results: [
              { sourceFile: a, fileMtimeMs: 1, endOffset: 10, records: [rec('pa-1')] },
              {
                sourceFile: b,
                fileMtimeMs: 2,
                endOffset: 0,
                complete: false,
                records: [rec('pb-1')]
              }
            ],
            next: { token: 't', index: 1 }
          }
        throw new Error('page 2 lost')
      }
    })
    await refreshUsageData(db)
    expect(calls).toEqual([null, { token: 't', index: 1 }])
    const states = h.db
      .prepare('SELECT file_path, last_offset FROM usage_parse_state ORDER BY file_path')
      .all()
    expect(states, "a's cursor moved; b (split, unfinished) kept none").toEqual([
      { file_path: a, last_offset: 10 }
    ])
    const ids = (
      h.db.prepare('SELECT id FROM usage_records ORDER BY id').all() as Array<{
        id: string
      }>
    ).map((r) => r.id)
    expect(ids, "page 1's records are stored").toEqual(['pa-1', 'pb-1'])
  })
})
