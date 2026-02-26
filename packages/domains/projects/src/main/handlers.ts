import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type { CreateProjectInput, UpdateProjectInput } from '@slayzone/projects/shared'

export function registerProjectHandlers(ipcMain: IpcMain, db: Database): void {

  ipcMain.handle('db:projects:getAll', () => {
    return db.prepare('SELECT * FROM projects ORDER BY name').all()
  })

  ipcMain.handle('db:projects:create', (_, data: CreateProjectInput) => {
    const id = crypto.randomUUID()
    const stmt = db.prepare(`
      INSERT INTO projects (id, name, color, path)
      VALUES (?, ?, ?, ?)
    `)
    stmt.run(id, data.name, data.color, data.path ?? null)
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
  })

  ipcMain.handle('db:projects:update', (_, data: UpdateProjectInput) => {
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
    if (data.path !== undefined) {
      fields.push('path = ?')
      values.push(data.path)
    }
    if (data.autoCreateWorktreeOnTaskCreate !== undefined) {
      fields.push('auto_create_worktree_on_task_create = ?')
      if (data.autoCreateWorktreeOnTaskCreate === null) {
        values.push(null)
      } else {
        values.push(data.autoCreateWorktreeOnTaskCreate ? 1 : 0)
      }
    }
    if (data.worktreeSourceBranch !== undefined) {
      fields.push('worktree_source_branch = ?')
      values.push(data.worktreeSourceBranch === '' ? null : data.worktreeSourceBranch)
    }

    if (fields.length === 0) {
      return db.prepare('SELECT * FROM projects WHERE id = ?').get(data.id)
    }

    fields.push("updated_at = datetime('now')")
    values.push(data.id)

    db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(data.id)
  })

  ipcMain.handle('db:projects:delete', (_, id: string) => {
    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    return result.changes > 0
  })
}
