import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { CreateTaskTemplateInput, UpdateTaskTemplateInput, TaskTemplate } from '../shared'
import { parseTemplate } from './template'

export function listTemplatesByProject(db: Database, projectId: string): TaskTemplate[] {
  const rows = db
    .prepare('SELECT * FROM task_templates WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC')
    .all(projectId) as Record<string, unknown>[]
  return rows.map((r) => parseTemplate(r)).filter((t): t is TaskTemplate => t !== null)
}

export function getTemplate(db: Database, id: string): TaskTemplate | null {
  const row = db.prepare('SELECT * FROM task_templates WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return parseTemplate(row)
}

export function createTemplate(db: Database, data: CreateTaskTemplateInput): TaskTemplate | null {
  const id = randomUUID()
  if (data.isDefault) {
    db.prepare('UPDATE task_templates SET is_default = 0 WHERE project_id = ? AND is_default = 1').run(data.projectId)
  }
  const maxOrder = (db
    .prepare('SELECT MAX(sort_order) as m FROM task_templates WHERE project_id = ?')
    .get(data.projectId) as { m: number | null })?.m ?? -1

  db.prepare(`
    INSERT INTO task_templates (
      id, project_id, name, description,
      terminal_mode, provider_config, panel_visibility, browser_tabs, web_panel_urls,
      dangerously_skip_permissions, ccs_profile, default_status, default_priority,
      is_default, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, data.projectId, data.name, data.description ?? null,
    data.terminalMode ?? null,
    data.providerConfig ? JSON.stringify(data.providerConfig) : null,
    data.panelVisibility ? JSON.stringify(data.panelVisibility) : null,
    data.browserTabs ? JSON.stringify(data.browserTabs) : null,
    data.webPanelUrls ? JSON.stringify(data.webPanelUrls) : null,
    data.dangerouslySkipPermissions == null ? null : (data.dangerouslySkipPermissions ? 1 : 0),
    data.ccsProfile ?? null,
    data.defaultStatus ?? null,
    data.defaultPriority ?? null,
    data.isDefault ? 1 : 0,
    maxOrder + 1,
  )
  const row = db.prepare('SELECT * FROM task_templates WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return parseTemplate(row)
}

export function updateTemplate(db: Database, data: UpdateTaskTemplateInput): TaskTemplate | null {
  const existing = db.prepare('SELECT * FROM task_templates WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
  if (!existing) return null

  if (data.isDefault) {
    db.prepare('UPDATE task_templates SET is_default = 0 WHERE project_id = (SELECT project_id FROM task_templates WHERE id = ?) AND is_default = 1').run(data.id)
  }

  const sets: string[] = []
  const values: unknown[] = []
  const fields: Array<[keyof UpdateTaskTemplateInput, string, (v: unknown) => unknown]> = [
    ['name', 'name', (v) => v],
    ['description', 'description', (v) => v ?? null],
    ['terminalMode', 'terminal_mode', (v) => v ?? null],
    ['providerConfig', 'provider_config', (v) => v ? JSON.stringify(v) : null],
    ['panelVisibility', 'panel_visibility', (v) => v ? JSON.stringify(v) : null],
    ['browserTabs', 'browser_tabs', (v) => v ? JSON.stringify(v) : null],
    ['webPanelUrls', 'web_panel_urls', (v) => v ? JSON.stringify(v) : null],
    ['dangerouslySkipPermissions', 'dangerously_skip_permissions', (v) => v == null ? null : (v ? 1 : 0)],
    ['ccsProfile', 'ccs_profile', (v) => v ?? null],
    ['defaultStatus', 'default_status', (v) => v ?? null],
    ['defaultPriority', 'default_priority', (v) => v ?? null],
    ['isDefault', 'is_default', (v) => v ? 1 : 0],
  ]
  for (const [key, col, transform] of fields) {
    if (key in data) {
      sets.push(`${col} = ?`)
      values.push(transform(data[key]))
    }
  }
  if (sets.length === 0) return parseTemplate(existing)
  sets.push("updated_at = datetime('now')")
  values.push(data.id)
  db.prepare(`UPDATE task_templates SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  const row = db.prepare('SELECT * FROM task_templates WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
  return parseTemplate(row)
}

export function deleteTemplate(db: Database, id: string): boolean {
  const result = db.prepare('DELETE FROM task_templates WHERE id = ?').run(id)
  return result.changes > 0
}

export function setDefaultTemplate(db: Database, projectId: string, templateId: string | null): void {
  db.prepare('UPDATE task_templates SET is_default = 0 WHERE project_id = ? AND is_default = 1').run(projectId)
  if (templateId) {
    db.prepare('UPDATE task_templates SET is_default = 1 WHERE id = ? AND project_id = ?').run(templateId, projectId)
  }
}
