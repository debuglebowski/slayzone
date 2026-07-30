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
 * Plain asserts + the electron strict loader (NOT vitest): better-sqlite3's
 * native ABI matches Electron's node only, and `run-all.sh` has no
 * electron+vitest runner — a vitest-style DB test cannot be registered there, so
 * it would silently never run in CI.
 */
import Database from 'better-sqlite3'
import { DB_PRAGMAS } from '@slayzone/platform'
import { LATEST_MIGRATION_VERSION, runMigrations } from '@slayzone/transport/db-bootstrap'
import { ALL_ORIGINS, HONORED_ORIGINS } from '@slayzone/task/shared'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    failures++
  }
}
function assertThrows(fn: () => void, msg: string): void {
  try {
    fn()
    console.error('FAIL:', msg, '— expected a throw, got none')
    failures++
  } catch {
    /* expected */
  }
}
function assertNoThrow(fn: () => void, msg: string): void {
  try {
    fn()
  } catch (e) {
    console.error('FAIL:', msg, '—', (e as Error).message)
    failures++
  }
}

/** Fresh in-memory DB with the full production migration chain applied. */
function migratedDb(): Database.Database {
  const raw = new Database(':memory:')
  for (const pragma of DB_PRAGMAS) raw.pragma(pragma)
  runMigrations(raw)
  return raw
}

/**
 * Re-apply v151's rebuild over rows that already exist — the data-copy path a
 * live store takes on upgrade.
 *
 * `runMigrations` applies every migration whose version exceeds `user_version`,
 * so rewinding the pragma to 150 re-runs v151 alone against a populated table.
 * That is the same DROP-and-copy the real upgrade performs (v151 is idempotent by
 * construction — it rebuilds from whatever is present), and it's the only way to
 * exercise the copy: seeding BEFORE the first `runMigrations` is impossible since
 * the tables don't exist until v147 creates them.
 */
