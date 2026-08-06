/**
 * AI config raw skill migration tests
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm packages/shared/transport/src/db-bootstrap/ai-config-raw-skill-migration.test.ts
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
    },
    toContain(expected: string) {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`)
      }
    }
  }
}

/**
 * Build a DB migrated to exactly `version` — the schema the migration under
 * test actually runs against. Migrations are forward-only, so the old trick of
 * migrating to latest and rewinding user_version replayed unguarded DDL (v80's
 * `ALTER TABLE ... ADD COLUMN sort_order`) against a schema that already had it.
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

console.log('\nai-config raw skill migration')

test('backfills legacy split skill rows into raw content and strips canonical metadata', () => {
  const db = dbAtVersion(77)
  try {
    const projectId = crypto.randomUUID()
    db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
      projectId,
      'Migration',
      '#000',
      '/tmp/migration'
    )

    const itemId = crypto.randomUUID()
    db.prepare(`
      INSERT INTO ai_config_items (
        id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at
      ) VALUES (?, 'skill', 'global', NULL, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      itemId,
      'legacy-raw-skill',
      'legacy-raw-skill',
      '# legacy body\n',
      JSON.stringify({
        skillCanonical: {
          frontmatter: {
            name: 'legacy-raw-skill',
            description: 'legacy description'
          },
          explicitFrontmatter: true
        }
      })
    )

    applyMigration(db, 78)

    const row = db
      .prepare('SELECT content, metadata_json FROM ai_config_items WHERE id = ?')
      .get(itemId) as {
      content: string
      metadata_json: string
    }
    expect(row.content).toContain('---\nname: legacy-raw-skill')
    expect(row.content).toContain('description: "legacy description"')
    expect(row.content).toContain('# legacy body')

    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>
    expect(String('skillCanonical' in metadata)).toBe('false')
    expect(JSON.stringify(metadata.skillValidation)).toContain('"status":"valid"')
  } finally {
    db.close()
  }
})

test('leaves body-only skills without canonical frontmatter invalid after migration', () => {
  const db = dbAtVersion(77)
  try {
    const itemId = crypto.randomUUID()
    db.prepare(`
      INSERT INTO ai_config_items (
        id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at
      ) VALUES (?, 'skill', 'global', NULL, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(itemId, 'body-only-skill', 'body-only-skill', '# body only\n', '{}')

    applyMigration(db, 78)

    const row = db
      .prepare('SELECT content, metadata_json FROM ai_config_items WHERE id = ?')
      .get(itemId) as {
      content: string
      metadata_json: string
    }
    expect(row.content).toBe('# body only\n')
    expect(JSON.stringify(JSON.parse(row.metadata_json).skillValidation)).toContain(
      '"status":"invalid"'
    )
    expect(JSON.stringify(JSON.parse(row.metadata_json).skillValidation)).toContain(
      '"frontmatter_missing"'
    )
  } finally {
    db.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
