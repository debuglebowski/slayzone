/**
 * Runner schema migration (v149) tests. Runs the FULL production migration
 * chain on a temp in-memory DB — proves v149 applies cleanly on top of the
 * real v148 schema (the actual upgrade path a live store takes).
 */
import { describe, expect, it } from 'vitest'
import { LATEST_MIGRATION_VERSION, runMigrations } from '@slayzone/transport/db-bootstrap'
import type Database from 'better-sqlite3'
import { createMigratedDb } from './test-db'

function tableNames(raw: Database.Database): string[] {
  return (
    raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
      name: string
    }[]
  ).map((r) => r.name)
}

function columnNames(raw: Database.Database, table: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (r) => r.name
  )
}

describe('runner schema migration (v149)', () => {
  it('registry tail includes v149', () => {
    expect(LATEST_MIGRATION_VERSION).toBeGreaterThanOrEqual(149)
  })

  it('creates the runner tables on a fresh temp DB', () => {
    const t = createMigratedDb()
    try {
      const tables = tableNames(t.raw)
      expect(tables).toContain('runners')
      expect(tables).toContain('join_tokens')
      expect(tables).toContain('runner_project_checkouts')
      expect(t.raw.pragma('user_version', { simple: true })).toBe(LATEST_MIGRATION_VERSION)

      expect(columnNames(t.raw, 'runners')).toEqual([
        'id',
        'name',
        'platform',
        'version',
        'capabilities_json',
        'auth_key_id',
        'last_seen_at',
        'created_at',
        'revoked_at'
      ])
      expect(columnNames(t.raw, 'join_tokens')).toEqual([
        'id',
        'token_hash',
        'label',
        'created_at',
        'expires_at',
        'used_at',
        'runner_id'
      ])
      expect(columnNames(t.raw, 'runner_project_checkouts')).toEqual([
        'runner_id',
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
      ).find((c) => c.name === 'runner_id')
      expect(taskCol).toBeDefined()
      expect(taskCol!.notnull).toBe(0)
      expect(taskCol!.dflt_value).toBeNull()

      const projectCol = (
        t.raw.prepare(`PRAGMA table_info(projects)`).all() as {
          name: string
          notnull: number
          dflt_value: unknown
        }[]
      ).find((c) => c.name === 'default_runner_id')
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

  it('enforces one checkout row per (runner, project)', () => {
    const t = createMigratedDb()
    try {
      const ins = t.raw.prepare(
        `INSERT INTO runner_project_checkouts (runner_id, project_id, root_path, status, updated_at)
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
