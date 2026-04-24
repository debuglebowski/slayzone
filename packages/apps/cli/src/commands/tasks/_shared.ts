import { openDb, type SlayDb } from '../../db'
import { parseColumnsConfig } from '@slayzone/projects/shared'
import { DEFAULT_TERMINAL_MODES } from '@slayzone/terminal/shared'
import type { AuthorContext } from '@slayzone/task-assets/shared'

export function cliAuthor(): AuthorContext {
  const mode = process.env.SLAYZONE_AGENT_MODE
  if (mode) return { type: 'agent', id: mode }
  return { type: 'user', id: null }
}

export interface TaskRow extends Record<string, unknown> {
  id: string
  project_id: string
  title: string
  status: string
  priority: number
  project_name: string
  created_at: string
}

export function getProjectColumnsConfig(db: ReturnType<typeof openDb>, projectId: string) {
  const rows = db.query<{ columns_config: string | null }>(
    `SELECT columns_config FROM projects WHERE id = :projectId LIMIT 1`,
    { ':projectId': projectId }
  )
  return parseColumnsConfig(rows[0]?.columns_config)
}

export function buildProviderConfig(db: SlayDb): Record<string, { flags: string }> {
  let rows: { id: string; default_flags: string | null }[] = []
  try {
    rows = db.query('SELECT id, default_flags FROM terminal_modes WHERE enabled = 1')
  } catch { /* table may not exist */ }

  if (rows.length === 0) {
    rows = DEFAULT_TERMINAL_MODES
      .filter((m) => m.enabled)
      .map((m) => ({ id: m.id, default_flags: m.defaultFlags ?? '' }))
  }

  const config: Record<string, { flags: string }> = {}
  for (const row of rows) {
    config[row.id] = { flags: row.default_flags ?? '' }
  }
  return config
}

export interface TemplateRow extends Record<string, unknown> {
  id: string
  terminal_mode: string | null
  default_status: string | null
  default_priority: number | null
  provider_config: string | null
}

export function resolveTaskTemplate(db: SlayDb, projectId: string, templateRef?: string): TemplateRow | null {
  if (templateRef) {
    // Try ID prefix first
    let rows = db.query<TemplateRow>(
      `SELECT * FROM task_templates WHERE id LIKE :prefix || '%' AND project_id = :pid LIMIT 2`,
      { ':prefix': templateRef, ':pid': projectId }
    )
    if (rows.length === 1) return rows[0]
    if (rows.length > 1) {
      console.error(`Ambiguous template id "${templateRef}". Matches: ${rows.map((r) => r.id.slice(0, 8)).join(', ')}`)
      process.exit(1)
    }
    // Try name match
    rows = db.query<TemplateRow>(
      `SELECT * FROM task_templates WHERE project_id = :pid AND LOWER(name) = LOWER(:name) LIMIT 2`,
      { ':pid': projectId, ':name': templateRef }
    )
    if (rows.length === 1) return rows[0]
    if (rows.length > 1) {
      console.error(`Ambiguous template name "${templateRef}".`)
      process.exit(1)
    }
    console.error(`Template not found: "${templateRef}"`)
    process.exit(1)
  }
  // Check for project default
  const defaults = db.query<TemplateRow>(
    `SELECT * FROM task_templates WHERE project_id = :pid AND is_default = 1 LIMIT 1`,
    { ':pid': projectId }
  )
  return defaults[0] ?? null
}

export function mergeTemplateProviderConfig(
  base: Record<string, { flags: string }>,
  template: TemplateRow | null
): Record<string, { flags: string }> {
  if (!template?.provider_config) return base
  try {
    const tpc = JSON.parse(template.provider_config) as Record<string, { flags?: string }>
    const merged = { ...base }
    for (const [mode, conf] of Object.entries(tpc)) {
      if (conf.flags !== undefined) merged[mode] = { ...merged[mode], flags: conf.flags }
    }
    return merged
  } catch {
    return base
  }
}

export function resolveId(explicit?: string): string {
  const id = explicit ?? process.env.SLAYZONE_TASK_ID
  if (!id) {
    console.error('No task ID provided and $SLAYZONE_TASK_ID is not set.')
    process.exit(1)
  }
  return id
}

export function printTasks(tasks: TaskRow[], blockedIds?: Set<string>) {
  if (tasks.length === 0) {
    console.log('No tasks found.')
    return
  }
  const idW = 9
  const statusW = 12
  console.log(`${'ID'.padEnd(idW)}  ${'STATUS'.padEnd(statusW)}  ${'PROJECT'.padEnd(16)}  TITLE`)
  console.log(`${'-'.repeat(idW)}  ${'-'.repeat(statusW)}  ${'-'.repeat(16)}  ${'-'.repeat(30)}`)
  for (const t of tasks) {
    const id = String(t.id).slice(0, 8).padEnd(idW)
    const status = String(t.status).padEnd(statusW)
    const project = String(t.project_name ?? '').slice(0, 16).padEnd(16)
    const prefix = blockedIds?.has(t.id) ? '[B] ' : ''
    console.log(`${id}  ${status}  ${project}  ${prefix}${t.title}`)
  }
}
