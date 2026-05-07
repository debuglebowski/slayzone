import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type {
  CreateTestCategoryInput,
  UpdateTestCategoryInput,
  TestCategory,
  TestProfile,
  CreateTestLabelInput,
  UpdateTestLabelInput,
  TestLabel,
  TestFileLabel,
  TestFileNote,
} from '../shared/types'
import { DEFAULT_PROFILES } from '../shared/types'

// --- Categories ---

export function listCategories(db: Database, projectId: string): TestCategory[] {
  return db
    .prepare('SELECT * FROM test_categories WHERE project_id = ? ORDER BY sort_order, created_at')
    .all(projectId) as TestCategory[]
}

export function createCategory(db: Database, data: CreateTestCategoryInput): TestCategory {
  const id = randomUUID()
  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM test_categories WHERE project_id = ?')
    .get(data.project_id) as { m: number }
  db.prepare(
    'INSERT INTO test_categories (id, project_id, name, pattern, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    data.project_id,
    data.name,
    data.pattern,
    data.color ?? '#6b7280',
    maxOrder.m + 1,
  )
  return db.prepare('SELECT * FROM test_categories WHERE id = ?').get(id) as TestCategory
}

export function updateCategory(db: Database, data: UpdateTestCategoryInput): TestCategory {
  const fields: string[] = []
  const values: unknown[] = []
  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name) }
  if (data.pattern !== undefined) { fields.push('pattern = ?'); values.push(data.pattern) }
  if (data.color !== undefined) { fields.push('color = ?'); values.push(data.color) }
  if (data.sort_order !== undefined) { fields.push('sort_order = ?'); values.push(data.sort_order) }
  if (fields.length > 0) {
    values.push(data.id)
    db.prepare(`UPDATE test_categories SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }
  return db.prepare('SELECT * FROM test_categories WHERE id = ?').get(data.id) as TestCategory
}

export function deleteCategory(db: Database, id: string): boolean {
  return db.prepare('DELETE FROM test_categories WHERE id = ?').run(id).changes > 0
}

export function reorderCategories(db: Database, ids: string[]): void {
  const stmt = db.prepare('UPDATE test_categories SET sort_order = ? WHERE id = ?')
  db.transaction(() => {
    for (let i = 0; i < ids.length; i++) stmt.run(i, ids[i])
  })()
}

// --- Profiles ---

export function listProfiles(db: Database): TestProfile[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'test_profiles'").get() as { value: string } | undefined
  let userProfiles: TestProfile[] = []
  if (row) { try { userProfiles = JSON.parse(row.value) } catch { /* ignore */ } }
  return [...DEFAULT_PROFILES, ...userProfiles]
}

export function saveProfile(db: Database, profile: TestProfile): void {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'test_profiles'").get() as { value: string } | undefined
  let profiles: TestProfile[] = []
  if (row) { try { profiles = JSON.parse(row.value) } catch { /* ignore */ } }
  const idx = profiles.findIndex((p) => p.id === profile.id)
  if (idx >= 0) profiles[idx] = profile
  else profiles.push(profile)
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('test_profiles', ?)").run(JSON.stringify(profiles))
}

export function deleteProfile(db: Database, id: string): void {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'test_profiles'").get() as { value: string } | undefined
  if (!row) return
  let profiles: TestProfile[] = []
  try { profiles = JSON.parse(row.value) } catch { return }
  profiles = profiles.filter((p) => p.id !== id)
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('test_profiles', ?)").run(JSON.stringify(profiles))
}

export function applyProfile(db: Database, projectId: string, profileId: string): TestCategory[] {
  let profile: TestProfile | undefined = DEFAULT_PROFILES.find((p) => p.id === profileId)
  if (!profile) {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'test_profiles'").get() as { value: string } | undefined
    if (!row) return []
    let profiles: TestProfile[] = []
    try { profiles = JSON.parse(row.value) } catch { return [] }
    profile = profiles.find((p) => p.id === profileId)
  }
  if (!profile) return []

  db.transaction(() => {
    db.prepare('DELETE FROM test_categories WHERE project_id = ?').run(projectId)
    const stmt = db.prepare('INSERT INTO test_categories (id, project_id, name, pattern, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
    profile!.categories.forEach((c, i) => {
      stmt.run(randomUUID(), projectId, c.name, c.pattern, c.color, i)
    })
  })()
  return db.prepare('SELECT * FROM test_categories WHERE project_id = ? ORDER BY sort_order').all(projectId) as TestCategory[]
}

// --- Labels ---

export function listLabels(db: Database, projectId: string): TestLabel[] {
  return db.prepare('SELECT * FROM test_labels WHERE project_id = ? ORDER BY sort_order, rowid').all(projectId) as TestLabel[]
}

export function createLabel(db: Database, data: CreateTestLabelInput): TestLabel {
  const id = randomUUID()
  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM test_labels WHERE project_id = ?')
    .get(data.project_id) as { m: number }
  db.prepare('INSERT INTO test_labels (id, project_id, name, color, sort_order) VALUES (?, ?, ?, ?, ?)').run(
    id,
    data.project_id,
    data.name,
    data.color ?? '#6b7280',
    maxOrder.m + 1,
  )
  return db.prepare('SELECT * FROM test_labels WHERE id = ?').get(id) as TestLabel
}

export function updateLabel(db: Database, data: UpdateTestLabelInput): TestLabel {
  const fields: string[] = []
  const values: unknown[] = []
  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name) }
  if (data.color !== undefined) { fields.push('color = ?'); values.push(data.color) }
  if (data.sort_order !== undefined) { fields.push('sort_order = ?'); values.push(data.sort_order) }
  if (fields.length > 0) {
    values.push(data.id)
    db.prepare(`UPDATE test_labels SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }
  return db.prepare('SELECT * FROM test_labels WHERE id = ?').get(data.id) as TestLabel
}

export function deleteLabel(db: Database, id: string): boolean {
  return db.prepare('DELETE FROM test_labels WHERE id = ?').run(id).changes > 0
}

// --- File labels + notes ---

export function listFileLabels(db: Database, projectId: string): TestFileLabel[] {
  return db.prepare('SELECT * FROM test_file_labels WHERE project_id = ?').all(projectId) as TestFileLabel[]
}

export function listFileNotes(db: Database, projectId: string): TestFileNote[] {
  return db.prepare('SELECT * FROM test_file_notes WHERE project_id = ?').all(projectId) as TestFileNote[]
}

export function setFileNote(db: Database, projectId: string, filePath: string, note: string): void {
  if (note.trim() === '') {
    db.prepare('DELETE FROM test_file_notes WHERE project_id = ? AND file_path = ?').run(projectId, filePath)
  } else {
    db.prepare('INSERT OR REPLACE INTO test_file_notes (project_id, file_path, note) VALUES (?, ?, ?)')
      .run(projectId, filePath, note)
  }
}

export function toggleFileLabel(db: Database, projectId: string, filePath: string, labelId: string): void {
  const existing = db
    .prepare('SELECT 1 FROM test_file_labels WHERE project_id = ? AND file_path = ? AND label_id = ?')
    .get(projectId, filePath, labelId)
  if (existing) {
    db.prepare('DELETE FROM test_file_labels WHERE project_id = ? AND file_path = ? AND label_id = ?')
      .run(projectId, filePath, labelId)
  } else {
    db.prepare('INSERT INTO test_file_labels (project_id, file_path, label_id) VALUES (?, ?, ?)')
      .run(projectId, filePath, labelId)
  }
}
