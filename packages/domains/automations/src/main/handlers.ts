import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import type {
  CreateAutomationInput,
  UpdateAutomationInput,
  AutomationRow
} from '@slayzone/automations/shared'
import { parseAutomationRow } from '@slayzone/automations/shared'
import type { AutomationEngine } from './engine'

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export function registerAutomationHandlers(
  ipcMain: IpcMain,
  db: SlayzoneDb,
  engine: AutomationEngine
): void {
  ipcMain.handle('db:automations:getByProject', async (_, projectId: string) => {
    const rows = await db.all<AutomationRow>(
      'SELECT * FROM automations WHERE project_id = ? ORDER BY sort_order, created_at',
      [projectId]
    )
    return rows.map(parseAutomationRow)
  })

  ipcMain.handle('db:automations:get', async (_, id: string) => {
    const row = await db.get<AutomationRow>('SELECT * FROM automations WHERE id = ?', [id])
    return row ? parseAutomationRow(row) : null
  })

  ipcMain.handle('db:automations:create', async (_, data: CreateAutomationInput) => {
    const id = crypto.randomUUID()
    const row = await db.namedTxn<AutomationRow>('automations:create', {
      id,
      projectId: data.project_id,
      name: data.name,
      description: data.description ?? null,
      triggerConfig: JSON.stringify(data.trigger_config),
      conditions: JSON.stringify(data.conditions ?? []),
      actions: JSON.stringify(data.actions),
      catchupOnStart: data.catchup_on_start === false ? 0 : 1
    })
    return parseAutomationRow(row)
  })

  ipcMain.handle('db:automations:update', async (_, data: UpdateAutomationInput) => {
    const fields: string[] = []
    const values: unknown[] = []

    if (data.name !== undefined) {
      fields.push('name = ?')
      values.push(data.name)
    }
    if (data.description !== undefined) {
      fields.push('description = ?')
      values.push(data.description)
    }
    if (data.enabled !== undefined) {
      fields.push('enabled = ?')
      values.push(data.enabled ? 1 : 0)
    }
    if (data.trigger_config !== undefined) {
      fields.push('trigger_config = ?')
      values.push(JSON.stringify(data.trigger_config))
    }
    if (data.conditions !== undefined) {
      fields.push('conditions = ?')
      values.push(JSON.stringify(data.conditions))
    }
    if (data.actions !== undefined) {
      fields.push('actions = ?')
      values.push(JSON.stringify(data.actions))
    }
    if (data.sort_order !== undefined) {
      fields.push('sort_order = ?')
      values.push(data.sort_order)
    }
    if (data.catchup_on_start !== undefined) {
      fields.push('catchup_on_start = ?')
      values.push(data.catchup_on_start ? 1 : 0)
    }

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')")
      values.push(data.id)
      await db.run(`UPDATE automations SET ${fields.join(', ')} WHERE id = ?`, values)
    }

    const row = (await db.get<AutomationRow>('SELECT * FROM automations WHERE id = ?', [
      data.id
    ])) as AutomationRow
    return parseAutomationRow(row)
  })

  ipcMain.handle('db:automations:delete', async (_, id: string) => {
    const result = await db.run('DELETE FROM automations WHERE id = ?', [id])
    return result.changes > 0
  })

  ipcMain.handle('db:automations:toggle', async (_, id: string, enabled: boolean) => {
    await db.run("UPDATE automations SET enabled = ?, updated_at = datetime('now') WHERE id = ?", [
      enabled ? 1 : 0,
      id
    ])
    const row = (await db.get<AutomationRow>('SELECT * FROM automations WHERE id = ?', [
      id
    ])) as AutomationRow
    return parseAutomationRow(row)
  })

  ipcMain.handle('db:automations:reorder', async (_, ids: string[]) => {
    await db.batchTxn(
      ids.map((id, i) => ({
        type: 'run' as const,
        sql: 'UPDATE automations SET sort_order = ? WHERE id = ?',
        params: [i, id]
      }))
    )
  })

  ipcMain.handle('db:automations:getRuns', async (_, automationId: string, limit?: number) => {
    const rows = await db.all<{ trigger_event: string | null } & Record<string, unknown>>(
      'SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?',
      [automationId, limit ?? 50]
    )
    return rows.map((row) => ({
      ...row,
      trigger_event: row.trigger_event ? safeParse(row.trigger_event) : null
    }))
  })

  ipcMain.handle('db:automations:runManual', async (_, id: string) => {
    return engine.executeManual(id)
  })

  ipcMain.handle('db:automations:clearRuns', async (_, automationId: string) => {
    await db.run('DELETE FROM automation_runs WHERE automation_id = ?', [automationId])
  })
}