function replayV151(raw: Database.Database): void {
  raw.pragma('user_version = 150')
  runMigrations(raw)
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

function main(): void {
  // 1. Registry tail includes v151.
  assert(LATEST_MIGRATION_VERSION >= 151, `LATEST_MIGRATION_VERSION should be >= 151`)

  // 2. Both rebuilt tables accept the new origin.
  {
    const raw = migratedDb()
    seedTask(raw, 't1')
    assertNoThrow(
      () => insConv(raw).run('tc1', 't1', 'claude-code', 'conv-new', 'in-band-clear', null, 1000),
      'task_conversations must accept in-band-clear'
    )
    assertNoThrow(
      () =>
        insSession(raw).run(
          'as1', 'claude-code', null, 't1', 'conv-new', 'in-band-clear', 'dead', null, 1000,
          null, null, null
        ),
      'agent_sessions must accept in-band-clear'
    )
    raw.close()
  }

  // 3. The CHECK was WIDENED, not dropped — an unknown origin still fails.
  {
    const raw = migratedDb()
    seedTask(raw, 't1')
    assertThrows(
      () => insConv(raw).run('tc-bad', 't1', 'm', 'c', 'totally-made-up', null, 1),
      'task_conversations must still reject an unknown origin'
    )
    assertThrows(
      () =>
        insSession(raw).run(
          'as-bad', 'm', null, 't1', 'c', 'totally-made-up', 'dead', null, 1, null, null, null
        ),
      'agent_sessions must still reject an unknown origin'
    )
    raw.close()
  }

  // 4. TS enum ↔ SQL CHECK sync: every ConversationOrigin value inserts.
  {
    const raw = migratedDb()
    seedTask(raw, 't1')
    for (const [i, origin] of ALL_ORIGINS.entries()) {
      assertNoThrow(
        () => insConv(raw).run(`tc-${i}`, 't1', 'm', `c-${i}`, origin, null, i),
        `origin '${origin}' must satisfy the task_conversations CHECK`
      )
      // agent_sessions has no 'manual-reset' (a reset is a session_resets row).
      if (origin === 'manual-reset') continue
      assertNoThrow(
        () =>
          insSession(raw).run(
            `as-${i}`, 'm', null, 't1', `c-${i}`, origin, 'dead', null, i, null, null, null
          ),
        `origin '${origin}' must satisfy the agent_sessions CHECK`
      )
    }
    raw.close()
  }

  // 5. The point of the migration: a cleared session becomes the current one.
  {
    assert(HONORED_ORIGINS.has('in-band-clear'), 'in-band-clear must be an HONORED origin')
    const raw = migratedDb()
    seedTask(raw, 't1')
    const ins = insSession(raw)
    ins.run('s-old', 'claude-code', null, 't1', 'conv-old', 'slay-spawned-fresh', 'dead', null,
            1000, null, null, null)
    ins.run('s-clear', 'claude-code', null, 't1', 'conv-cleared', 'in-band-clear', 'dead', null,
            2000, null, null, null)
    const honored = [...HONORED_ORIGINS].map((o) => `'${o}'`).join(',')
    const row = raw
      .prepare(
        `SELECT conversation_id FROM agent_sessions
          WHERE task_id = 't1' AND mode = 'claude-code' AND origin IN (${honored})
          ORDER BY created_at DESC LIMIT 1`
      )
      .get() as { conversation_id: string }
    assert(
      row.conversation_id === 'conv-cleared',
      `cleared session must be current, got ${row.conversation_id}`
    )
    raw.close()
  }

  // 6. Column set + ORDER preserved (an explicit-column copy must not reorder).
  {
    const raw = migratedDb()
    const sessionCols = columnNames(raw, 'agent_sessions').join(',')
    assert(
      sessionCols ===
        'id,mode,cwd,task_id,conversation_id,origin,status,pending_meta,created_at,bound_at,tab_id,ended_at',
      `agent_sessions columns drifted: ${sessionCols}`
    )
    const convCols = columnNames(raw, 'task_conversations').join(',')
    assert(
      convCols === 'id,task_id,mode,conversation_id,origin,pending_meta,created_at',
      `task_conversations columns drifted: ${convCols}`
    )
    raw.close()
  }

  // 7. Every index the dropped tables carried is recreated.
  {
    const raw = migratedDb()
    const s = indexNames(raw, 'agent_sessions')
    for (const idx of [
      'agent_sessions_task',
      'agent_sessions_pool',
      'agent_sessions_pending',
      'agent_sessions_tab'
    ]) {
      assert(s.includes(idx), `missing index ${idx} after rebuild (have: ${s.join(',')})`)
    }
    const c = indexNames(raw, 'task_conversations')
    for (const idx of ['task_conversations_lookup', 'task_conversations_pending']) {
      assert(c.includes(idx), `missing index ${idx} after rebuild (have: ${c.join(',')})`)
    }
    raw.close()
  }

  // 8. The tasks FK still cascades — the rebuild turns foreign_keys OFF, so a
  //    lost FK clause (or a pragma left off) would orphan provenance rows.
  {
    const raw = migratedDb()
    assert(raw.pragma('foreign_keys', { simple: true }) === 1, 'foreign_keys must be back ON')
    seedTask(raw, 't1')
    insConv(raw).run('tc1', 't1', 'm', 'c', 'in-band-clear', null, 1)
    insSession(raw).run('as1', 'm', null, 't1', 'c', 'in-band-clear', 'dead', null, 1, null, null, null)
    raw.prepare(`DELETE FROM tasks WHERE id = 't1'`).run()
    const nConv = (raw.prepare(`SELECT count(*) AS n FROM task_conversations`).get() as { n: number }).n
    const nSess = (raw.prepare(`SELECT count(*) AS n FROM agent_sessions`).get() as { n: number }).n
    assert(nConv === 0, `task_conversations should cascade-delete, ${nConv} left`)
    assert(nSess === 0, `agent_sessions should cascade-delete, ${nSess} left`)
    raw.close()
  }

  // 9. THE data-integrity check: existing rows survive the rebuild byte-identically.
  {
    const raw = migratedDb()
    seedTask(raw, 't1')
    // Deliberately mixed: NULLs in every nullable column, a populated
    // pending_meta, both v148 columns set and unset, and a pooled row with a
    // NULL task_id (the warm-pool shape the FK must still permit).
    insSession(raw).run(
      's-full', 'claude-code', '/w', 't1', 'c1', 'slay-spawned-resume', 'dead',
      '{"usedResume":true,"spawnedAt":5}', 100, 110, 'tab-1', 120
    )
    insSession(raw).run(
      's-pooled', 'claude-code', null, null, null, 'pending-spawn', 'pooled', null, 200,
      null, null, null
    )
    insConv(raw).run('tc-full', 't1', 'claude-code', 'c1', 'foreign-observed', '{"a":1}', 300)
    insConv(raw).run('tc-null', 't1', 'claude-code', null, 'manual-reset', null, 400)

    const before = {
      sessions: raw.prepare(`SELECT * FROM agent_sessions ORDER BY id`).all(),
      convs: raw.prepare(`SELECT * FROM task_conversations ORDER BY id`).all()
    }

    replayV151(raw)

    const after = {
      sessions: raw.prepare(`SELECT * FROM agent_sessions ORDER BY id`).all(),
      convs: raw.prepare(`SELECT * FROM task_conversations ORDER BY id`).all()
    }
    assert(
      JSON.stringify(after.sessions) === JSON.stringify(before.sessions),
      `agent_sessions rows changed across the rebuild:\n  before ${JSON.stringify(before.sessions)}\n  after  ${JSON.stringify(after.sessions)}`
    )
    assert(
      JSON.stringify(after.convs) === JSON.stringify(before.convs),
      `task_conversations rows changed across the rebuild:\n  before ${JSON.stringify(before.convs)}\n  after  ${JSON.stringify(after.convs)}`
    )
    // Indexes must come back on the SECOND rebuild too, not only the first.
    assert(
      indexNames(raw, 'agent_sessions').includes('agent_sessions_tab'),
      'agent_sessions_tab must survive a replayed rebuild'
    )
    assert(
      indexNames(raw, 'task_conversations').includes('task_conversations_lookup'),
      'task_conversations_lookup must survive a replayed rebuild'
    )
    raw.close()
  }

  // 10. Re-running the whole chain on an up-to-date DB is a no-op.
  {
    const raw = migratedDb()
    seedTask(raw, 't1')
    insSession(raw).run(
      'keep', 'm', null, 't1', 'c', 'slay-spawned-fresh', 'dead', null, 7, null, null, null
    )
    assertNoThrow(() => runMigrations(raw), 're-running migrations must not throw')
    assert(
      raw.pragma('user_version', { simple: true }) === LATEST_MIGRATION_VERSION,
      'user_version must equal LATEST_MIGRATION_VERSION'
    )
    const n = (
      raw.prepare(`SELECT count(*) AS n FROM agent_sessions WHERE id = 'keep'`).get() as {
        n: number
      }
    ).n
    assert(n === 1, 'a no-op re-run must not drop rows')
    raw.close()
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('OK — v151 in-band-clear migration checks passed')
}

main()
