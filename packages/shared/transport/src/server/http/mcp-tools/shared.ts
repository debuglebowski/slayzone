import type { SlayzoneDb } from '@slayzone/platform'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { parseColumnsConfig } from '@slayzone/projects/shared'
import type { ProviderConfig } from '@slayzone/task/shared'

/**
 * Resolve the calling agent's task id. Order: explicit arg → `$SLAYZONE_TASK_ID`
 * (normal spawn) → live `agent_sessions.task_id` lookup via `$SLAYZONE_SESSION_ID`
 * (warm-pool-adopted agent — it boots before any task exists, so it only ever gets
 * a session id; the task is bound to that session later at adopt time). Mirrors the
 * CLI's `resolveId()` fallback (packages/apps/cli/src/commands/tasks/_shared.ts),
 * querying the DB directly since MCP tools already have `db` in-process.
 */
export async function resolveCurrentTaskId(
  db: SlayzoneDb,
  explicitTaskId?: string
): Promise<string | null> {
  if (explicitTaskId) return explicitTaskId
  if (process.env.SLAYZONE_TASK_ID) return process.env.SLAYZONE_TASK_ID
  const sessionId = process.env.SLAYZONE_SESSION_ID
  if (!sessionId) return null
  const row = await db
    .prepare('SELECT task_id FROM agent_sessions WHERE id = ?')
    .get(sessionId) as { task_id: string | null } | undefined
  return row?.task_id ?? null
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
