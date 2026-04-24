import type { Database } from 'better-sqlite3'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { parseColumnsConfig } from '@slayzone/projects/shared'
import type { ProviderConfig } from '@slayzone/task/shared'

export function resolveCurrentTaskId(explicitTaskId?: string): string | null {
  return explicitTaskId ?? process.env.SLAYZONE_TASK_ID ?? null
}

export function getProjectColumns(db: Database, projectId: string): ColumnConfig[] | null {
  const row = db.prepare('SELECT columns_config FROM projects WHERE id = ?').get(projectId) as
    | { columns_config: string | null }
    | undefined
  return parseColumnsConfig(row?.columns_config)
}

export function getAllowedStatusesText(columns: ColumnConfig[] | null): string {
  return columns
    ? columns.map((column) => column.id).join(', ')
    : 'inbox, backlog, todo, in_progress, review, done, canceled'
}

export function buildDefaultProviderConfig(db: Database): ProviderConfig {
  const providerConfig: ProviderConfig = {}
  const allModes = db.prepare('SELECT id, default_flags FROM terminal_modes WHERE enabled = 1').all() as Array<{ id: string; default_flags: string | null }>
  for (const row of allModes) {
    providerConfig[row.id] = { flags: row.default_flags ?? '' }
  }
  return providerConfig
}
