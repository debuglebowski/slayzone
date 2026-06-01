import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import type {
  CreateTestCategoryInput,
  UpdateTestCategoryInput,
  TestCategory,
  TestProfile,
  CreateTestLabelInput,
  UpdateTestLabelInput
} from '../shared/types'
import { DEFAULT_PROFILES } from '../shared/types'
import { scanTestFiles } from './scanner'

export function registerTestPanelHandlers(ipcMain: IpcMain, db: SlayzoneDb): void {
  // Categories CRUD

  ipcMain.handle('db:testPanel:getCategories', async (_, projectId: string) => {
    return db.all(
      'SELECT * FROM test_categories WHERE project_id = ? ORDER BY sort_order, created_at',
      [projectId]
    )
  })

  ipcMain.handle('db:testPanel:createCategory', async (_, data: CreateTestCategoryInput) => {
    const id = crypto.randomUUID()
    const maxOrder = (await db.get(
      'SELECT COALESCE(MAX(sort_order), -1) as m FROM test_categories WHERE project_id = ?',
      [data.project_id]
    )) as { m: number }
    await db.run(
      'INSERT INTO test_categories (id, project_id, name, pattern, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [id, data.project_id, data.name, data.pattern, data.color ?? '#6b7280', maxOrder.m + 1]
    )
    return db.get('SELECT * FROM test_categories WHERE id = ?', [id])
  })

  ipcMain.handle('db:testPanel:updateCategory', async (_, data: UpdateTestCategoryInput) => {
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

    return db.get('SELECT * FROM test_categories WHERE id = ?', [data.id])
  })

  ipcMain.handle('db:testPanel:deleteCategory', async (_, id: string) => {
    const result = await db.run('DELETE FROM test_categories WHERE id = ?', [id])
    return result.changes > 0
  })

  ipcMain.handle('db:testPanel:reorderCategories', async (_, ids: string[]) => {
    await db.batchTxn(
      ids.map((id, i) => ({
        type: 'run' as const,
        sql: 'UPDATE test_categories SET sort_order = ? WHERE id = ?',
        params: [i, id]
      }))
    )
  })

  // Profiles (stored in settings key-value table)

  ipcMain.handle('db:testPanel:getProfiles', async () => {
    const row = (await db.get("SELECT value FROM settings WHERE key = 'test_profiles'")) as
      | { value: string }
      | undefined
    let userProfiles: TestProfile[] = []
    if (row) {
      try {
        userProfiles = JSON.parse(row.value)
      } catch {
        /* ignore */
      }
    }
    return [...DEFAULT_PROFILES, ...userProfiles]
  })

  ipcMain.handle('db:testPanel:saveProfile', async (_, profile: TestProfile) => {
    const row = (await db.get("SELECT value FROM settings WHERE key = 'test_profiles'")) as
      | { value: string }
      | undefined
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
  })

  ipcMain.handle('db:testPanel:deleteProfile', async (_, id: string) => {
    const row = (await db.get("SELECT value FROM settings WHERE key = 'test_profiles'")) as
      | { value: string }
      | undefined
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
  })

  ipcMain.handle('db:testPanel:applyProfile', async (_, projectId: string, profileId: string) => {
    // Check built-in profiles first
    let profile: TestProfile | undefined = DEFAULT_PROFILES.find((p) => p.id === profileId)

    if (!profile) {
      const row = (await db.get("SELECT value FROM settings WHERE key = 'test_profiles'")) as
        | { value: string }
        | undefined
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

    return db.all('SELECT * FROM test_categories WHERE project_id = ? ORDER BY sort_order', [
      projectId
    ])
  })

  // File scanning

  ipcMain.handle('db:testPanel:scanFiles', async (_, projectPath: string, projectId: string) => {
    const categories = (await db.all(
      'SELECT * FROM test_categories WHERE project_id = ? ORDER BY sort_order',
      [projectId]
    )) as TestCategory[]
    return scanTestFiles(projectPath, categories)
  })

  // Labels CRUD

  ipcMain.handle('db:testPanel:getLabels', async (_, projectId: string) => {
    return db.all('SELECT * FROM test_labels WHERE project_id = ? ORDER BY sort_order, rowid', [
      projectId
    ])
  })

  ipcMain.handle('db:testPanel:createLabel', async (_, data: CreateTestLabelInput) => {
    const id = crypto.randomUUID()
    const maxOrder = (await db.get(
      'SELECT COALESCE(MAX(sort_order), -1) as m FROM test_labels WHERE project_id = ?',
      [data.project_id]
    )) as { m: number }
    await db.run(
      'INSERT INTO test_labels (id, project_id, name, color, sort_order) VALUES (?, ?, ?, ?, ?)',
      [id, data.project_id, data.name, data.color ?? '#6b7280', maxOrder.m + 1]
    )
    return db.get('SELECT * FROM test_labels WHERE id = ?', [id])
  })

  ipcMain.handle('db:testPanel:updateLabel', async (_, data: UpdateTestLabelInput) => {
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
    return db.get('SELECT * FROM test_labels WHERE id = ?', [data.id])
  })

  ipcMain.handle('db:testPanel:deleteLabel', async (_, id: string) => {
    const result = await db.run('DELETE FROM test_labels WHERE id = ?', [id])
    return result.changes > 0
  })

  // File label assignments

  ipcMain.handle('db:testPanel:getFileLabels', async (_, projectId: string) => {
    return db.all('SELECT * FROM test_file_labels WHERE project_id = ?', [projectId])
  })

  // File notes

  ipcMain.handle('db:testPanel:getFileNotes', async (_, projectId: string) => {
    return db.all('SELECT * FROM test_file_notes WHERE project_id = ?', [projectId])
  })

  ipcMain.handle(
    'db:testPanel:setFileNote',
    async (_, projectId: string, filePath: string, note: string) => {
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
  )

  ipcMain.handle(
    'db:testPanel:toggleFileLabel',
    async (_, projectId: string, filePath: string, labelId: string) => {
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
        await db.run(
          'INSERT INTO test_file_labels (project_id, file_path, label_id) VALUES (?, ?, ?)',
          [projectId, filePath, labelId]
        )
      }
    }
  )
}
