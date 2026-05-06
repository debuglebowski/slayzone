import type { Database } from 'better-sqlite3'
import type { TaskTemplate } from '@slayzone/task/shared'

function safeJsonParse(value: unknown): unknown {
  if (!value || typeof value !== 'string') return null
  try { return JSON.parse(value) } catch { return null }
}

export function parseTemplate(row: Record<string, unknown> | undefined): TaskTemplate | null {
  if (!row) return null
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    name: row.name as string,
    description: (row.description as string) ?? null,
    terminal_mode: (row.terminal_mode as string) ?? null,
    provider_config: safeJsonParse(row.provider_config) as TaskTemplate['provider_config'],
    panel_visibility: safeJsonParse(row.panel_visibility) as TaskTemplate['panel_visibility'],
    browser_tabs: safeJsonParse(row.browser_tabs) as TaskTemplate['browser_tabs'],
    web_panel_urls: safeJsonParse(row.web_panel_urls) as TaskTemplate['web_panel_urls'],
    dangerously_skip_permissions: row.dangerously_skip_permissions == null ? null : Boolean(row.dangerously_skip_permissions),
    ccs_profile: (row.ccs_profile as string) ?? null,
    default_status: (row.default_status as string) ?? null,
    default_priority: row.default_priority == null ? null : Number(row.default_priority),
    is_default: Boolean(row.is_default),
    sort_order: Number(row.sort_order ?? 0),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}

export function getTemplateForTask(db: Database, projectId: string, templateId?: string): TaskTemplate | null {
  if (templateId) {
    const row = db.prepare('SELECT * FROM task_templates WHERE id = ?').get(templateId) as Record<string, unknown> | undefined
    return parseTemplate(row)
  }
  const row = db.prepare('SELECT * FROM task_templates WHERE project_id = ? AND is_default = 1').get(projectId) as Record<string, unknown> | undefined
  return parseTemplate(row)
}
