/**
 * Migration v151 (`in-band-clear` origin) tests. Runs the FULL production
 * migration chain against a real better-sqlite3 handle, so this exercises the
 * actual upgrade path: v151 rebuilds `task_conversations` + `agent_sessions` to
 * widen their `origin` CHECK constraints (SQLite can't ALTER a CHECK in place).
 *
 * A table rebuild is the riskiest migration shape in this codebase — it DROPs
 * tables holding live provenance rows (thousands on a real store) and recreates
 * them. So the assertions cover the failure modes a rebuild introduces, not just
 * "the new value inserts":
 *   - every pre-existing row survives byte-identically, NULLs included
 *   - the columns v148 added (tab_id, ended_at) are still present, in order
 *   - every index is recreated (they die with the dropped table; four are on hot
 *     resolver paths)
 *   - the FK to tasks(id) still cascades (the rebuild runs with foreign_keys OFF)
 *   - re-running is a no-op and does not lose rows
 *
 * Runs under vitest on Electron's node (packages/shared/test-utils/
 * vitest.harness.config.ts): better-sqlite3's native ABI matches Electron's node
 * only.
 */
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { DB_PRAGMAS } from '@slayzone/platform'
import { LATEST_MIGRATION_VERSION, migrations, runMigrations } from '@slayzone/db-migrations'
import { ALL_ORIGINS, HONORED_ORIGINS } from '@slayzone/task-contracts'

/** Fresh in-memory DB with the full production migration chain applied. */
function migratedDb(): Database.Database {
  const raw = new Database(':memory:')
  for (const pragma of DB_PRAGMAS) raw.pragma(pragma)
  runMigrations(raw)
  return raw
}

/**
 * Re-apply v151's rebuild over rows that already exist — the data-copy path a
 * live store takes on upgrade. It's the only way to exercise the copy: seeding
 * BEFORE the first `runMigrations` is impossible, since the tables don't exist
 * until v147 creates them.
 *
 * Runs THAT migration's `up` directly rather than rewinding `user_version` and
 * calling `runMigrations`. The rewind approach re-runs every LATER migration too,
 * and those are not idempotent by design — a plain `ALTER TABLE … ADD COLUMN`
 * (v152's `zoom_pct`) throws "duplicate column name" on a second pass, and SQLite
 * has no `ADD COLUMN IF NOT EXISTS`. So the rewind form silently rotted the
 * moment any column migration landed after v151, failing on an unrelated table.
 * v151 itself IS idempotent (it rebuilds from whatever is present), which is what
 * makes the direct replay valid.
 */
function replayMigration(raw: Database.Database, version: number): void {
  const m = migrations.find((x) => x.version === version)
  if (!m) throw new Error(`migration ${version} not found`)
  raw.transaction(() => m.up(raw))()
}

function indexNames(raw: Database.Database, table: string): string[] {
  return (
    raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
      .all(table) as { name: string }[]
  )
    .map((r) => r.name)
    .filter((n) => !n.startsWith('sqlite_autoindex'))
}

function columnNames(raw: Database.Database, table: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)
}

function seedTask(raw: Database.Database, taskId: string): void {
  raw.prepare(`INSERT INTO projects (id, name, color) VALUES (?, ?, ?)`).run('p1', 'P', '#000')
  raw.prepare(`INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)`).run(taskId, 'p1', 'T')
}

