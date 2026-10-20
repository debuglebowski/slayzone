/**
 * Downgrade guard: an older build must refuse a DB migrated by a newer one.
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm packages/shared/transport/src/db-bootstrap/schema-too-new.test.ts
 */
import Database from 'better-sqlite3'
import { LATEST_MIGRATION_VERSION, runMigrations, SchemaTooNewError } from './index'

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

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

console.log('\nschema too new')

test('refuses a DB newer than the latest migration, without touching it', () => {
  const db = new Database(':memory:')
  try {
    db.pragma(`user_version = ${LATEST_MIGRATION_VERSION + 1}`)
    let thrown: unknown
    try {
      runMigrations(db)
    } catch (err) {
      thrown = err
    }
    assert(thrown instanceof SchemaTooNewError, `expected SchemaTooNewError, got ${String(thrown)}`)
    const msg = (thrown as Error).message
    assert(msg.includes(`v${LATEST_MIGRATION_VERSION + 1}`), `message lacks DB version: ${msg}`)
    assert(msg.includes(`v${LATEST_MIGRATION_VERSION}`), `message lacks build version: ${msg}`)
    const tables = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'")
      .get() as {
      n: number
    }
    assert(tables.n === 0, `expected no tables created, got ${tables.n}`)
    const v = db.pragma('user_version', { simple: true })
    assert(v === LATEST_MIGRATION_VERSION + 1, `user_version changed to ${String(v)}`)
  } finally {
    db.close()
  }
})

test('accepts a DB at exactly the latest version (no-op)', () => {
  const db = new Database(':memory:')
  try {
    runMigrations(db)
    runMigrations(db)
    const v = db.pragma('user_version', { simple: true })
    assert(v === LATEST_MIGRATION_VERSION, `user_version is ${String(v)}`)
  } finally {
    db.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
