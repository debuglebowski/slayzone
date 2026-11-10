/**
 * v212: a project's legacy folder reaches every computer its work was bound to.
 *
 * v176 handed each legacy `projects.path` to the LOCAL computer only. Before the
 * per-computer folder split, one path served whichever computer ran the work, so a
 * project's default computer and every computer a task was pinned to lost the folder —
 * on a standalone hub (no local computer at all) the project lost it everywhere.
 * Found by the migration persona suite (tools/migration-personas, p02-v0362-multi).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v212-project-folder-bound-computers-migration.test.ts
 */
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { migrations } from './index'

const LOCAL = 'f01a216a-4803-4214-98eb-f9e28951e1bb'

function runRange(db: Database.Database, from: number, to: number): void {
  for (const m of migrations)
    if (m.version > from && m.version <= to)
      db.transaction(() => {
        m.up(db)
        db.pragma(`user_version = ${m.version}`)
      })()
}

const placements = (db: Database.Database, project: string) =>
  db
    .prepare(
      'SELECT computer_id, root_path, status FROM project_placements WHERE project_id = ? ORDER BY computer_id'
    )
    .all(project)

/** A v171 (v0.36.2) hub: the column-era projects, computers and bindings. */
function hubAt171(): Database.Database {
  const db = new Database(':memory:')
  runRange(db, 0, 171)
  db.exec(`
    INSERT INTO computers (id, name, platform, version, capabilities_json, created_at)
      VALUES ('gpu', 'gpu-box', 'linux', '1', '[]', 0), ('build', 'build-box', 'linux', '1', '[]', 0);
    INSERT INTO projects (id, name, color, path, default_computer_id)
      VALUES ('ml', 'ML', '#000', '/home/u/repos/ml', 'gpu'),
             ('docs', 'Docs', '#000', '/home/u/repos/docs', NULL),
             ('nopath', 'NoPath', '#000', NULL, 'gpu');
    INSERT INTO tasks (id, project_id, title, computer_id)
      VALUES ('t1', 'ml', 'Train', NULL), ('t2', 'ml', 'Eval', 'build'), ('t3', 'ml', 'Eval 2', 'build'),
             ('t4', 'nopath', 'X', 'build');
  `)
  return db
}

test('the default computer and every pinned computer get the legacy folder, pending', () => {
  const db = hubAt171()
  try {
    runRange(db, 171, LATEST())
    expect(placements(db, 'ml')).toEqual([
      { computer_id: 'build', root_path: '/home/u/repos/ml', status: 'pending' },
      { computer_id: LOCAL, root_path: '/home/u/repos/ml', status: 'pending' },
      { computer_id: 'gpu', root_path: '/home/u/repos/ml', status: 'pending' }
    ])
  } finally {
    db.close()
  }
})

test('a project with no bound computer keeps only what v176 gave it', () => {
  const db = hubAt171()
  try {
    runRange(db, 171, LATEST())
    // v176 made the local computer its default; nothing else was bound.
    expect(placements(db, 'docs')).toEqual([
      { computer_id: LOCAL, root_path: '/home/u/repos/docs', status: 'pending' }
    ])
  } finally {
    db.close()
  }
})

test('a project without a legacy folder gets none', () => {
  const db = hubAt171()
  try {
    runRange(db, 171, LATEST())
    expect(placements(db, 'nopath')).toEqual([])
  } finally {
    db.close()
  }
})

test('a folder a computer already holds is left as it is', () => {
  const db = hubAt171()
  try {
    runRange(db, 171, 211)
    // The user (or a delivery) already set gpu-box's folder somewhere else.
    db.prepare(
      `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
       VALUES ('gpu', 'ml', '/srv/ml', 'ready', 5)
       ON CONFLICT(computer_id, project_id) DO UPDATE SET root_path='/srv/ml', status='ready', updated_at=5`
    ).run()
    runRange(db, 211, LATEST())
    expect(
      db.prepare("SELECT root_path, status FROM project_placements WHERE project_id='ml' AND computer_id='gpu'").get()
    ).toEqual({ root_path: '/srv/ml', status: 'ready' })
  } finally {
    db.close()
  }
})

function LATEST(): number {
  return migrations[migrations.length - 1].version
}
