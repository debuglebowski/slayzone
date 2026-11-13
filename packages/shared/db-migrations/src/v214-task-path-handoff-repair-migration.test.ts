/**
 * v214: repairs two upgrade defects of v210/v211 (task paths to the computer), found by
 * the migration persona suite (tools/migration-personas, p10-v0380-worktrees):
 *
 * 1. A path cleared to `''` before the upgrade was staged by v210 as `''`. The computer
 *    accepts only absolute paths, so the row faulted and never drained. `''` is unset.
 * 2. A subtask inherits its parent's worktree / base dir (the folder itself), not the
 *    parent's pin. v211 recorded its holder as its own pin, else its project's default
 *    computer — not where the folder is. A subtask whose staged paths equal its parent's
 *    now takes the parent's holder.
 *
 * v210 and v211 are fixed in place since; this repairs a database that ran them before.
 * The tests seed what the old v210/v211 left: hub flags, holders, staged rows.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v214-task-path-handoff-repair-migration.test.ts
 */
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { migrations } from './index'

function runRange(db: Database.Database, from: number, to: number): void {
  for (const m of migrations)
    if (m.version > from && m.version <= to)
      db.transaction(() => {
        m.up(db)
        db.pragma(`user_version = ${m.version}`)
      })()
}

const LATEST = () => migrations[migrations.length - 1].version

/** A hub at v213 as the OLD v210/v211 left it, then v214. */
function repaired(seed: string): Database.Database {
  const db = new Database(':memory:')
  runRange(db, 0, 213)
  db.exec(`
    INSERT INTO computers (id, name, platform, version, capabilities_json, created_at) VALUES
      ('local', 'local-computer', 'linux', '1', '[]', 0), ('bb', 'build-box', 'linux', '1', '[]', 0);
    INSERT INTO projects (id, name, color, default_computer_id) VALUES
      ('web', 'Web', '#000', 'local'), ('infra', 'Infra', '#000', 'bb');
    ${seed}
  `)
  runRange(db, 213, LATEST())
  return db
}

/** A task as the old v211 left it (flags + holder) with its staged row (as v210 did). */
const task = (
  id: string,
  o: {
    project?: string
    parent?: string
    pin?: string
    holder?: string
    wt: string | null
    bd: string | null
  }
) => `
  INSERT INTO tasks (id, project_id, title, parent_id, computer_id, worktree_computer_id, has_worktree, has_base_dir)
    VALUES ('${id}', '${o.project ?? 'web'}', '${id}', ${o.parent ? `'${o.parent}'` : 'NULL'},
      ${o.pin ? `'${o.pin}'` : 'NULL'}, ${o.holder ? `'${o.holder}'` : 'NULL'},
      ${o.wt ? 1 : 0}, ${o.bd ? 1 : 0});
  INSERT INTO computer_data_handoff(kind, item_key, task_id, payload, created_at)
    VALUES ('task-path', '${id}', '${id}', json_object('projectId', '${o.project ?? 'web'}',
      'worktreePath', ${o.wt === null ? 'NULL' : `'${o.wt}'`},
      'baseDir', ${o.bd === null ? 'NULL' : `'${o.bd}'`}, 'at', 1), 1);`

const staged = (db: Database.Database, taskId: string) => {
  const row = db
    .prepare("SELECT payload FROM computer_data_handoff WHERE kind='task-path' AND item_key=?")
    .get(taskId) as { payload: string } | undefined
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined
}
const holder = (db: Database.Database, taskId: string) =>
  (
    db.prepare('SELECT worktree_computer_id AS c FROM tasks WHERE id=?').get(taskId) as {
      c: string | null
    }
  ).c

test("paths staged as '' become unset, never ''", () => {
  const db = repaired(
    task('both', { wt: '', bd: '' }) +
      task('wt', { holder: 'local', wt: '', bd: '/r/web/pkg' }) +
      task('bd', { holder: 'local', wt: '/r/wt/bd', bd: '' })
  )
  try {
    expect(staged(db, 'both')).toMatchObject({ worktreePath: null, baseDir: null })
    expect(staged(db, 'wt')).toMatchObject({ worktreePath: null, baseDir: '/r/web/pkg' })
    expect(staged(db, 'bd')).toMatchObject({ worktreePath: '/r/wt/bd', baseDir: null })
    const empty = db
      .prepare(
        `SELECT count(*) AS n FROM computer_data_handoff WHERE kind='task-path'
          AND (json_extract(payload,'$.worktreePath') = '' OR json_extract(payload,'$.baseDir') = '')`
      )
      .get() as { n: number }
    expect(empty.n).toBe(0)
  } finally {
    db.close()
  }
})

test('a subtask holding its parent’s folder takes the parent’s holder (chains too)', () => {
  const db = repaired(
    task('pinned', { pin: 'bb', holder: 'bb', wt: '/r/wt/pinned', bd: null }) +
      task('child', { parent: 'pinned', holder: 'local', wt: '/r/wt/pinned', bd: null }) +
      task('grandchild', { parent: 'child', holder: 'local', wt: '/r/wt/pinned', bd: null }) +
      task('own', { parent: 'pinned', holder: 'local', wt: '/r/wt/own', bd: null }) +
      task('bdparent', { pin: 'bb', holder: 'bb', wt: null, bd: '/r/web/api' }) +
      task('bdchild', { parent: 'bdparent', holder: 'local', wt: null, bd: '/r/web/api' }) +
      task('top', { project: 'infra', holder: 'bb', wt: '/r/wt/top', bd: null }) +
      task('topchild', { project: 'infra', parent: 'top', holder: 'bb', wt: '/r/wt/top', bd: null })
  )
  try {
    expect(holder(db, 'pinned')).toBe('bb')
    expect(holder(db, 'child')).toBe('bb')
    expect(holder(db, 'grandchild')).toBe('bb')
    expect(holder(db, 'own')).toBe('local') // its own folder: as v211 decided
    expect(holder(db, 'bdchild')).toBe('bb')
    expect(holder(db, 'topchild')).toBe('bb')
  } finally {
    db.close()
  }
})

test('a holder recorded by a real write (not what the old v211 derived) is kept, as v211 keeps it', () => {
  // The old v211 derived a holder as the task's pin, else its project's default
  // ('local' for web). 'gpu' is neither: a real write (v197 on) recorded it, and
  // v211 keeps such a holder. v214 must not overwrite it with the parent's.
  const db = repaired(
    `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at) VALUES
      ('gpu', 'gpu-box', 'linux', '1', '[]', 0);` +
      task('pinned', { pin: 'bb', holder: 'bb', wt: '/r/wt/pinned', bd: null }) +
      task('recorded', { parent: 'pinned', holder: 'gpu', wt: '/r/wt/pinned', bd: null })
  )
  try {
    expect(holder(db, 'recorded')).toBe('gpu')
  } finally {
    db.close()
  }
})
