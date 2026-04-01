/**
 * History migration tests
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm src/main/db/history-migration.test.ts
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
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`)
    },
  }
}

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

function hasTable(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { 1: number } | undefined
  return Boolean(row)
}

function hasIndex(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as { 1: number } | undefined
  return Boolean(row)
}

console.log('\nhistory migrations')

test('creates activity_events and automation_action_runs tables', () => {
  const db = createDb()
  try {
    expect(hasTable(db, 'activity_events')).toBe(true)
    expect(hasTable(db, 'automation_action_runs')).toBe(true)
  } finally {
    db.close()
  }
})

test('creates the expected history indexes', () => {
  const db = createDb()
  try {
    expect(hasIndex(db, 'idx_activity_events_task_created')).toBeTruthy()
    expect(hasIndex(db, 'idx_activity_events_task_created_id')).toBeTruthy()
    expect(hasIndex(db, 'idx_activity_events_entity')).toBeTruthy()
    expect(hasIndex(db, 'idx_activity_events_project_created')).toBeTruthy()
    expect(hasIndex(db, 'idx_activity_events_project_created_id')).toBeTruthy()
    expect(hasIndex(db, 'idx_automation_action_runs_run')).toBeTruthy()
  } finally {
    db.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
