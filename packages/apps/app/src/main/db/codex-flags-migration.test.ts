/**
 * Codex flags migration tests (v134).
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm packages/apps/app/src/main/db/codex-flags-migration.test.ts
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

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

function getCodexModeFlags(db: Database.Database): string | null {
  const row = db.prepare("SELECT default_flags FROM terminal_modes WHERE id = 'codex'").get() as { default_flags: string | null } | undefined
  return row?.default_flags ?? null
}

function rewindAndApply(db: Database.Database, toVersion: number): void {
  db.pragma(`user_version = ${toVersion}`)
  runMigrations(db)
}

console.log('\ncodex flags migration')

test('v134 migrates persisted Codex defaults away from removed --full-auto', () => {
  const db = createDb()
  try {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('default_codex_flags', '--full-auto --search')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run()
    db.prepare(`
      INSERT OR IGNORE INTO terminal_modes (
        id, label, type, initial_command, resume_command, headless_command, default_flags, enabled, is_builtin, "order"
      ) VALUES (
        'codex', 'Codex', 'codex', 'codex {flags}', 'codex {flags} resume {id}', 'codex exec {flags} {prompt}', '', 1, 1, 1
      )
    `).run()
    db.prepare("UPDATE terminal_modes SET default_flags = '--full-auto --search' WHERE id = 'codex'").run()

    db.prepare("INSERT INTO projects (id, name, color, path) VALUES ('p1', 'P', '#000', '/tmp/p')").run()
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, codex_flags, provider_config)
      VALUES (?, 'p1', ?, 'todo', 3, 'codex', ?, ?)
    `).run(
      't1',
      'Task',
      '--full-auto --search',
      JSON.stringify({ codex: { flags: '--full-auto --search --disable apps', conversationId: 'cid' } })
    )
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, codex_flags, provider_config)
      VALUES (?, 'p1', ?, 'todo', 3, 'codex', ?, ?)
    `).run(
      't2',
      'Custom',
      '--custom --full-auto',
      JSON.stringify({ codex: { flags: '--custom --full-auto' } })
    )

    rewindAndApply(db, 133)

    expect(getSetting(db, 'default_codex_flags')).toBe('--sandbox workspace-write')
    expect(getCodexModeFlags(db)).toBe('--sandbox workspace-write')

    const migrated = db.prepare('SELECT codex_flags, provider_config FROM tasks WHERE id = ?').get('t1') as {
      codex_flags: string
      provider_config: string
    }
    expect(migrated.codex_flags).toBe('--sandbox workspace-write')
    const migratedConfig = JSON.parse(migrated.provider_config) as { codex: { flags: string; conversationId: string } }
    expect(migratedConfig.codex.flags).toBe('--sandbox workspace-write --disable apps')
    expect(migratedConfig.codex.conversationId).toBe('cid')

    const custom = db.prepare('SELECT codex_flags, provider_config FROM tasks WHERE id = ?').get('t2') as {
      codex_flags: string
      provider_config: string
    }
    expect(custom.codex_flags).toBe('--custom --full-auto')
    const customConfig = JSON.parse(custom.provider_config) as { codex: { flags: string } }
    expect(customConfig.codex.flags).toBe('--custom --full-auto')
  } finally {
    db.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
