/**
 * Usage is parsed where the logs are — each connected computer — from the read
 * offsets THAT computer keeps (robustness plan §9, P0; v209: the hub keeps none).
 * Records aggregate in one hub table; each stored page is acknowledged so the
 * computer moves its cursors; a computer that cannot answer is skipped this refresh.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { refreshUsageData, setUsageCollectRouting, type UsageCollectRequest } from './cache'

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
const ids = () =>
  (h.db.prepare('SELECT id FROM usage_records ORDER BY id').all() as Array<{ id: string }>).map(
    (r) => r.id
  )
const handoffRows = () =>
  h.db.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_cursor_handoff'").get()
    ? (h.db
        .prepare('SELECT computer_id, file_path FROM usage_cursor_handoff ORDER BY computer_id')
        .all() as Array<{ computer_id: string; file_path: string }>)
    : null

afterEach(() => setUsageCollectRouting(null))

describe('usage from computers', () => {
  test("each computer's records are stored and acknowledged; an offline one is skipped", async () => {
    h.db.exec('DROP TABLE IF EXISTS usage_cursor_handoff')
    const asked: Array<{ computerId: string; request: UsageCollectRequest }> = []
    setUsageCollectRouting({
      computers: () => ['c1', 'c2', 'gone'],
      collect: async (computerId, request) => {
        asked.push({ computerId, request })
        if (computerId === 'gone') throw new Error('offline')
        if (request.ack) return { results: [] }
        return {
          results: [
            {
              sourceFile: file,
              fileMtimeMs: 10,
              endOffset: 100,
              records: [rec(`${computerId}-r1`)]
            }
          ],
          receipt: { token: `tok-${computerId}`, index: 0 }
        }
      }
    })
    await refreshUsageData(db)
    expect(ids()).toEqual(['c1-r1', 'c2-r1'])
    expect(asked).toEqual([
      { computerId: 'c1', request: {} },
      { computerId: 'c1', request: { ack: { token: 'tok-c1', index: 0 } } },
      { computerId: 'c2', request: {} },
      { computerId: 'c2', request: { ack: { token: 'tok-c2', index: 0 } } },
      { computerId: 'gone', request: {} }
    ])
    // The hub keeps no cursor: v209 renamed the old table to a one-time handoff.
    expect(h.db.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_parse_state'").get()).toBe(
      undefined
    )
  })
})

// v209 turned the hub's cursors into a one-time handoff. Each computer gets its own
// rows with its first collect; the hub machine's own computer also gets the hub-disk
// rows (computer_id '', the files it reads), so it never re-parses every log in one
// huge reply. Once taken, they are gone; the table goes when empty.
describe("the hub's former cursors after v209", () => {
  test('each computer is seeded once with its own; the local one also with the hub-disk rows', async () => {
    h.db.exec(`DROP TABLE IF EXISTS usage_cursor_handoff;
      CREATE TABLE usage_cursor_handoff (computer_id TEXT NOT NULL DEFAULT '', file_path TEXT NOT NULL,
        last_offset INTEGER NOT NULL, last_modified_ms REAL NOT NULL, PRIMARY KEY (computer_id, file_path))`)
    h.db
      .prepare(
        `INSERT INTO usage_cursor_handoff (computer_id, file_path, last_offset, last_modified_ms) VALUES
          ('', ?, 500, 50), ('local', ?, 700, 70), ('remote', ?, 9, 1), ('later', ?, 3, 3)`
      )
      .run(file, file, file, '/other')
    const seen: Record<string, UsageCollectRequest[]> = {}
    let remoteUp = false
    setUsageCollectRouting({
      computers: () => ['remote', 'local'],
      localComputerId: () => 'local',
      collect: async (computerId, request) => {
        ;(seen[computerId] ??= []).push(request)
        if (computerId === 'remote' && !remoteUp) throw new Error('timed out')
        return { results: [] }
      }
    })
    await refreshUsageData(db)
    expect(seen.local).toEqual([{ seed: { [file]: { offset: 700, modifiedMs: 70 } } }])
    expect(seen.remote).toEqual([{ seed: { [file]: { offset: 9, modifiedMs: 1 } } }])
    expect(handoffRows(), 'a computer that did not answer keeps its rows').toEqual([
      { computer_id: 'later', file_path: '/other' },
      { computer_id: 'remote', file_path: file }
    ])

    remoteUp = true
    await refreshUsageData(db)
    expect(seen.local?.[1], 'handed over once').toEqual({})
    expect(seen.remote?.[1]).toEqual({ seed: { [file]: { offset: 9, modifiedMs: 1 } } })
    expect(handoffRows()).toEqual([{ computer_id: 'later', file_path: '/other' }])

    setUsageCollectRouting({
      computers: () => ['later'],
      collect: async () => ({ results: [] })
    })
    await refreshUsageData(db)
    expect(handoffRows(), 'dropped once empty').toBe(null)
    await refreshUsageData(db) // no table: nothing owed, no error
  })
})

// A large collect arrives in pages: each page is stored before it is acknowledged
// (with the request for the next one), so a lost page loses nothing earlier and its
// own cursors never move.
describe('paged collect', () => {
  test('stores page by page, acknowledging each with the next request', async () => {
    h.db.exec('DROP TABLE IF EXISTS usage_cursor_handoff')
    h.db.prepare('DELETE FROM usage_records').run()
    const a = '/home/u/.claude/projects/p/a.jsonl'
    const b = '/home/u/.claude/projects/p/b.jsonl'
    const calls: UsageCollectRequest[] = []
    setUsageCollectRouting({
      computers: () => ['c1'],
      collect: async (_computerId, request) => {
        calls.push(request)
        if (!request.page)
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
            next: { token: 't', index: 1 },
            receipt: { token: 't', index: 0 }
          }
        throw new Error('page 2 lost')
      }
    })
    await refreshUsageData(db)
    expect(calls).toEqual([{}, { page: { token: 't', index: 1 }, ack: { token: 't', index: 0 } }])
    expect(ids(), "page 1's records are stored").toEqual(['pa-1', 'pb-1'])
  })
})
