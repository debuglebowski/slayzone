/**
 * v227: sharing is for project members only. Task and artifact grants held by someone
 * who is neither the project's owner nor one of its members are dropped (never turned
 * into membership); grants to the owner and to members stay. `artifact_grants` gains
 * `opened_at` (NULL: the grantee has not opened the file yet).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v227-sharing-members-only-migration.test.ts
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

test('drops grants to people outside the project, keeps the owner’s and members’', () => {
  const db = new Database(':memory:')
  try {
    runRange(db, 0, 226)
    db.exec(`
      INSERT INTO projects (id, name, color, owner_user_id) VALUES ('p', 'P', '#000', 'owner'),
        ('q', 'Q', '#000', 'other');
      INSERT INTO project_members (project_id, user_id, role) VALUES ('p', 'member', 'view');
      INSERT INTO tasks (id, project_id, title) VALUES ('t', 'p', 'T'), ('u', 'q', 'U');
      INSERT INTO task_artifacts (id, task_id, title) VALUES ('a', 't', 'A');
      INSERT INTO task_grants (task_id, user_id, role) VALUES
        ('t', 'owner', 'manage'), ('t', 'member', 'edit'), ('t', 'guest', 'view'),
        ('u', 'member', 'view');
      INSERT INTO artifact_grants (artifact_id, user_id, role) VALUES
        ('a', 'member', 'view'), ('a', 'guest', 'edit'), ('a', 'owner', 'view');
    `)
    runRange(db, 226, 227)
    expect(
      db.prepare('SELECT task_id, user_id FROM task_grants ORDER BY task_id, user_id').all()
    ).toEqual([
      { task_id: 't', user_id: 'member' },
      { task_id: 't', user_id: 'owner' }
    ])
    expect(
      db.prepare('SELECT user_id, opened_at FROM artifact_grants ORDER BY user_id').all()
    ).toEqual([
      { user_id: 'member', opened_at: null },
      { user_id: 'owner', opened_at: null }
    ])
    // Nobody was made a member on the way.
    expect(db.prepare('SELECT project_id, user_id FROM project_members').all()).toEqual([
      { project_id: 'p', user_id: 'member' }
    ])
  } finally {
    db.close()
  }
})
