/**
 * Startup status normalization tests
 * Run with: npx tsx packages/apps/app/src/main/db/status-normalization.test.ts
 */
import Database from 'better-sqlite3'
import { DEFAULT_COLUMNS, type ColumnConfig } from '@slayzone/projects/shared'
import { runMigrations } from './migrations.js'
import { normalizeProjectStatusData } from './status-normalization.js'

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
    toBeNull() {
      if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`)
    },
    toEqual(expected: unknown) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
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

function insertProject(db: Database.Database, id: string, columnsConfig: string | null): void {
  db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(id, id, '#000000', '/tmp/test', columnsConfig)
}

function insertTask(db: Database.Database, id: string, projectId: string, status: string): void {
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, id, status, 3, 0)
}

function hasProjectColumn(db: Database.Database, columnName: string): boolean {
  const columns = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}

console.log('\nnormalizeProjectStatusData')

test('normalizes stale columns JSON and remaps unknown task statuses', () => {
  const db = createDb()
  try {
    const projectId = crypto.randomUUID()
    const customColumns: ColumnConfig[] = [
      { id: 'doing', label: 'Doing', color: 'blue', position: 4, category: 'started' },
      { id: 'queued', label: 'Queued', color: 'gray', position: 1, category: 'unstarted' },
      { id: 'done_custom', label: 'Done', color: 'green', position: 7, category: 'completed' },
    ]
    insertProject(db, projectId, JSON.stringify(customColumns))
    insertTask(db, 'task-known', projectId, 'doing')
    insertTask(db, 'task-unknown', projectId, 'not_a_real_status')

    normalizeProjectStatusData(db)

    const projectRow = db
      .prepare('SELECT columns_config FROM projects WHERE id = ?')
      .get(projectId) as { columns_config: string | null }
    const normalizedColumns = JSON.parse(projectRow.columns_config || '[]') as ColumnConfig[]
    expect(normalizedColumns).toEqual([
      { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
      { id: 'doing', label: 'Doing', color: 'blue', position: 1, category: 'started' },
      { id: 'done_custom', label: 'Done', color: 'green', position: 2, category: 'completed' },
    ])

    const statuses = db
      .prepare('SELECT id, status FROM tasks WHERE project_id = ? ORDER BY id')
      .all(projectId) as Array<{ id: string; status: string }>
    expect(statuses).toEqual([
      { id: 'task-known', status: 'doing' },
      { id: 'task-unknown', status: 'queued' },
    ])
  } finally {
    db.close()
  }
})

test('replaces invalid columns JSON with defaults and remaps unknown statuses', () => {
  const db = createDb()
  try {
    const projectId = crypto.randomUUID()
    insertProject(db, projectId, '{"invalid":true}')
    insertTask(db, 'task-invalid-columns', projectId, 'custom_unknown')

    normalizeProjectStatusData(db)

    const projectRow = db
      .prepare('SELECT columns_config FROM projects WHERE id = ?')
      .get(projectId) as { columns_config: string | null }
    expect(projectRow.columns_config).toEqual(JSON.stringify(DEFAULT_COLUMNS))

    const taskRow = db
      .prepare('SELECT status FROM tasks WHERE id = ?')
      .get('task-invalid-columns') as { status: string }
    expect(taskRow.status).toBe('inbox')
  } finally {
    db.close()
  }
})

test('keeps null columns_config as null while still remapping unknown statuses', () => {
  const db = createDb()
  try {
    const projectId = crypto.randomUUID()
    insertProject(db, projectId, null)
    insertTask(db, 'task-null-columns', projectId, 'ghost_status')

    normalizeProjectStatusData(db)

    const projectRow = db
      .prepare('SELECT columns_config FROM projects WHERE id = ?')
      .get(projectId) as { columns_config: string | null }
    expect(projectRow.columns_config).toBeNull()

    const taskRow = db
      .prepare('SELECT status FROM tasks WHERE id = ?')
      .get('task-null-columns') as { status: string }
    expect(taskRow.status).toBe('inbox')
  } finally {
    db.close()
  }
})

test('no-ops when projects.columns_config is missing', () => {
  const db = createDb()
  try {
    const projectId = crypto.randomUUID()
    insertProject(db, projectId, null)
    insertTask(db, 'task-missing-column', projectId, 'ghost_status')

    db.exec('ALTER TABLE projects DROP COLUMN columns_config')
    normalizeProjectStatusData(db)

    const taskRow = db
      .prepare('SELECT status FROM tasks WHERE id = ?')
      .get('task-missing-column') as { status: string }
    expect(taskRow.status).toBe('ghost_status')
  } finally {
    db.close()
  }
})

test('repairs drifted schema where user_version=42 but columns_config is missing', () => {
  const db = createDb(42)
  try {
    db.exec('ALTER TABLE projects DROP COLUMN columns_config')
    expect(hasProjectColumn(db, 'columns_config')).toBe(false)

    db.pragma('user_version = 42')
    runMigrations(db)

    expect(hasProjectColumn(db, 'columns_config')).toBe(true)
  } finally {
    db.close()
  }
})

test('handles drift where user_version=41 but columns_config already exists', () => {
  const db = createDb(42)
  try {
    expect(hasProjectColumn(db, 'columns_config')).toBe(true)

    db.pragma('user_version = 41')
    runMigrations(db)

    expect(hasProjectColumn(db, 'columns_config')).toBe(true)
  } finally {
    db.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
