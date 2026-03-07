import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type { CreateTestCategoryInput, UpdateTestCategoryInput, TestCategory, TestProfile } from '../shared/types'
import { DEFAULT_PROFILES } from '../shared/types'
import { scanTestFiles } from './scanner'

export function registerTestPanelHandlers(ipcMain: IpcMain, db: Database): void {
  // Categories CRUD

  ipcMain.handle('db:testPanel:getCategories', (_, projectId: string) => {
    return db.prepare('SELECT * FROM test_categories WHERE project_id = ? ORDER BY sort_order, created_at').all(projectId)
  })

  ipcMain.handle('db:testPanel:createCategory', (_, data: CreateTestCategoryInput) => {
    const id = crypto.randomUUID()
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM test_categories WHERE project_id = ?').get(data.project_id) as { m: number }
    db.prepare('INSERT INTO test_categories (id, project_id, name, pattern, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      data.project_id,
      data.name,
      data.pattern,
      data.color ?? '#6b7280',
      maxOrder.m + 1
    )
    return db.prepare('SELECT * FROM test_categories WHERE id = ?').get(id)
  })

  ipcMain.handle('db:testPanel:updateCategory', (_, data: UpdateTestCategoryInput) => {
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

    return db.prepare('SELECT * FROM test_categories WHERE id = ?').get(data.id)
  })

  ipcMain.handle('db:testPanel:deleteCategory', (_, id: string) => {
    const result = db.prepare('DELETE FROM test_categories WHERE id = ?').run(id)
    return result.changes > 0
  })

  ipcMain.handle('db:testPanel:reorderCategories', (_, ids: string[]) => {
    const stmt = db.prepare('UPDATE test_categories SET sort_order = ? WHERE id = ?')
    db.transaction(() => {
      for (let i = 0; i < ids.length; i++) {
        stmt.run(i, ids[i])
      }
    })()
  })

  // Profiles (stored in settings key-value table)

  ipcMain.handle('db:testPanel:getProfiles', () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'test_profiles'").get() as { value: string } | undefined
    let userProfiles: TestProfile[] = []
    if (row) { try { userProfiles = JSON.parse(row.value) } catch { /* ignore */ } }
    return [...DEFAULT_PROFILES, ...userProfiles]
  })

  ipcMain.handle('db:testPanel:saveProfile', (_, profile: TestProfile) => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'test_profiles'").get() as { value: string } | undefined
    let profiles: TestProfile[] = []
    if (row) { try { profiles = JSON.parse(row.value) } catch { /* ignore */ } }

    const idx = profiles.findIndex((p) => p.id === profile.id)
    if (idx >= 0) profiles[idx] = profile
    else profiles.push(profile)

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('test_profiles', ?)").run(JSON.stringify(profiles))
  })

  ipcMain.handle('db:testPanel:deleteProfile', (_, id: string) => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'test_profiles'").get() as { value: string } | undefined
    if (!row) return
    let profiles: TestProfile[] = []
    try { profiles = JSON.parse(row.value) } catch { return }

    profiles = profiles.filter((p) => p.id !== id)
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('test_profiles', ?)").run(JSON.stringify(profiles))
  })

  ipcMain.handle('db:testPanel:applyProfile', (_, projectId: string, profileId: string) => {
    // Check built-in profiles first
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
      profile.categories.forEach((c, i) => {
        stmt.run(crypto.randomUUID(), projectId, c.name, c.pattern, c.color, i)
      })
    })()

    return db.prepare('SELECT * FROM test_categories WHERE project_id = ? ORDER BY sort_order').all(projectId)
  })

  // File scanning

  ipcMain.handle('db:testPanel:scanFiles', (_, projectPath: string, projectId: string) => {
    const categories = db.prepare('SELECT * FROM test_categories WHERE project_id = ? ORDER BY sort_order').all(projectId) as TestCategory[]
    return scanTestFiles(projectPath, categories)
  })
}
