import type { SlayzoneDb } from '@slayzone/platform'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { parseColumnsConfig } from '@slayzone/projects/shared'
import type { ProviderConfig } from '@slayzone/task/shared'

/**
 * Resolve the calling agent's task id. Order: explicit `task_id` arg (normal
 * spawn — the agent's own shell has `$SLAYZONE_TASK_ID`) → live
 * `agent_sessions.task_id` lookup via an explicit `session_id` arg
 * (warm-pool-adopted agent — it boots before any task exists, so its shell only
 * ever gets `$SLAYZONE_SESSION_ID`; the task is bound to that session later at
 * adopt time).
 *
 * Both ids must come in as EXPLICIT tool arguments, not read from `process.env`
 * here: this code runs inside the shared MCP sidecar process, a single
 * long-lived process serving every task in the app — it has no per-request
 * env, so it can never see "the calling agent's" env vars. The agent must read
 * its own `$SLAYZONE_TASK_ID` / `$SLAYZONE_SESSION_ID` and pass whichever is
 * set. Mirrors the CLI's `resolveId()` (packages/apps/cli/src/commands/tasks/_shared.ts),
 * which works because the CLI process itself inherits the real env and passes
 * the id explicitly over the wire (URL param), never relying on server-side env.
 */
export async function resolveCurrentTaskId(
  db: SlayzoneDb,
  explicitTaskId?: string,
  explicitSessionId?: string
): Promise<string | null> {
  if (explicitTaskId) return explicitTaskId
  if (!explicitSessionId) return null
  const row = (await db
    .prepare('SELECT task_id FROM agent_sessions WHERE id = ?')
    .get(explicitSessionId)) as { task_id: string | null } | undefined
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
