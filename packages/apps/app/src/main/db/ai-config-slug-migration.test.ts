/**
 * AI config slug migration tests
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm packages/apps/app/src/main/db/ai-config-slug-migration.test.ts
 */
import Database from 'better-sqlite3'
import { runMigrations } from '@slayzone/transport/db-bootstrap'

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
    toEqual(expected: unknown) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
      }
    }
  }
}

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

console.log('\nai-config slug migration')

test('normalizes and de-duplicates slugs per scope/type bucket', () => {
  const db = createDb()
  try {
    // Simulate a database that has applied v46 but not v47 yet.
    db.pragma('user_version = 46')

    const projectId = crypto.randomUUID()
    db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
      projectId,
      'Migration',
      '#000',
      '/tmp/migration'
    )

    const insertItem = db.prepare(`
      INSERT INTO ai_config_items (
        id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
    `)

    const g1 = crypto.randomUUID()
    const g2 = crypto.randomUUID()
    insertItem.run(
      g1,
      'skill',
      'global',
      null,
      'My Skill!!!',
      'My Skill!!!',
      '',
      '2025-01-01 00:00:00',
      '2025-01-01 00:00:00'
    )
    insertItem.run(
      g2,
      'skill',
      'global',
      null,
      'my-skill',
      'my-skill',
      '',
      '2025-01-02 00:00:00',
      '2025-01-02 00:00:00'
    )

    const p1 = crypto.randomUUID()
    const p2 = crypto.randomUUID()
    insertItem.run(
      p1,
      'command',
      'project',
      projectId,
      'Deploy Plan',
      'Deploy Plan',
      '',
      '2025-01-01 00:00:00',
      '2025-01-01 00:00:00'
    )
    insertItem.run(
      p2,
      'command',
      'project',
      projectId,
      'deploy-plan',
      'deploy-plan',
      '',
      '2025-01-02 00:00:00',
      '2025-01-02 00:00:00'
    )

    runMigrations(db)

    const byId = new Map(
      (
        db
          .prepare('SELECT id, slug, name FROM ai_config_items WHERE id IN (?, ?, ?, ?)')
          .all(g1, g2, p1, p2) as Array<{
          id: string
          slug: string
          name: string
        }>
      ).map((row) => [row.id, row])
    )

    expect(byId.get(g1)?.slug).toBe('my-skill')
    expect(byId.get(g2)?.slug).toBe('my-skill-2')
    expect(byId.get(p1)?.slug).toBe('deploy-plan')
    expect(byId.get(p2)?.slug).toBe('deploy-plan-2')

    expect(byId.get(g1)?.name).toBe('my-skill')
    expect(byId.get(g2)?.name).toBe('my-skill-2')
    expect(byId.get(p1)?.name).toBe('deploy-plan')
    expect(byId.get(p2)?.name).toBe('deploy-plan-2')

    const version = db.pragma('user_version', { simple: true }) as number
    expect(version).toBe(47)
  } finally {
    db.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
