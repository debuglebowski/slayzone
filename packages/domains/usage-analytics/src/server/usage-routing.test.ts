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
        return [
          {
            sourceFile: file,
            fileMtimeMs: computerId === 'c1' ? 10 : 20,
            endOffset: computerId === 'c1' ? 100 : 200,
            records: [rec(`${computerId}-r1`)]
          }
        ]
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
