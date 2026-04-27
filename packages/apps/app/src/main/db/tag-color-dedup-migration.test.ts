/**
 * v123 — tag color dedup + uniqueness migration tests
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm packages/apps/app/src/main/db/tag-color-dedup-migration.test.ts
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
    toBeFalsy() {
      if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`)
    },
  }
}

function freshDbAt122(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // Run all migrations first to get full schema, then roll back the unique
  // index from v123 so we can seed collisions and re-run v123.
  runMigrations(db)
  db.exec('DROP INDEX IF EXISTS tags_project_color_unique')
  db.pragma('user_version = 122')
  return db
}

function seedProject(db: Database.Database, id: string): void {
  db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(id, `P-${id}`, '#000000')
}

function insertTag(
  db: Database.Database,
  args: { id: string; projectId: string; name: string; color: string; textColor?: string; createdAt?: string }
): void {
  db.prepare(
    `INSERT INTO tags (id, project_id, name, color, text_color, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    args.id,
    args.projectId,
    args.name,
    args.color,
    args.textColor ?? '#ffffff',
    0,
    args.createdAt ?? new Date().toISOString()
  )
}

function getTag(db: Database.Database, id: string) {
  return db.prepare('SELECT id, color, text_color FROM tags WHERE id = ?').get(id) as
    | { id: string; color: string; text_color: string }
    | undefined
}

function indexExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?`).get(name)
  return !!row
}

// Snapshot of v123's TAG_PRESETS — duplicated here intentionally so tests
// stay decoupled from any future preset edits.
const PRESET_PAIRS = new Set<string>([
  '#fecaca:#991b1b', '#ef4444:#ffffff', '#991b1b:#fecaca',
  '#fed7aa:#9a3412', '#f97316:#ffffff', '#9a3412:#fed7aa',
  '#fef08a:#854d0e', '#eab308:#422006', '#854d0e:#fef9c3',
  '#bbf7d0:#166534', '#22c55e:#ffffff', '#166534:#bbf7d0',
  '#99f6e4:#115e59', '#14b8a6:#ffffff', '#115e59:#ccfbf1',
  '#bfdbfe:#1e3a8a', '#3b82f6:#ffffff', '#1e3a8a:#bfdbfe',
  '#c7d2fe:#3730a3', '#6366f1:#ffffff', '#3730a3:#c7d2fe',
  '#ddd6fe:#5b21b6', '#a855f7:#ffffff', '#5b21b6:#ede9fe',
  '#fbcfe8:#9d174d', '#ec4899:#ffffff', '#9d174d:#fce7f3',
  '#e5e7eb:#1f2937', '#6b7280:#ffffff', '#374151:#e5e7eb',
])

function isPresetPair(bg: string, text: string): boolean {
  return PRESET_PAIRS.has(`${bg}:${text}`)
}

console.log('\nv123 tag color dedup migration')

test('reassigns newer duplicate to next free preset, keeps oldest', () => {
  const db = freshDbAt122()
  try {
    const projectId = 'p1'
    seedProject(db, projectId)
    insertTag(db, { id: 'a', projectId, name: 'old', color: '#22c55e', textColor: '#ffffff', createdAt: '2024-01-01' })
    insertTag(db, { id: 'b', projectId, name: 'new', color: '#22c55e', textColor: '#ffffff', createdAt: '2024-02-01' })

    runMigrations(db)

    expect(getTag(db, 'a')?.color).toBe('#22c55e')
    expect(getTag(db, 'a')?.text_color).toBe('#ffffff')
    const newTag = getTag(db, 'b')
    if (!newTag) throw new Error('tag b missing')
    if (newTag.color === '#22c55e' && newTag.text_color === '#ffffff') {
      throw new Error('tag b not reassigned (still on original color pair)')
    }
    // reassigned tag must land on a preset pair (both bg and text from same preset)
    expect(isPresetPair(newTag.color, newTag.text_color)).toBe(true)
    expect(indexExists(db, 'tags_project_color_unique')).toBe(true)
  } finally {
    db.close()
  }
})

test('migrates custom (non-preset) colors to nearest preset', () => {
  const db = freshDbAt122()
  try {
    const projectId = 'p2'
    seedProject(db, projectId)
    // custom orange w/ black text — bg matches preset #f97316 but text_color
    // (#000000) does not. Migration must replace BOTH to land on preset pair.
    insertTag(db, { id: 'r', projectId, name: 'orange', color: '#f97316', textColor: '#000000' })

    runMigrations(db)

    const tag = getTag(db, 'r')
    if (!tag) throw new Error('tag missing')
    expect(isPresetPair(tag.color, tag.text_color)).toBe(true)
    // nearest by RGB to #f97316 is #f97316 itself
    expect(tag.color).toBe('#f97316')
    expect(tag.text_color).toBe('#ffffff')
  } finally {
    db.close()
  }
})

test('same color across different projects is allowed', () => {
  const db = freshDbAt122()
  try {
    seedProject(db, 'pa')
    seedProject(db, 'pb')
    insertTag(db, { id: 'a', projectId: 'pa', name: 'g', color: '#22c55e' })
    insertTag(db, { id: 'b', projectId: 'pb', name: 'g', color: '#22c55e' })

    runMigrations(db)

    expect(getTag(db, 'a')?.color).toBe('#22c55e')
    expect(getTag(db, 'b')?.color).toBe('#22c55e')
    expect(indexExists(db, 'tags_project_color_unique')).toBe(true)
  } finally {
    db.close()
  }
})

test('unique index blocks post-migration duplicate insert', () => {
  const db = freshDbAt122()
  try {
    seedProject(db, 'p3')
    insertTag(db, { id: 't1', projectId: 'p3', name: 'first', color: '#3b82f6' })

    runMigrations(db)

    let threw = false
    try {
      insertTag(db, { id: 't2', projectId: 'p3', name: 'second', color: '#3b82f6' })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  } finally {
    db.close()
  }
})

test('idempotent — second run is no-op', () => {
  const db = freshDbAt122()
  try {
    seedProject(db, 'p4')
    insertTag(db, { id: 'x', projectId: 'p4', name: 'x', color: '#22c55e' })
    runMigrations(db)
    runMigrations(db) // should not throw or duplicate work
    expect(indexExists(db, 'tags_project_color_unique')).toBe(true)
  } finally {
    db.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
