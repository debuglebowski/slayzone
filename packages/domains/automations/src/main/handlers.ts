import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type { CreateAutomationInput, UpdateAutomationInput, AutomationRow } from '@slayzone/automations/shared'
import { parseAutomationRow } from '@slayzone/automations/shared'
import type { AutomationEngine } from './engine'

function safeParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

export function registerAutomationHandlers(ipcMain: IpcMain, db: Database, engine: AutomationEngine): void {

  ipcMain.handle('db:automations:getByProject', (_, projectId: string) => {
    const rows = db.prepare('SELECT * FROM automations WHERE project_id = ? ORDER BY sort_order, created_at').all(projectId) as AutomationRow[]
    return rows.map(parseAutomationRow)
  })

  ipcMain.handle('db:automations:get', (_, id: string) => {
    const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as AutomationRow | undefined
    return row ? parseAutomationRow(row) : null
  })

  ipcMain.handle('db:automations:create', (_, data: CreateAutomationInput) => {
    const id = crypto.randomUUID()
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM automations WHERE project_id = ?').get(data.project_id) as { m: number }
    db.prepare(
      `INSERT INTO automations (id, project_id, name, description, trigger_config, conditions, actions, sort_order, catchup_on_start)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      data.project_id,
      data.name,
      data.description ?? null,
      JSON.stringify(data.trigger_config),
      JSON.stringify(data.conditions ?? []),
      JSON.stringify(data.actions),
      maxOrder.m + 1,
      data.catchup_on_start === false ? 0 : 1
    )
    const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as AutomationRow
    return parseAutomationRow(row)
  })

  ipcMain.handle('db:automations:update', (_, data: UpdateAutomationInput) => {
    const fields: string[] = []
    const values: unknown[] = []

    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name) }
    if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description) }
    if (data.enabled !== undefined) { fields.push('enabled = ?'); values.push(data.enabled ? 1 : 0) }
    if (data.trigger_config !== undefined) { fields.push('trigger_config = ?'); values.push(JSON.stringify(data.trigger_config)) }
    if (data.conditions !== undefined) { fields.push('conditions = ?'); values.push(JSON.stringify(data.conditions)) }
    if (data.actions !== undefined) { fields.push('actions = ?'); values.push(JSON.stringify(data.actions)) }
    if (data.sort_order !== undefined) { fields.push('sort_order = ?'); values.push(data.sort_order) }
    if (data.catchup_on_start !== undefined) { fields.push('catchup_on_start = ?'); values.push(data.catchup_on_start ? 1 : 0) }

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')")
      values.push(data.id)
      db.prepare(`UPDATE automations SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }

    const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(data.id) as AutomationRow
    return parseAutomationRow(row)
  })

  ipcMain.handle('db:automations:delete', (_, id: string) => {
    const result = db.prepare('DELETE FROM automations WHERE id = ?').run(id)
    return result.changes > 0
  })

  ipcMain.handle('db:automations:toggle', (_, id: string, enabled: boolean) => {
    db.prepare("UPDATE automations SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(enabled ? 1 : 0, id)
    const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as AutomationRow
    return parseAutomationRow(row)
  })

  ipcMain.handle('db:automations:reorder', (_, ids: string[]) => {
    const stmt = db.prepare('UPDATE automations SET sort_order = ? WHERE id = ?')
    db.transaction(() => {
      for (let i = 0; i < ids.length; i++) {
        stmt.run(i, ids[i])
      }
    })()
  })

  ipcMain.handle('db:automations:getRuns', (_, automationId: string, limit?: number) => {
    const rows = db.prepare(
      'SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?'
    ).all(automationId, limit ?? 50) as Array<{ trigger_event: string | null } & Record<string, unknown>>
    return rows.map(row => ({
      ...row,
      trigger_event: row.trigger_event ? safeParse(row.trigger_event) : null,
    }))
  })

  ipcMain.handle('db:automations:runManual', async (_, id: string) => {
    return engine.executeManual(id)
  })

  ipcMain.handle('db:automations:clearRuns', (_, automationId: string) => {
    db.prepare('DELETE FROM automation_runs WHERE automation_id = ?').run(automationId)
  })
}
