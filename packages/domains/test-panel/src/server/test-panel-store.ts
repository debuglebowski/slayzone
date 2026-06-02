import type { SlayzoneDb } from '@slayzone/platform'
import type {
  CreateTestCategoryInput,
  UpdateTestCategoryInput,
  TestCategory,
  TestProfile,
  CreateTestLabelInput,
  UpdateTestLabelInput,
  TestLabel,
  TestFileLabel,
  TestFileNote
} from '../shared/types'
import { DEFAULT_PROFILES } from '../shared/types'

/**
 * Pure, electron-free DB ops for the test-panel domain. Shared by the
 * `db:testPanel:*` IPC handlers (src/main/handlers.ts) and the tRPC
 * `testPanelRouter` (transport) so both speak to one implementation during the
 * IPC→tRPC migration. Built on the async `SlayzoneDb` proxy — mirrors the sync
 * store from ref 01fce2b1, reworked for main's worker-thread DB. Profiles live
 * in the `settings` key-value row `test_profiles`; built-ins come from
 * DEFAULT_PROFILES. `scanTestFiles` lives in ./scanner (composed by the router).
 */

// --- Categories ---

export async function listCategories(db: SlayzoneDb, projectId: string): Promise<TestCategory[]> {
  return db.all<TestCategory>(
    'SELECT * FROM test_categories WHERE project_id = ? ORDER BY sort_order, created_at',
    [projectId]
  )
}

export async function createCategory(
  db: SlayzoneDb,
  data: CreateTestCategoryInput
): Promise<TestCategory> {
  const id = crypto.randomUUID()
  const maxOrder = (await db.get<{ m: number }>(
    'SELECT COALESCE(MAX(sort_order), -1) as m FROM test_categories WHERE project_id = ?',
    [data.project_id]
  )) as { m: number }
  await db.run(
    'INSERT INTO test_categories (id, project_id, name, pattern, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [id, data.project_id, data.name, data.pattern, data.color ?? '#6b7280', maxOrder.m + 1]
  )
  return (await db.get<TestCategory>('SELECT * FROM test_categories WHERE id = ?', [
    id
  ])) as TestCategory
}

export async function updateCategory(
  db: SlayzoneDb,
  data: UpdateTestCategoryInput
): Promise<TestCategory> {
  const fields: string[] = []
  const values: unknown[] = []
  if (data.name !== undefined) {
    fields.push('name = ?')
    values.push(data.name)
  }
  if (data.pattern !== undefined) {
    fields.push('pattern = ?')
    values.push(data.pattern)
  }
  if (data.color !== undefined) {
    fields.push('color = ?')
    values.push(data.color)
  }
  if (data.sort_order !== undefined) {
    fields.push('sort_order = ?')
    values.push(data.sort_order)
  }
  if (fields.length > 0) {
    values.push(data.id)
    await db.run(`UPDATE test_categories SET ${fields.join(', ')} WHERE id = ?`, values)
  }
  return (await db.get<TestCategory>('SELECT * FROM test_categories WHERE id = ?', [
    data.id
  ])) as TestCategory
}

export async function deleteCategory(db: SlayzoneDb, id: string): Promise<boolean> {
  const result = await db.run('DELETE FROM test_categories WHERE id = ?', [id])
  return result.changes > 0
}

export async function reorderCategories(db: SlayzoneDb, ids: string[]): Promise<void> {
  await db.batchTxn(
    ids.map((id, i) => ({
      type: 'run' as const,
      sql: 'UPDATE test_categories SET sort_order = ? WHERE id = ?',
      params: [i, id]
    }))
  )
}

// --- Profiles (stored in settings key-value table) ---

export async function listProfiles(db: SlayzoneDb): Promise<TestProfile[]> {
  const row = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'test_profiles'")
  let userProfiles: TestProfile[] = []
  if (row) {
    try {
      userProfiles = JSON.parse(row.value)
    } catch {
      /* ignore */
    }
  }
  return [...DEFAULT_PROFILES, ...userProfiles]
}

export async function saveProfile(db: SlayzoneDb, profile: TestProfile): Promise<void> {
  const row = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'test_profiles'")
  let profiles: TestProfile[] = []
  if (row) {
    try {
      profiles = JSON.parse(row.value)
    } catch {
      /* ignore */
    }
  }
  const idx = profiles.findIndex((p) => p.id === profile.id)
  if (idx >= 0) profiles[idx] = profile
  else profiles.push(profile)
  await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('test_profiles', ?)", [
    JSON.stringify(profiles)
  ])
}

export async function deleteProfile(db: SlayzoneDb, id: string): Promise<void> {
  const row = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'test_profiles'")
  if (!row) return
  let profiles: TestProfile[] = []
  try {
    profiles = JSON.parse(row.value)
  } catch {
    return
  }
  profiles = profiles.filter((p) => p.id !== id)
  await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('test_profiles', ?)", [
    JSON.stringify(profiles)
  ])
}

