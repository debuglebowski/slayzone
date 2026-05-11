/**
 * Worktree source branch migration tests
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm packages/apps/app/src/main/db/worktree-source-branch-migration.test.ts
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

function hasProjectColumn(db: Database.Database, columnName: string): boolean {
  const columns = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}

console.log('\nworktree source branch migration')

test('handles drift where user_version=50 but worktree_source_branch already exists', () => {
  const db = createDb(51)
  try {
    expect(hasProjectColumn(db, 'worktree_source_branch')).toBe(true)

    db.pragma('user_version = 50')
    runMigrations(db, { toVersion: 51 })

    expect(hasProjectColumn(db, 'worktree_source_branch')).toBe(true)
    const version = db.pragma('user_version', { simple: true }) as number
    expect(version).toBe(51)
  } finally {
    db.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