function insConv(raw: Database.Database): Database.Statement {
  return raw.prepare(
    `INSERT INTO task_conversations (id, task_id, mode, conversation_id, origin, pending_meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
}
function insSession(raw: Database.Database): Database.Statement {
  return raw.prepare(
    `INSERT INTO agent_sessions
       (id, mode, cwd, task_id, conversation_id, origin, status, pending_meta,
        created_at, bound_at, tab_id, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
}

const sessionRow = (
  id: string,
  mode: string,
  taskId: string | null,
  conversationId: string | null,
  origin: string,
  createdAt: number
): unknown[] => [
  id,
  mode,
  null,
  taskId,
  conversationId,
  origin,
  'dead',
  null,
  createdAt,
  null,
  null,
  null
]

// 1. Registry tail includes v151.
test('LATEST_MIGRATION_VERSION should be >= 151', () => {
  expect(LATEST_MIGRATION_VERSION).toBeGreaterThanOrEqual(151)
})

// 2. Both rebuilt tables accept the new origin.
describe('both rebuilt tables accept the new origin', () => {
  let raw: Database.Database
  beforeAll(() => {
    raw = migratedDb()
    seedTask(raw, 't1')
  })
  afterAll(() => raw.close())

  test('task_conversations must accept in-band-clear', () => {
    expect(() =>
      insConv(raw).run('tc1', 't1', 'claude-code', 'conv-new', 'in-band-clear', null, 1000)
    ).not.toThrow()
  })

  test('agent_sessions must accept in-band-clear', () => {
    expect(() =>
      insSession(raw).run(
        ...sessionRow('as1', 'claude-code', 't1', 'conv-new', 'in-band-clear', 1000)
      )
    ).not.toThrow()
  })
})

// 3. The CHECK was WIDENED, not dropped — an unknown origin still fails.
describe('the CHECK was widened, not dropped', () => {
  let raw: Database.Database
  beforeAll(() => {
    raw = migratedDb()
    seedTask(raw, 't1')
  })
  afterAll(() => raw.close())

  test('task_conversations must still reject an unknown origin', () => {
    expect(() => insConv(raw).run('tc-bad', 't1', 'm', 'c', 'totally-made-up', null, 1)).toThrow(
      /CHECK constraint failed/
    )
  })

  test('agent_sessions must still reject an unknown origin', () => {
    expect(() =>
      insSession(raw).run(...sessionRow('as-bad', 'm', 't1', 'c', 'totally-made-up', 1))
    ).toThrow(/CHECK constraint failed/)
  })
})

// 4. TS enum ↔ SQL CHECK sync: every ConversationOrigin value inserts.
describe('TS enum ↔ SQL CHECK sync', () => {
  let raw: Database.Database
  beforeAll(() => {
    raw = migratedDb()
    seedTask(raw, 't1')
  })
  afterAll(() => raw.close())

  const origins = [...ALL_ORIGINS.entries()]
  test.each(origins)("origin #%i '%s' must satisfy the task_conversations CHECK", (i, origin) => {
    expect(() => insConv(raw).run(`tc-${i}`, 't1', 'm', `c-${i}`, origin, null, i)).not.toThrow()
  })

  // agent_sessions has no 'manual-reset' (a reset is a session_resets row).
  test.each(origins.filter(([, o]) => o !== 'manual-reset'))(
    "origin #%i '%s' must satisfy the agent_sessions CHECK",
    (i, origin) => {
      expect(() =>
        insSession(raw).run(...sessionRow(`as-${i}`, 'm', 't1', `c-${i}`, origin, i))
      ).not.toThrow()
    }
  )
})

// 5. The point of the migration: a cleared session becomes the current one.
test('in-band-clear must be an HONORED origin', () => {
  expect(HONORED_ORIGINS.has('in-band-clear')).toBe(true)
})

test('cleared session must be current', () => {
  const raw = migratedDb()
  seedTask(raw, 't1')
  const ins = insSession(raw)
  ins.run(...sessionRow('s-old', 'claude-code', 't1', 'conv-old', 'slay-spawned-fresh', 1000))
  ins.run(...sessionRow('s-clear', 'claude-code', 't1', 'conv-cleared', 'in-band-clear', 2000))
  const honored = [...HONORED_ORIGINS].map((o) => `'${o}'`).join(',')
  const row = raw
    .prepare(
      `SELECT conversation_id FROM agent_sessions
        WHERE task_id = 't1' AND mode = 'claude-code' AND origin IN (${honored})
        ORDER BY created_at DESC LIMIT 1`
    )
    .get() as { conversation_id: string }
  expect(row.conversation_id).toBe('conv-cleared')
  raw.close()
})

// 6. Column set + ORDER preserved (an explicit-column copy must not reorder).
describe('column set + order preserved', () => {
  let raw: Database.Database
  beforeAll(() => {
    raw = migratedDb()
  })
  afterAll(() => raw.close())

  test('agent_sessions columns', () => {
    expect(columnNames(raw, 'agent_sessions').join(',')).toBe(
      'id,mode,cwd,task_id,conversation_id,origin,status,pending_meta,created_at,bound_at,tab_id,ended_at'
    )
  })

  test('task_conversations columns', () => {
    expect(columnNames(raw, 'task_conversations').join(',')).toBe(
      'id,task_id,mode,conversation_id,origin,pending_meta,created_at'
    )
  })
})

// 7. Every index the dropped tables carried is recreated.
describe('every index the dropped tables carried is recreated', () => {
  let raw: Database.Database
  beforeAll(() => {
    raw = migratedDb()
  })
  afterAll(() => raw.close())

  test.each([
    'agent_sessions_task',
    'agent_sessions_pool',
    'agent_sessions_pending',
    'agent_sessions_tab'
  ])('agent_sessions has index %s after rebuild', (idx) => {
    expect(indexNames(raw, 'agent_sessions')).toContain(idx)
  })

  test.each(['task_conversations_lookup', 'task_conversations_pending'])(
    'task_conversations has index %s after rebuild',
    (idx) => {
      expect(indexNames(raw, 'task_conversations')).toContain(idx)
    }
  )
})

// 8. The tasks FK still cascades — the rebuild turns foreign_keys OFF, so a
//    lost FK clause (or a pragma left off) would orphan provenance rows.
describe('the tasks FK still cascades', () => {
  let raw: Database.Database
  beforeAll(() => {
    raw = migratedDb()
  })
  afterAll(() => raw.close())

  test('foreign_keys must be back ON', () => {
    expect(raw.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  test('task_conversations should cascade-delete', () => {
    seedTask(raw, 't1')
    insConv(raw).run('tc1', 't1', 'm', 'c', 'in-band-clear', null, 1)
    insSession(raw).run(...sessionRow('as1', 'm', 't1', 'c', 'in-band-clear', 1))
    raw.prepare(`DELETE FROM tasks WHERE id = 't1'`).run()
    const nConv = (
      raw.prepare(`SELECT count(*) AS n FROM task_conversations`).get() as { n: number }
    ).n
    expect(nConv).toBe(0)
  })

  test('agent_sessions should cascade-delete', () => {
    const nSess = (raw.prepare(`SELECT count(*) AS n FROM agent_sessions`).get() as { n: number }).n
    expect(nSess).toBe(0)
  })
})

// 9. THE data-integrity check: existing rows survive the rebuild byte-identically.
describe('existing rows survive the rebuild byte-identically', () => {
  let raw: Database.Database
  let before: { sessions: unknown[]; convs: unknown[] }
  let after: { sessions: unknown[]; convs: unknown[] }
  beforeAll(() => {
    raw = migratedDb()
    seedTask(raw, 't1')
    // Deliberately mixed: NULLs in every nullable column, a populated
    // pending_meta, both v148 columns set and unset, and a pooled row with a
    // NULL task_id (the warm-pool shape the FK must still permit).
    insSession(raw).run(
      's-full',
      'claude-code',
      '/w',
      't1',
      'c1',
      'slay-spawned-resume',
      'dead',
      '{"usedResume":true,"spawnedAt":5}',
      100,
      110,
      'tab-1',
      120
    )
    insSession(raw).run(
      's-pooled',
      'claude-code',
      null,
      null,
      null,
      'pending-spawn',
      'pooled',
      null,
      200,
      null,
      null,
      null
    )
    insConv(raw).run('tc-full', 't1', 'claude-code', 'c1', 'foreign-observed', '{"a":1}', 300)
    insConv(raw).run('tc-null', 't1', 'claude-code', null, 'manual-reset', null, 400)

    before = {
      sessions: raw.prepare(`SELECT * FROM agent_sessions ORDER BY id`).all(),
      convs: raw.prepare(`SELECT * FROM task_conversations ORDER BY id`).all()
    }

    replayMigration(raw, 151)

    after = {
      sessions: raw.prepare(`SELECT * FROM agent_sessions ORDER BY id`).all(),
      convs: raw.prepare(`SELECT * FROM task_conversations ORDER BY id`).all()
    }
  })
  afterAll(() => raw.close())

  // Real deep equality — NULLs must stay NULL (toStrictEqual distinguishes
  // null from a dropped column, which a JSON compare would also catch).
  test('agent_sessions rows unchanged across the rebuild', () => {
    expect(before.sessions).toHaveLength(2)
    expect(after.sessions).toStrictEqual(before.sessions)
  })

  test('task_conversations rows unchanged across the rebuild', () => {
    expect(before.convs).toHaveLength(2)
    expect(after.convs).toStrictEqual(before.convs)
  })

  // Indexes must come back on the SECOND rebuild too, not only the first.
  test('agent_sessions_tab must survive a replayed rebuild', () => {
    expect(indexNames(raw, 'agent_sessions')).toContain('agent_sessions_tab')
  })

  test('task_conversations_lookup must survive a replayed rebuild', () => {
    expect(indexNames(raw, 'task_conversations')).toContain('task_conversations_lookup')
  })
})

// 10. Re-running the whole chain on an up-to-date DB is a no-op.
describe('re-running the whole chain on an up-to-date DB is a no-op', () => {
  let raw: Database.Database
  beforeAll(() => {
    raw = migratedDb()
    seedTask(raw, 't1')
    insSession(raw).run(...sessionRow('keep', 'm', 't1', 'c', 'slay-spawned-fresh', 7))
  })
  afterAll(() => raw.close())

  test('re-running migrations must not throw', () => {
    expect(() => runMigrations(raw)).not.toThrow()
  })

  test('user_version must equal LATEST_MIGRATION_VERSION', () => {
    expect(raw.pragma('user_version', { simple: true })).toBe(LATEST_MIGRATION_VERSION)
  })

  test('a no-op re-run must not drop rows', () => {
    const n = (
      raw.prepare(`SELECT count(*) AS n FROM agent_sessions WHERE id = 'keep'`).get() as {
        n: number
      }
    ).n
    expect(n).toBe(1)
  })
})
