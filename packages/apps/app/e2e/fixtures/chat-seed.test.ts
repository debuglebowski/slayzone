/**
 * Seeding `chat_events` for the chat e2e specs, at any size.
 *
 * The seeder batched by ROW COUNT (100 rows per INSERT, 10,000 per round trip), so
 * a round trip's size was whatever 10,000 events weighed: the 10,000-event long
 * session is 4.5 MB, but 10,000 events of 64 KiB are a 640 MB SQL string — past
 * what one V8 string, one `electronApp.evaluate` argument and one HTTP body to the
 * hub can carry. It batches by SIZE now: an INSERT and a round trip each hold at
 * most a fixed number of characters, a single bigger row alone.
 *
 * Run with (vitest, node harness group):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/app/e2e/fixtures/chat-seed.test.ts
 */
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { chatEventsSeedSql, SEED_LIMITS } from './chat-seed.js'

function seededRows(requests: string[]): Array<{ seq: number; event: string }> {
  const db = new Database(':memory:')
  db.exec(
    'CREATE TABLE chat_events (tab_id TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (tab_id, seq))'
  )
  for (const sql of requests) db.exec(sql)
  return db
    .prepare("SELECT seq, event FROM chat_events WHERE tab_id = 'tab' ORDER BY seq")
    .all() as Array<{
    seq: number
    event: string
  }>
}

const statementsOf = (request: string): string[] =>
  request.split('\n').filter((line) => line.startsWith('INSERT'))

test('no events, no round trips', () => {
  expect(chatEventsSeedSql('tab', [])).toEqual([])
})

test('every event lands once, at seq = its index, quotes intact', () => {
  const events = Array.from({ length: 2_500 }, (_, i) => ({
    kind: 'assistant-text',
    text: `it's #${i}`
  }))
  const rows = seededRows(chatEventsSeedSql('tab', events))
  expect(rows.length).toBe(events.length)
  rows.forEach((r, i) => {
    expect(r.seq).toBe(i)
    expect(JSON.parse(r.event)).toEqual(events[i])
  })
})

test('10,000 events of 64 KiB: every round trip and INSERT stays within its size budget', () => {
  const text = 'x'.repeat(64 * 1024)
  const events = Array.from({ length: 10_000 }, (_, i) => ({ kind: 'tool-result', i, text }))
  const requests = chatEventsSeedSql('tab', events)
  // ~640 MB in all: far more than one round trip may carry.
  expect(requests.length).toBeGreaterThan(1)
  for (const request of requests) {
    expect(request.length).toBeLessThanOrEqual(SEED_LIMITS.maxRequestChars)
    for (const statement of statementsOf(request)) {
      expect(statement.length).toBeLessThanOrEqual(SEED_LIMITS.maxStatementChars)
    }
  }
  const seqs = seededRows(requests).map((r) => r.seq)
  expect(seqs.length).toBe(events.length)
  expect(seqs[seqs.length - 1]).toBe(events.length - 1)
}, 120_000)

test('a row bigger than both budgets goes alone, in its own round trip', () => {
  const huge = { kind: 'tool-result', text: 'y'.repeat(SEED_LIMITS.maxRequestChars + 1) }
  const events = [{ kind: 'a' }, huge, { kind: 'b' }]
  const requests = chatEventsSeedSql('tab', events)
  expect(requests.length).toBe(3)
  expect(statementsOf(requests[1]).length).toBe(1)
  const rows = seededRows(requests)
  expect(rows.map((r) => JSON.parse(r.event).kind)).toEqual(['a', 'tool-result', 'b'])
})

test('round trips are packed: each wastes less than one INSERT of its budget', () => {
  const events = Array.from({ length: 30_000 }, (_, i) => ({
    kind: 'assistant-text',
    text: `${i} `.repeat(100)
  }))
  const requests = chatEventsSeedSql('tab', events)
  const total = requests.reduce((n, r) => n + r.length, 0)
  expect(requests.length).toBeGreaterThan(1)
  expect(requests.length).toBeLessThanOrEqual(
    Math.ceil(total / (SEED_LIMITS.maxRequestChars - SEED_LIMITS.maxStatementChars))
  )
})
