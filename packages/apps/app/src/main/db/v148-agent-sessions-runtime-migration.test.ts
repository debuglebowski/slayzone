/**
 * v148 agent-session runtime-entity migration tests.
 * Adds `tab_id` + `ended_at` to `agent_sessions` and exercises the entity-model
 * B write lifecycle (recordSessionSpawn → confirm → bind) on the REAL migrated
 * schema. See plans/agent-sessions.md.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm packages/apps/app/src/main/db/v148-agent-sessions-runtime-migration.test.ts
 */
import Database from 'better-sqlite3'
import type { SlayzoneDb } from '@slayzone/platform'
import { migrations } from '@slayzone/transport/db-bootstrap'
import {
  recordSessionSpawn,
  confirmSessionConversation,
  bindSessionToTask,
  getCurrentConversationId
} from '@slayzone/task/server'

let passed = 0
let failed = 0

function test(name: string, fn: () => Promise<void> | void): Promise<void> | void {
  const done = (): void => {
    console.log(`  ✓ ${name}`)
    passed++
  }
  const fail = (error: unknown): void => {
    console.log(`  ✗ ${name}`)
    console.error(`    ${error instanceof Error ? error.message : String(error)}`)
    failed++
  }
  try {
    const r = fn()
    if (r instanceof Promise) return r.then(done).catch(fail)
    done()
  } catch (error) {
    fail(error)
  }
}

function expectEqual(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Expected ${e}, got ${a}`)
}

/** Build a DB migrated through v148 (all real migrations). */
function dbAt148(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  for (const m of migrations) {
    if (m.version > 148) break
    db.transaction(() => {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
    })()
  }
  return db
}

function adapter(raw: Database.Database): SlayzoneDb {
  return {
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
}

async function run(): Promise<void> {
  console.log('\nv148 agent-session runtime-entity migration')

  await test('adds tab_id + ended_at columns to agent_sessions', () => {
    const db = dbAt148()
    try {
      const cols = (db.prepare(`PRAGMA table_info(agent_sessions)`).all() as Array<{ name: string }>).map(
        (c) => c.name
      )
      if (!cols.includes('tab_id')) throw new Error('tab_id column missing')
      if (!cols.includes('ended_at')) throw new Error('ended_at column missing')
    } finally {
      db.close()
    }
  })

  await test('B lifecycle round-trips on the real migrated schema', async () => {
    const raw = dbAt148()
    try {
      raw.prepare("INSERT INTO projects (id, name, color, path) VALUES ('p1','P','#000','/tmp/p')").run()
      raw
        .prepare(`INSERT INTO tasks (id, project_id, title, status, priority) VALUES ('t1','p1','T','todo',3)`)
        .run()
      const db = adapter(raw)

      await recordSessionSpawn(db, {
        id: 'RT1', taskId: 't1', tabId: 't1', mode: 'claude-code', cwd: '/tmp/p',
        expectedConversationId: 'RT1', usedResume: false, status: 'bound'
      })
      expectEqual(await getCurrentConversationId(db, 't1', 'claude-code'), null) // pending
      const origin = await confirmSessionConversation(db, { sessionId: 'RT1', observedConversationId: 'RT1' })
      expectEqual(origin, 'slay-spawned-fresh')
      expectEqual(await getCurrentConversationId(db, 't1', 'claude-code'), 'RT1')
    } finally {
      raw.close()
    }
  })

  await test('pooled session (no task) binds to a task and becomes honored', async () => {
    const raw = dbAt148()
    try {
      raw.prepare("INSERT INTO projects (id, name, color, path) VALUES ('p1','P','#000','/tmp/p')").run()
      raw
        .prepare(`INSERT INTO tasks (id, project_id, title, status, priority) VALUES ('t9','p1','T','todo',3)`)
        .run()
      const db = adapter(raw)

      await recordSessionSpawn(db, {
        id: 'POOLX', taskId: null, tabId: null, mode: 'claude-code', cwd: '/tmp/p',
        expectedConversationId: 'POOLX', usedResume: false, status: 'pooled'
      })
      await confirmSessionConversation(db, { sessionId: 'POOLX', observedConversationId: 'POOLX' })
      expectEqual(await getCurrentConversationId(db, 't9', 'claude-code'), null) // unbound
      const bound = await bindSessionToTask(db, { sessionId: 'POOLX', taskId: 't9', tabId: 't9' })
      expectEqual(bound, true)
      expectEqual(await getCurrentConversationId(db, 't9', 'claude-code'), 'POOLX')
    } finally {
      raw.close()
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run()
