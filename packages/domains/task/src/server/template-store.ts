import { randomUUID } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import type {
  TaskTemplate,
  CreateTaskTemplateInput,
  UpdateTaskTemplateInput
} from '@slayzone/task/shared'

// Electron-free task-template store. Single implementation behind both the IPC
// handlers (../main/template-handlers.ts) and the tRPC `template` router. Logic
// lifted verbatim from the IPC handlers — async `SlayzoneDb` queries + one named
// worker txn for the conditional create.

function safeJsonParse(value: unknown): unknown {
  if (!value || typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
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
    dangerously_skip_permissions:
      row.dangerously_skip_permissions == null ? null : Boolean(row.dangerously_skip_permissions),
    default_status: (row.default_status as string) ?? null,
    default_priority: row.default_priority == null ? null : Number(row.default_priority),
    is_default: Boolean(row.is_default),
    sort_order: Number(row.sort_order ?? 0),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string
  }
}

export async function getTemplateForTask(
  db: SlayzoneDb,
  projectId: string,
  templateId?: string
): Promise<TaskTemplate | null> {
  if (templateId) {
    const row = (await db.prepare('SELECT * FROM task_templates WHERE id = ?').get(templateId)) as
      | Record<string, unknown>
      | undefined
    return parseTemplate(row)
  }
  // Fall back to project default
  const row = (await db
    .prepare('SELECT * FROM task_templates WHERE project_id = ? AND is_default = 1')
    .get(projectId)) as Record<string, unknown> | undefined
  return parseTemplate(row)
}

export async function listTemplatesByProject(
  db: SlayzoneDb,
  projectId: string
): Promise<TaskTemplate[]> {
  const rows = (await db
    .prepare(
      'SELECT * FROM task_templates WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC'
    )
    .all(projectId)) as Record<string, unknown>[]
  return rows.map((r) => parseTemplate(r)!).filter(Boolean)
}

export async function getTemplate(db: SlayzoneDb, id: string): Promise<TaskTemplate | null> {
  const row = (await db.prepare('SELECT * FROM task_templates WHERE id = ?').get(id)) as
    | Record<string, unknown>
    | undefined
  return parseTemplate(row)
}

export async function createTemplate(
  db: SlayzoneDb,
  data: CreateTaskTemplateInput
): Promise<TaskTemplate | null> {
  const row = await db.namedTxn('task-templates:create', {
    id: randomUUID(),
    projectId: data.projectId,
    name: data.name,
    description: data.description ?? null,
    terminalMode: data.terminalMode ?? null,
    providerConfig: data.providerConfig ? JSON.stringify(data.providerConfig) : null,
    panelVisibility: data.panelVisibility ? JSON.stringify(data.panelVisibility) : null,
    browserTabs: data.browserTabs ? JSON.stringify(data.browserTabs) : null,
    webPanelUrls: data.webPanelUrls ? JSON.stringify(data.webPanelUrls) : null,
    dangerouslySkipPermissions:
      data.dangerouslySkipPermissions == null ? null : data.dangerouslySkipPermissions ? 1 : 0,
    defaultStatus: data.defaultStatus ?? null,
    defaultPriority: data.defaultPriority ?? null,
    isDefault: data.isDefault ? 1 : 0
  })
  return parseTemplate(row)
}

export async function updateTemplate(
  db: SlayzoneDb,
  data: UpdateTaskTemplateInput
): Promise<TaskTemplate | null> {
  const existing = (await db.prepare('SELECT * FROM task_templates WHERE id = ?').get(data.id)) as
    | Record<string, unknown>
    | undefined
  if (!existing) return null

  // If marking as default, clear existing default for this project
  if (data.isDefault) {
    await db
      .prepare(
        'UPDATE task_templates SET is_default = 0 WHERE project_id = (SELECT project_id FROM task_templates WHERE id = ?) AND is_default = 1'
      )
      .run(data.id)
  }

  const sets: string[] = []
  const values: unknown[] = []
  const fields: Array<[keyof UpdateTaskTemplateInput, string, (v: unknown) => unknown]> = [
    ['name', 'name', (v) => v],
    ['description', 'description', (v) => v ?? null],
    ['terminalMode', 'terminal_mode', (v) => v ?? null],
    ['providerConfig', 'provider_config', (v) => (v ? JSON.stringify(v) : null)],
    ['panelVisibility', 'panel_visibility', (v) => (v ? JSON.stringify(v) : null)],
    ['browserTabs', 'browser_tabs', (v) => (v ? JSON.stringify(v) : null)],
    ['webPanelUrls', 'web_panel_urls', (v) => (v ? JSON.stringify(v) : null)],
    [
      'dangerouslySkipPermissions',
      'dangerously_skip_permissions',
      (v) => (v == null ? null : v ? 1 : 0)
    ],
    ['defaultStatus', 'default_status', (v) => v ?? null],
    ['defaultPriority', 'default_priority', (v) => v ?? null],
    ['isDefault', 'is_default', (v) => (v ? 1 : 0)]
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
  await db.prepare(`UPDATE task_templates SET ${sets.join(', ')} WHERE id = ?`).run(...values)

  const row = (await db.prepare('SELECT * FROM task_templates WHERE id = ?').get(data.id)) as
    | Record<string, unknown>
    | undefined
  return parseTemplate(row)
}

export async function deleteTemplate(db: SlayzoneDb, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM task_templates WHERE id = ?').run(id)
  return result.changes > 0
}

export async function setDefaultTemplate(
  db: SlayzoneDb,
  projectId: string,
  templateId: string | null
): Promise<void> {
  await db
    .prepare('UPDATE task_templates SET is_default = 0 WHERE project_id = ? AND is_default = 1')
    .run(projectId)
  if (templateId) {
    await db
      .prepare('UPDATE task_templates SET is_default = 1 WHERE id = ? AND project_id = ?')
      .run(templateId, projectId)
  }
}
