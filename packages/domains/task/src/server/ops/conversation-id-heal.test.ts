import Database from 'better-sqlite3'
import type { SlayzoneDb } from '@slayzone/platform'
import { casRepointConversationId, collectReferencedConversationIds } from './conversation-id-heal.js'

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

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
  cfg({ 'claude-code': { conversationId: 'phantom', flags: '--x', conversationHistory: ['old1'] } }),
  'phantom',
  null
)
ins.run('t2', cfg({ 'claude-code': { conversationId: 'neighbor' } }), 'neighbor', null)

async function main(): Promise<void> {
  // CAS success: repoints when stored id still equals `expected`.
  const ok = await casRepointConversationId(db, {
    id: 't1',
    mode: 'claude-code',
    expected: 'phantom',
    next: 'real'
  })
  assert(ok === true, 'cas repoints when expected matches')
  const row1 = raw.prepare('SELECT provider_config, claude_conversation_id FROM tasks WHERE id=?').get('t1') as {
    provider_config: string
    claude_conversation_id: string
  }
  const pc = JSON.parse(row1.provider_config)
  assert(pc['claude-code'].conversationId === 'real', 'conversationId updated')
  assert(pc['claude-code'].flags === '--x', 'flags preserved')
  assert(JSON.stringify(pc['claude-code'].conversationHistory) === JSON.stringify(['old1']), 'history preserved')
  assert(row1.claude_conversation_id === 'real', 'legacy column dual-written')

  // CAS stale: expected no longer matches → no-op (cannot clobber a concurrent write).
  const ok2 = await casRepointConversationId(db, {
    id: 't1',
    mode: 'claude-code',
    expected: 'phantom',
    next: 'should-not-apply'
  })
  assert(ok2 === false, 'cas is a no-op when expected no longer matches')
  const row1b = raw.prepare('SELECT claude_conversation_id FROM tasks WHERE id=?').get('t1') as {
    claude_conversation_id: string
  }
  assert(row1b.claude_conversation_id === 'real', 'stale cas left the value unchanged')

  // CAS never touches a different task.
  const row2 = raw.prepare('SELECT claude_conversation_id FROM tasks WHERE id=?').get('t2') as {
    claude_conversation_id: string
  }
  assert(row2.claude_conversation_id === 'neighbor', 'other task untouched')

  // collectReferencedConversationIds: conversationId + history + legacy columns.
  const refs = await collectReferencedConversationIds(db)
  assert(refs.has('real'), 'includes current conversationId')
  assert(refs.has('old1'), 'includes a history entry')
  assert(refs.has('neighbor'), 'includes another task id')

  // A soft-deleted row STILL holds its ids → they stay referenced (must not become
  // a free orphan that the heal could mis-attach).
  ins.run('t3', cfg({ 'claude-code': { conversationId: 'ghost' } }), 'ghost', '2026-01-01 00:00:00')
  const refs2 = await collectReferencedConversationIds(db)
  assert(refs2.has('ghost'), 'soft-deleted task ids stay referenced')

  console.log('conversation-id-heal-ops: all passed')
  raw.close()
}

void main()
