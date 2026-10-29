/**
 * Worktree source branch migration tests (v51).
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/db-migrations/src/worktree-source-branch-migration.test.ts
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { LATEST_MIGRATION_VERSION, migrations, runMigrations } from './index'

/**
 * Build a DB migrated to exactly `version` — the schema the migration under
 * test actually runs against. Migrations are forward-only, so migrating to
 * latest and rewinding user_version replays DDL against a schema it was never
 * written for (v52's replay re-adds projects.execution_context and throws).
 */
function dbAtVersion(version: number): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  for (const migration of migrations) {
    if (migration.version > version) break
    db.transaction(() => {
      migration.up(db)
      db.pragma(`user_version = ${migration.version}`)
    })()
  }
  return db
}

function applyMigration(db: Database.Database, version: number): void {
  const migration = migrations.find((m) => m.version === version)
  if (!migration) throw new Error(`migration v${version} not found`)
  db.transaction(() => {
    migration.up(db)
    db.pragma(`user_version = ${version}`)
  })()
}

function projectColumnCount(db: Database.Database, columnName: string): number {
  const columns = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>
  return columns.filter((column) => column.name === columnName).length
}

function sourceBranch(db: Database.Database, projectId: string): string | null {
  const row = db
    .prepare('SELECT worktree_source_branch FROM projects WHERE id = ?')
    .get(projectId) as {
    worktree_source_branch: string | null
  }
  return row.worktree_source_branch
}

/** The drift v51 guards against: the column exists while user_version is still 50. */
function driftedDbAtV50(): Database.Database {
  const db = dbAtVersion(50)
  db.exec(`ALTER TABLE projects ADD COLUMN worktree_source_branch TEXT DEFAULT NULL`)
  db.prepare(
    "INSERT INTO projects (id, name, color, path, worktree_source_branch) VALUES ('p1', 'P', '#000', '/tmp/p', 'develop')"
  ).run()
  return db
}

describe('worktree source branch migration', () => {
  test('v51 adds projects.worktree_source_branch to a v50 DB', () => {
    const db = dbAtVersion(50)
    try {
      expect(projectColumnCount(db, 'worktree_source_branch')).toBe(0)
      db.prepare(
        "INSERT INTO projects (id, name, color, path) VALUES ('p1', 'P', '#000', '/tmp/p')"
      ).run()

      applyMigration(db, 51)

      expect(projectColumnCount(db, 'worktree_source_branch')).toBe(1)
      expect(sourceBranch(db, 'p1')).toBeNull()
    } finally {
      db.close()
    }
  })

  test('v51 handles drift where user_version=50 but worktree_source_branch already exists', () => {
    const db = driftedDbAtV50()
    try {
      applyMigration(db, 51)

      expect(projectColumnCount(db, 'worktree_source_branch')).toBe(1)
      expect(db.pragma('user_version', { simple: true })).toBe(51)
      expect(sourceBranch(db, 'p1')).toBe('develop')
    } finally {
      db.close()
    }
  })

  test('a drifted v50 DB migrates through to latest', () => {
    const db = driftedDbAtV50()
    try {
      runMigrations(db)

      expect(db.pragma('user_version', { simple: true })).toBe(LATEST_MIGRATION_VERSION)
      expect(projectColumnCount(db, 'worktree_source_branch')).toBe(1)
      expect(sourceBranch(db, 'p1')).toBe('develop')
    } finally {
      db.close()
    }
  })
})
