/**
 * The hub's accounts/API-key database: `hub-auth.sqlite` → `slayzone.auth.sqlite`.
 *
 * It holds credentials, and nothing else ever recreates them: an auth DB that quietly
 * restarts empty means every enrolled computer's API key is rejected and every owner
 * login is gone. So the rename must carry the file (and its WAL) across, must never
 * overwrite a database already at the new name, and must leave a fresh install alone.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUTH_DB_NAME, LEGACY_AUTH_DB_NAME, resolveAuthDbPath } from './auth-db'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slay-auth-db-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function makeAuthDb(file: string, rows: string[]): void {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT)')
  const ins = db.prepare('INSERT INTO user (id, email) VALUES (?, ?)')
  for (const r of rows) ins.run(r, `${r}@example.com`)
  db.close()
}
function emails(file: string): string[] {
  const db = new DatabaseSync(file)
  const out = (db.prepare('SELECT email FROM user ORDER BY id').all() as { email: string }[]).map(
    (r) => r.email
  )
  db.close()
  return out
}

describe('resolveAuthDbPath', () => {
  it('names the database slayzone.auth.sqlite', () => {
    expect(AUTH_DB_NAME).toBe('slayzone.auth.sqlite')
    expect(LEGACY_AUTH_DB_NAME).toBe('hub-auth.sqlite')
    expect(resolveAuthDbPath(root)).toBe(join(root, 'slayzone.auth.sqlite'))
  })

  it('carries a beta hub-auth.sqlite across with its accounts', () => {
    makeAuthDb(join(root, LEGACY_AUTH_DB_NAME), ['owner', 'alice'])
    const p = resolveAuthDbPath(root)
    expect(emails(p)).toEqual(['alice@example.com', 'owner@example.com'])
    expect(existsSync(join(root, LEGACY_AUTH_DB_NAME))).toBe(false)
  })

  it('never overwrites a database already at the new name', () => {
    makeAuthDb(join(root, AUTH_DB_NAME), ['current'])
    writeFileSync(join(root, LEGACY_AUTH_DB_NAME), 'STALE')
    const p = resolveAuthDbPath(root)
    expect(emails(p)).toEqual(['current@example.com'])
    expect(readFileSync(join(root, LEGACY_AUTH_DB_NAME), 'utf8')).toBe('STALE')
  })

  it('leaves a fresh install alone (creates nothing)', () => {
    resolveAuthDbPath(root)
    expect(existsSync(join(root, AUTH_DB_NAME))).toBe(false)
    expect(existsSync(join(root, LEGACY_AUTH_DB_NAME))).toBe(false)
  })

  it('is idempotent', () => {
    makeAuthDb(join(root, LEGACY_AUTH_DB_NAME), ['owner'])
    resolveAuthDbPath(root)
    resolveAuthDbPath(root)
    expect(emails(join(root, AUTH_DB_NAME))).toEqual(['owner@example.com'])
  })
})
