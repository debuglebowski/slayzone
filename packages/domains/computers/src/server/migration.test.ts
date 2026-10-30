/**
 * Computer schema migrations. Runs the FULL production chain on a temp
 * in-memory DB — v149 creating the tables, and v163 renaming them to the
 * computer vocabulary. Both are exercised on the real upgrade path a live
 * store takes, not against a hand-built schema.
 */
import { describe, expect, it } from 'vitest'
import { LATEST_MIGRATION_VERSION, migrations, runMigrations } from '@slayzone/db-migrations'
import Database from 'better-sqlite3'
import { DB_PRAGMAS } from '@slayzone/platform'
import { DEFAULT_LOCAL_COMPUTER_NAME } from '../shared'
import { deterministicLocalComputerId } from './store'
import { createMigratedDb } from './test-db'

function tableNames(raw: Database.Database): string[] {
  return (
    raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
      name: string
    }[]
  ).map((r) => r.name)
}

function columnNames(raw: Database.Database, table: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)
}

describe('computer schema migration (v149 + v163)', () => {
  it('registry tail includes v149', () => {
    expect(LATEST_MIGRATION_VERSION).toBeGreaterThanOrEqual(149)
  })

  it('creates the computer tables on a fresh temp DB', () => {
    const t = createMigratedDb()
    try {
      const tables = tableNames(t.raw)
      expect(tables).toContain('computers')
      expect(tables).toContain('join_tokens')
      expect(tables).toContain('project_placements')
      expect(t.raw.pragma('user_version', { simple: true })).toBe(LATEST_MIGRATION_VERSION)

      expect(columnNames(t.raw, 'computers')).toEqual([
        'id',
        'name',
        'platform',
        'version',
        'capabilities_json',
        'auth_key_id',
        'last_seen_at',
        'created_at',
        'revoked_at',
        // v161 — who this computer belongs to. NULL = unclaimed.
        'owner_user_id',
        // v164 — which physical box, for grouping. Mutable; nothing references it.
        'host_id',
        // v165 — private by default, but only once the computer has an owner.
        'visibility'
      ])
      expect(columnNames(t.raw, 'join_tokens')).toEqual([
        'id',
        'token_hash',
        'label',
        'created_at',
        'expires_at',
        'used_at',
        'computer_id',
        // v162 — who minted it (the owner until T-20).
        'minted_by_user_id',
        // v170 — who it is for: the redeemed computer's owner (T-20).
        'owner_user_id'
      ])
      expect(columnNames(t.raw, 'project_placements')).toEqual([
        'computer_id',
        'project_id',
        'root_path',
        'status',
        'updated_at'
      ])
    } finally {
      t.close()
    }
  })

  it('adds the nullable binding columns to tasks and projects', () => {
    const t = createMigratedDb()
    try {
      const taskCol = (
        t.raw.prepare(`PRAGMA table_info(tasks)`).all() as {
          name: string
          notnull: number
          dflt_value: unknown
        }[]
      ).find((c) => c.name === 'computer_id')
      expect(taskCol).toBeDefined()
      expect(taskCol!.notnull).toBe(0)
      expect(taskCol!.dflt_value).toBeNull()

      const projectCol = (
        t.raw.prepare(`PRAGMA table_info(projects)`).all() as {
          name: string
          notnull: number
          dflt_value: unknown
        }[]
      ).find((c) => c.name === 'default_computer_id')
      expect(projectCol).toBeDefined()
      expect(projectCol!.notnull).toBe(0)
      expect(projectCol!.dflt_value).toBeNull()
    } finally {
      t.close()
    }
  })

  it('is a no-op when re-run on an up-to-date DB', () => {
    const t = createMigratedDb()
    try {
      expect(() => runMigrations(t.raw)).not.toThrow()
      expect(t.raw.pragma('user_version', { simple: true })).toBe(LATEST_MIGRATION_VERSION)
    } finally {
      t.close()
    }
  })

  it("v170 backfills a join token's owner from its minter, who was the owner before", () => {
    const t = createMigratedDb()
    try {
      // Back to v169: no owner column, one unused token an admin minted for themselves.
      t.raw.exec('ALTER TABLE join_tokens DROP COLUMN owner_user_id')
      t.raw.pragma('user_version = 169')
      t.raw
        .prepare(
          `INSERT INTO join_tokens (id, token_hash, label, created_at, expires_at, minted_by_user_id)
           VALUES ('jt-old', 'h', 'old', 1, 2, 'alice'), ('jt-local', 'h2', 'local', 1, 2, NULL)`
        )
        .run()
      // v170 alone: the database is otherwise at the latest schema, so re-running
      // every later migration would hit columns that already exist.
      const v170 = migrations.find((m) => m.version === 170)!
      t.raw.transaction(() => v170.up(t.raw))()
      expect(t.raw.prepare('SELECT id, owner_user_id FROM join_tokens ORDER BY id').all()).toEqual([
        { id: 'jt-local', owner_user_id: null },
        { id: 'jt-old', owner_user_id: 'alice' }
      ])
    } finally {
      t.close()
    }
  })

  it('enforces join_tokens.token_hash uniqueness', () => {
    const t = createMigratedDb()
    try {
      const ins = t.raw.prepare(
        `INSERT INTO join_tokens (id, token_hash, label, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      ins.run('jt-1', 'same-hash', 'a', 1, 2)
      expect(() => ins.run('jt-2', 'same-hash', 'b', 1, 2)).toThrow()
    } finally {
      t.close()
    }
  })

  it('enforces one checkout row per (computer, project)', () => {
    const t = createMigratedDb()
    try {
      const ins = t.raw.prepare(
        `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      ins.run('r-1', 'p-1', '/a', 'ready', 1)
      expect(() => ins.run('r-1', 'p-1', '/b', 'ready', 2)).toThrow()
      ins.run('r-1', 'p-2', '/c', 'ready', 3)
    } finally {
      t.close()
    }
  })
})

// v163 renames tables and columns rather than rebuilding them. The risk of a
// rename is not that it fails loudly — it is that it drops rows or silently
// leaves a PK naming a column that no longer exists. Seed BEFORE the rename and
// assert the rows are still addressable by their new names afterwards.
describe('v163 computer → computer rename', () => {
  it('carries rows, the composite PK and the path index across the rename', () => {
    const t = createMigratedDb()
    try {
      // Seeded post-migration, which is the same shape the rename produced —
      // what matters is that the new names are the ones that work.
      t.raw
        .prepare(
          `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at)
           VALUES ('c1', 'mac-studio', 'darwin-arm64', '0.36.0', '{}', 1)`
        )
        .run()
      t.raw
        .prepare(
          `INSERT INTO projects (id, name, color, sort_order, default_computer_id)
           VALUES ('p1', 'P', '#fff', 0, 'c1')`
        )
        .run()
      t.raw
        .prepare(
          `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
           VALUES ('c1', 'p1', '/srv/app', 'ready', 1)`
        )
        .run()

      expect(tableNames(t.raw)).toContain('computers')
      expect(tableNames(t.raw)).toContain('project_placements')
      // The old names must be GONE, not shadowed by a leftover copy. These two
      // string literals are PRE-RENAME names on purpose — a codemod that rewrites
      // them makes the assertion vacuous, which has now happened twice.
      expect(tableNames(t.raw)).not.toContain('runners')
      expect(tableNames(t.raw)).not.toContain('runner_project_checkouts')

      // RENAME COLUMN rewrites the stored schema text, so the composite PK
      // follows the rename. If it had not, this second insert would be accepted
      // instead of colliding.
      let collided = false
      try {
        t.raw
          .prepare(
            `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
             VALUES ('c1', 'p1', '/other', 'ready', 2)`
          )
          .run()
      } catch {
        collided = true
      }
      expect(collided).toBe(true)

      const idx = (
        t.raw
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
          .all('project_placements') as { name: string }[]
      ).map((r) => r.name)
      expect(idx).toContain('idx_project_placements_path')
      expect(idx).not.toContain('idx_runner_checkouts_path')
    } finally {
      t.close()
    }
  })
})

// v176: the desktop hub's `projects.path` column → the project's folder on the
// local computer. It runs before the hub serves anything, and needs no computer
// row, so a project shows its folder from the very first read — also on the first
// boot after skipping releases, before the local computer has ever enrolled.
describe('v176 legacy project path → folder on the local computer', () => {
  const LOCAL = deterministicLocalComputerId(DEFAULT_LOCAL_COMPUTER_NAME)

  function migratedTo(version: number): Database.Database {
    const raw = new Database(':memory:')
    for (const pragma of DB_PRAGMAS) raw.pragma(pragma)
    for (const m of migrations) {
      if (m.version > version) break
      raw.transaction(() => {
        m.up(raw)
        raw.pragma(`user_version = ${m.version}`)
      })()
    }
    return raw
  }

  function project(raw: Database.Database, id: string, path: string | null, computer?: string) {
    raw
      .prepare(
        `INSERT INTO projects (id, name, color, path, default_computer_id) VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, id, '#000', path, computer ?? null)
  }

  function placements(raw: Database.Database) {
    return raw
      .prepare(
        `SELECT computer_id, project_id, root_path, status FROM project_placements
          ORDER BY project_id, computer_id`
      )
      .all()
  }

  function defaults(raw: Database.Database) {
    return Object.fromEntries(
      (
        raw.prepare(`SELECT id, default_computer_id FROM projects`).all() as {
          id: string
          default_computer_id: string | null
        }[]
      ).map((r) => [r.id, r.default_computer_id])
    )
  }

  it('gives every project with a path a pending folder on the local computer, as its default', () => {
    const raw = migratedTo(175)
    try {
      project(raw, 'p1', '/Users/me/app')
      project(raw, 'p2', '/Users/me/remote-default', 'remote-1')
      project(raw, 'none', null)
      project(raw, 'empty', '')
      runMigrations(raw)

      expect(placements(raw)).toEqual([
        { computer_id: LOCAL, project_id: 'p1', root_path: '/Users/me/app', status: 'pending' },
        {
          computer_id: LOCAL,
          project_id: 'p2',
          root_path: '/Users/me/remote-default',
          status: 'pending'
        }
      ])
      // A default someone chose stays; only projects without one get the local computer.
      expect(defaults(raw)).toEqual({ p1: LOCAL, p2: 'remote-1', none: null, empty: null })
      // The column stays until it is dropped: an older build reading this DB keeps its paths.
      expect(raw.prepare(`SELECT path FROM projects WHERE id = 'p1'`).pluck().get()).toBe(
        '/Users/me/app'
      )
    } finally {
      raw.close()
    }
  })

  it('leaves a folder the local computer already reported alone', () => {
    const raw = migratedTo(175)
    try {
      project(raw, 'p1', '/Users/me/old')
      raw
        .prepare(
          `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
           VALUES (?, 'p1', '/Users/me/moved', 'ready', 1)`
        )
        .run(LOCAL)
      runMigrations(raw)

      expect(placements(raw)).toEqual([
        { computer_id: LOCAL, project_id: 'p1', root_path: '/Users/me/moved', status: 'ready' }
      ])
    } finally {
      raw.close()
    }
  })
})
