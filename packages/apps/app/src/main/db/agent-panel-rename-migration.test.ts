/**
 * Global Agent Panel rename migration tests (v132 + v133).
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm packages/apps/app/src/main/db/agent-panel-rename-migration.test.ts
 */
import Database from 'better-sqlite3'
import { runMigrations } from './migrations.js'

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
    },
  }
}

function createDb(toVersion?: number): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db, { toVersion })
  return db
}

function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value)
}

console.log('\nagent panel rename migration')

test('v132 renames agentPanelState → globalAgentPanelState', () => {
  const db = createDb(131)
  try {
    db.prepare("DELETE FROM settings WHERE key IN ('agentPanelState', 'globalAgentPanelState')").run()
    const payload = JSON.stringify({ isOpen: true, panelWidth: 480 })
    setSetting(db, 'agentPanelState', payload)
    runMigrations(db, { toVersion: 132 })
    expect(getSetting(db, 'globalAgentPanelState')).toBe(payload)
    expect(getSetting(db, 'agentPanelState')).toBe(null)
  } finally {
    db.close()
  }
})

test('v132 keeps existing globalAgentPanelState if both present', () => {
  const db = createDb(131)
  try {
    db.prepare("DELETE FROM settings WHERE key IN ('agentPanelState', 'globalAgentPanelState')").run()
    setSetting(db, 'agentPanelState', '{"old":true}')
    setSetting(db, 'globalAgentPanelState', '{"new":true}')
    runMigrations(db, { toVersion: 132 })
    expect(getSetting(db, 'globalAgentPanelState')).toBe('{"new":true}')
    expect(getSetting(db, 'agentPanelState')).toBe(null)
  } finally {
    db.close()
  }
})

test('v133 renames floatingAgent* keys to floatingGlobalAgentPanel*', () => {
  const db = createDb(132)
  try {
    const keys = ['floatingAgentExpandedSize', 'floatingAgentConfig', 'floatingGlobalAgentPanelExpandedSize', 'floatingGlobalAgentPanelConfig']
    for (const k of keys) db.prepare('DELETE FROM settings WHERE key = ?').run(k)
    setSetting(db, 'floatingAgentExpandedSize', '{"width":400,"height":300}')
    setSetting(db, 'floatingAgentConfig', '{"style":"icon","position":"bottom-right"}')
    runMigrations(db, { toVersion: 133 })
    expect(getSetting(db, 'floatingGlobalAgentPanelExpandedSize')).toBe('{"width":400,"height":300}')
    expect(getSetting(db, 'floatingGlobalAgentPanelConfig')).toBe('{"style":"icon","position":"bottom-right"}')
    expect(getSetting(db, 'floatingAgentExpandedSize')).toBe(null)
    expect(getSetting(db, 'floatingAgentConfig')).toBe(null)
  } finally {
    db.close()
  }
})

test('v133 noop when no legacy keys exist', () => {
  const db = createDb(132)
  try {
    const keys = ['floatingAgentExpandedSize', 'floatingAgentConfig', 'floatingGlobalAgentPanelExpandedSize', 'floatingGlobalAgentPanelConfig']
    for (const k of keys) db.prepare('DELETE FROM settings WHERE key = ?').run(k)
    runMigrations(db, { toVersion: 133 })
    expect(getSetting(db, 'floatingGlobalAgentPanelExpandedSize')).toBe(null)
    expect(getSetting(db, 'floatingGlobalAgentPanelConfig')).toBe(null)
  } finally {
    db.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
