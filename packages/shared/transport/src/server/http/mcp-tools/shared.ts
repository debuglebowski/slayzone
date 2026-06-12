import type { SlayzoneDb } from '@slayzone/platform'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { parseColumnsConfig } from '@slayzone/projects/shared'
import type { ProviderConfig } from '@slayzone/task/shared'

export function resolveCurrentTaskId(explicitTaskId?: string): string | null {
  return explicitTaskId ?? process.env.SLAYZONE_TASK_ID ?? null
}

export async function getProjectColumns(
  db: SlayzoneDb,
  projectId: string
): Promise<ColumnConfig[] | null> {
  const row = (await db
    .prepare('SELECT columns_config FROM projects WHERE id = ?')
    .get(projectId)) as { columns_config: string | null } | undefined
  return parseColumnsConfig(row?.columns_config)
}

export function getAllowedStatusesText(columns: ColumnConfig[] | null): string {
  return columns
    ? columns.map((column) => column.id).join(', ')
    : 'inbox, backlog, todo, in_progress, review, done, canceled'
}

export async function buildDefaultProviderConfig(db: SlayzoneDb): Promise<ProviderConfig> {
  const providerConfig: ProviderConfig = {}
  const allModes = (await db
    .prepare('SELECT id, default_flags FROM terminal_modes WHERE enabled = 1')
    .all()) as Array<{ id: string; default_flags: string | null }>
  for (const row of allModes) {
    providerConfig[row.id] = { flags: row.default_flags ?? '' }
  }
  return providerConfig
}
