/**
 * v148 agent-session runtime-entity migration tests.
 * Adds `tab_id` + `ended_at` to `agent_sessions` and exercises the entity-model
 * B write lifecycle (recordSessionSpawn → confirm → bind) on the REAL migrated
 * schema. See plans/agent-sessions.md.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/domains/task/src/server/v148-agent-sessions-runtime-migration.test.ts
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import { migrations } from '@slayzone/db-migrations'
import {
  recordSessionSpawn,
  confirmSessionConversation,
  bindSessionToTask,
  markSessionFirstTurn,
  getCurrentConversationId
} from './index'

/** Build a DB migrated through v148 (all real migrations). */
function dbUpTo(maxVersion: number): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  for (const m of migrations) {
    if (m.version > maxVersion) break
    db.transaction(() => {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
    })()
  }
  return db
}

/** The v148 schema exactly — for asserting what THAT migration produced. */
const dbAt148 = (): Database.Database => dbUpTo(148)

/**
 * Fully migrated. The runtime readers exercised below depend on tables added
 * after v148 (`session_deletions` v157, `session_turns` v158), so pinning them to
 * the v148 schema stopped testing "the real migrated schema" and started testing
 * a shape that no longer exists anywhere.
 */
const dbAtLatest = (): Database.Database => dbUpTo(Number.MAX_SAFE_INTEGER)

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

describe('v148 agent-session runtime-entity migration', () => {
  test('adds tab_id + ended_at columns to agent_sessions', () => {
    const db = dbAt148()
    try {
      const cols = (
        db.prepare(`PRAGMA table_info(agent_sessions)`).all() as Array<{ name: string }>
      ).map((c) => c.name)
      expect(cols).toContain('tab_id')
      expect(cols).toContain('ended_at')
    } finally {
      db.close()
    }
  })

  test('B lifecycle round-trips on the real migrated schema', async () => {
    const raw = dbAtLatest()
    try {
      raw
        .prepare("INSERT INTO projects (id, name, color, path) VALUES ('p1','P','#000','/tmp/p')")
        .run()
      raw
        .prepare(
          `INSERT INTO tasks (id, project_id, title, status, priority) VALUES ('t1','p1','T','todo',3)`
        )
        .run()
      const db = adapter(raw)

      await recordSessionSpawn(db, {
        id: 'RT1',
        taskId: 't1',
        tabId: 't1',
        mode: 'claude-code',
        cwd: '/tmp/p',
        expectedConversationId: 'RT1',
        usedResume: false,
        status: 'bound'
      })
      expect(await getCurrentConversationId(db, 't1', 'claude-code')).toBe(null) // pending
      const origin = await confirmSessionConversation(db, {
        sessionId: 'RT1',
        observedConversationId: 'RT1'
      })
      expect(origin).toBe('slay-spawned-fresh')
      // Confirm proves the process started, not that it wrote anything: claude
      // creates its transcript at the first turn, so a turnless fresh spawn is
      // not yet a resume target (v158).
      expect(await getCurrentConversationId(db, 't1', 'claude-code')).toBe(null)
      await markSessionFirstTurn(db, 'RT1')
      expect(await getCurrentConversationId(db, 't1', 'claude-code')).toBe('RT1')
    } finally {
      raw.close()
    }
  })

  test('pooled session (no task) binds to a task and becomes honored', async () => {
    const raw = dbAtLatest()
    try {
      raw
        .prepare("INSERT INTO projects (id, name, color, path) VALUES ('p1','P','#000','/tmp/p')")
        .run()
      raw
        .prepare(
          `INSERT INTO tasks (id, project_id, title, status, priority) VALUES ('t9','p1','T','todo',3)`
        )
        .run()
      const db = adapter(raw)

      await recordSessionSpawn(db, {
        id: 'POOLX',
        taskId: null,
        tabId: null,
        mode: 'claude-code',
        cwd: '/tmp/p',
        expectedConversationId: 'POOLX',
        usedResume: false,
        status: 'pooled'
      })
      await confirmSessionConversation(db, { sessionId: 'POOLX', observedConversationId: 'POOLX' })
      expect(await getCurrentConversationId(db, 't9', 'claude-code')).toBe(null) // unbound
      const bound = await bindSessionToTask(db, { sessionId: 'POOLX', taskId: 't9', tabId: 't9' })
      expect(bound).toBe(true)
      // Adoption transfers ownership, not resumability — a warm agent that never
      // took a turn has no transcript to resume (v158).
      expect(await getCurrentConversationId(db, 't9', 'claude-code')).toBe(null)
      await markSessionFirstTurn(db, 'POOLX')
      expect(await getCurrentConversationId(db, 't9', 'claude-code')).toBe('POOLX')
    } finally {
      raw.close()
    }
  })
})
