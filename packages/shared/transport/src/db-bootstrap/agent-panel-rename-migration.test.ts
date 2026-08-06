/**
 * Global Agent Panel rename migration tests (v132 + v133).
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm packages/shared/transport/src/db-bootstrap/agent-panel-rename-migration.test.ts
 */
import Database from 'better-sqlite3'
import { migrations } from './index'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (error) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${error instanceof Error ? error.message : String(error)}`)
    failed++
  }
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
      }
    }
  }
}

/**
 * Build a DB migrated to exactly `version` — the schema a migration under test
 * actually runs against. Migrations are forward-only (they DROP columns, they
 * ADD columns unguarded), so the old "migrate to latest, rewind user_version,
 * re-run" trick replays the whole tail against a schema it was never written
 * for and dies on the first non-replayable DDL (v135 drops tasks.manager_mode).
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

function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

console.log('\nagent panel rename migration')

test('v132 renames agentPanelState → globalAgentPanelState', () => {
  const db = dbAtVersion(131)
  try {
    db.prepare(
      "DELETE FROM settings WHERE key IN ('agentPanelState', 'globalAgentPanelState')"
    ).run()
    const payload = JSON.stringify({ isOpen: true, panelWidth: 480 })
    setSetting(db, 'agentPanelState', payload)
    applyMigration(db, 132)
    expect(getSetting(db, 'globalAgentPanelState')).toBe(payload)
    expect(getSetting(db, 'agentPanelState')).toBe(null)
  } finally {
    db.close()
  }
})

test('v132 keeps existing globalAgentPanelState if both present', () => {
  const db = dbAtVersion(131)
  try {
    db.prepare(
      "DELETE FROM settings WHERE key IN ('agentPanelState', 'globalAgentPanelState')"
    ).run()
    setSetting(db, 'agentPanelState', '{"old":true}')
    setSetting(db, 'globalAgentPanelState', '{"new":true}')
    applyMigration(db, 132)
    expect(getSetting(db, 'globalAgentPanelState')).toBe('{"new":true}')
    expect(getSetting(db, 'agentPanelState')).toBe(null)
  } finally {
    db.close()
  }
})

test('v133 renames floatingAgent* keys to floatingGlobalAgentPanel*', () => {
  const db = dbAtVersion(132)
  try {
    const keys = [
      'floatingAgentExpandedSize',
      'floatingAgentConfig',
      'floatingGlobalAgentPanelExpandedSize',
      'floatingGlobalAgentPanelConfig'
    ]
    for (const k of keys) db.prepare('DELETE FROM settings WHERE key = ?').run(k)
    setSetting(db, 'floatingAgentExpandedSize', '{"width":400,"height":300}')
    setSetting(db, 'floatingAgentConfig', '{"style":"icon","position":"bottom-right"}')
    applyMigration(db, 133)
    expect(getSetting(db, 'floatingGlobalAgentPanelExpandedSize')).toBe(
      '{"width":400,"height":300}'
    )
    expect(getSetting(db, 'floatingGlobalAgentPanelConfig')).toBe(
      '{"style":"icon","position":"bottom-right"}'
    )
    expect(getSetting(db, 'floatingAgentExpandedSize')).toBe(null)
    expect(getSetting(db, 'floatingAgentConfig')).toBe(null)
  } finally {
    db.close()
  }
})

test('v133 noop when no legacy keys exist', () => {
  const db = dbAtVersion(132)
  try {
    const keys = [
      'floatingAgentExpandedSize',
      'floatingAgentConfig',
      'floatingGlobalAgentPanelExpandedSize',
      'floatingGlobalAgentPanelConfig'
    ]
    for (const k of keys) db.prepare('DELETE FROM settings WHERE key = ?').run(k)
    applyMigration(db, 133)
    expect(getSetting(db, 'floatingGlobalAgentPanelExpandedSize')).toBe(null)
    expect(getSetting(db, 'floatingGlobalAgentPanelConfig')).toBe(null)
  } finally {
    db.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
