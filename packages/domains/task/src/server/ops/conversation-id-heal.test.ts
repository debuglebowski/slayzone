import { afterAll, describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  casRepointConversationId,
  collectReferencedConversationIds
} from './conversation-id-heal.js'

// Minimal real-SQLite harness — only the columns these ops touch (no migrations).
const raw = new Database(':memory:')
raw.exec(`CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  provider_config TEXT,
  claude_conversation_id TEXT,
  codex_conversation_id TEXT,
  cursor_conversation_id TEXT,
  gemini_conversation_id TEXT,
  opencode_conversation_id TEXT,
  deleted_at TEXT
)`)
const db: SlayzoneDb = {
  async get<T = unknown>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return raw.prepare(sql).get(...params) as T | undefined
  },
  async all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return raw.prepare(sql).all(...params) as T[]
  },
  async run(sql: string, params: unknown[] = []) {
    const r = raw.prepare(sql).run(...params)
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
  }
} as unknown as SlayzoneDb

const cfg = (o: unknown): string => JSON.stringify(o)
const ins = raw.prepare(
  'INSERT INTO tasks (id, provider_config, claude_conversation_id, deleted_at) VALUES (?,?,?,?)'
)
ins.run(
  't1',
  cfg({
    'claude-code': { conversationId: 'phantom', flags: '--x', conversationHistory: ['old1'] }
  }),
  'phantom',
  null
)
ins.run('t2', cfg({ 'claude-code': { conversationId: 'neighbor' } }), 'neighbor', null)

afterAll(() => {
  raw.close()
})

// Steps share one in-memory DB and run in declaration order.
describe('conversation-id-heal ops', () => {
  // CAS success: repoints when stored id still equals `expected`.
  test('cas repoints when expected matches', async () => {
    const ok = await casRepointConversationId(db, {
      id: 't1',
      mode: 'claude-code',
      expected: 'phantom',
      next: 'real'
    })
    expect(ok).toBe(true)
  })

  const readT1 = () => {
    const row1 = raw
      .prepare('SELECT provider_config, claude_conversation_id FROM tasks WHERE id=?')
      .get('t1') as {
      provider_config: string
      claude_conversation_id: string
    }
    return { row1, pc: JSON.parse(row1.provider_config) }
  }

  test('conversationId updated', () => {
    expect(readT1().pc['claude-code'].conversationId).toBe('real')
  })

  test('flags preserved', () => {
    expect(readT1().pc['claude-code'].flags).toBe('--x')
  })

  test('history preserved', () => {
    expect(readT1().pc['claude-code'].conversationHistory).toEqual(['old1'])
  })

  test('legacy column dual-written', () => {
    expect(readT1().row1.claude_conversation_id).toBe('real')
  })

  // CAS stale: expected no longer matches → no-op (cannot clobber a concurrent write).
  test('cas is a no-op when expected no longer matches', async () => {
    const ok2 = await casRepointConversationId(db, {
      id: 't1',
      mode: 'claude-code',
      expected: 'phantom',
      next: 'should-not-apply'
    })
    expect(ok2).toBe(false)
  })

  test('stale cas left the value unchanged', () => {
    const row1b = raw.prepare('SELECT claude_conversation_id FROM tasks WHERE id=?').get('t1') as {
      claude_conversation_id: string
    }
    expect(row1b.claude_conversation_id).toBe('real')
  })

  // CAS never touches a different task.
  test('other task untouched', () => {
    const row2 = raw.prepare('SELECT claude_conversation_id FROM tasks WHERE id=?').get('t2') as {
      claude_conversation_id: string
    }
    expect(row2.claude_conversation_id).toBe('neighbor')
  })

  // collectReferencedConversationIds: conversationId + history + legacy columns.
  test('includes current conversationId', async () => {
    expect((await collectReferencedConversationIds(db)).has('real')).toBe(true)
  })

  test('includes a history entry', async () => {
    expect((await collectReferencedConversationIds(db)).has('old1')).toBe(true)
  })

  test('includes another task id', async () => {
    expect((await collectReferencedConversationIds(db)).has('neighbor')).toBe(true)
  })

  // A soft-deleted row STILL holds its ids → they stay referenced (must not become
  // a free orphan that the heal could mis-attach).
  test('soft-deleted task ids stay referenced', async () => {
    ins.run(
      't3',
      cfg({ 'claude-code': { conversationId: 'ghost' } }),
      'ghost',
      '2026-01-01 00:00:00'
    )
    expect((await collectReferencedConversationIds(db)).has('ghost')).toBe(true)
  })
})