export async function applyProfile(
  db: SlayzoneDb,
  projectId: string,
  profileId: string
): Promise<TestCategory[]> {
  // Check built-in profiles first
  let profile: TestProfile | undefined = DEFAULT_PROFILES.find((p) => p.id === profileId)

  if (!profile) {
    const row = await db.get<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'test_profiles'"
    )
    if (!row) return []
    let profiles: TestProfile[] = []
    try {
      profiles = JSON.parse(row.value)
    } catch {
      return []
    }
    profile = profiles.find((p) => p.id === profileId)
  }

  if (!profile) return []

  await db.batchTxn([
    {
      type: 'run',
      sql: 'DELETE FROM test_categories WHERE project_id = ?',
      params: [projectId]
    },
    ...profile.categories.map((c, i) => ({
      type: 'run' as const,
      sql: 'INSERT INTO test_categories (id, project_id, name, pattern, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      params: [crypto.randomUUID(), projectId, c.name, c.pattern, c.color, i]
    }))
  ])

  return db.all<TestCategory>(
    'SELECT * FROM test_categories WHERE project_id = ? ORDER BY sort_order',
    [projectId]
  )
}

// --- Labels ---

export async function listLabels(db: SlayzoneDb, projectId: string): Promise<TestLabel[]> {
  return db.all<TestLabel>(
    'SELECT * FROM test_labels WHERE project_id = ? ORDER BY sort_order, rowid',
    [projectId]
  )
}

export async function createLabel(db: SlayzoneDb, data: CreateTestLabelInput): Promise<TestLabel> {
  const id = crypto.randomUUID()
  const maxOrder = (await db.get<{ m: number }>(
    'SELECT COALESCE(MAX(sort_order), -1) as m FROM test_labels WHERE project_id = ?',
    [data.project_id]
  )) as { m: number }
  await db.run(
    'INSERT INTO test_labels (id, project_id, name, color, sort_order) VALUES (?, ?, ?, ?, ?)',
    [id, data.project_id, data.name, data.color ?? '#6b7280', maxOrder.m + 1]
  )
  return (await db.get<TestLabel>('SELECT * FROM test_labels WHERE id = ?', [id])) as TestLabel
}

export async function updateLabel(db: SlayzoneDb, data: UpdateTestLabelInput): Promise<TestLabel> {
  const fields: string[] = []
  const values: unknown[] = []
  if (data.name !== undefined) {
    fields.push('name = ?')
    values.push(data.name)
  }
  if (data.color !== undefined) {
    fields.push('color = ?')
    values.push(data.color)
  }
  if (data.sort_order !== undefined) {
    fields.push('sort_order = ?')
    values.push(data.sort_order)
  }
  if (fields.length > 0) {
    values.push(data.id)
    await db.run(`UPDATE test_labels SET ${fields.join(', ')} WHERE id = ?`, values)
  }
  return (await db.get<TestLabel>('SELECT * FROM test_labels WHERE id = ?', [data.id])) as TestLabel
}

export async function deleteLabel(db: SlayzoneDb, id: string): Promise<boolean> {
  const result = await db.run('DELETE FROM test_labels WHERE id = ?', [id])
  return result.changes > 0
}

// --- File labels + notes ---

export async function listFileLabels(db: SlayzoneDb, projectId: string): Promise<TestFileLabel[]> {
  return db.all<TestFileLabel>('SELECT * FROM test_file_labels WHERE project_id = ?', [projectId])
}

export async function listFileNotes(db: SlayzoneDb, projectId: string): Promise<TestFileNote[]> {
  return db.all<TestFileNote>('SELECT * FROM test_file_notes WHERE project_id = ?', [projectId])
}

export async function setFileNote(
  db: SlayzoneDb,
  projectId: string,
  filePath: string,
  note: string
): Promise<void> {
  if (note.trim() === '') {
    await db.run('DELETE FROM test_file_notes WHERE project_id = ? AND file_path = ?', [
      projectId,
      filePath
    ])
  } else {
    await db.run(
      'INSERT OR REPLACE INTO test_file_notes (project_id, file_path, note) VALUES (?, ?, ?)',
      [projectId, filePath, note]
    )
  }
}

export async function toggleFileLabel(
  db: SlayzoneDb,
  projectId: string,
  filePath: string,
  labelId: string
): Promise<void> {
  const existing = await db.get(
    'SELECT 1 FROM test_file_labels WHERE project_id = ? AND file_path = ? AND label_id = ?',
    [projectId, filePath, labelId]
  )
  if (existing) {
    await db.run(
      'DELETE FROM test_file_labels WHERE project_id = ? AND file_path = ? AND label_id = ?',
      [projectId, filePath, labelId]
    )
  } else {
    await db.run('INSERT INTO test_file_labels (project_id, file_path, label_id) VALUES (?, ?, ?)', [
      projectId,
      filePath,
      labelId
    ])
  }
}
