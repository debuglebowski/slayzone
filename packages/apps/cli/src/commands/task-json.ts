/**
 * Public JSON contract for `slay tasks list --json` (and any future task JSON output).
 *
 * Stable shape: changes are additive only. Removing or renaming fields is a
 * breaking change for downstream scripts (jq, python, etc).
 *
 * Fields exposed are deliberately narrow — internal columns (provider_config,
 * *_flags, session ids, panel state, worktree paths, etc.) are intentionally
 * excluded to avoid coupling consumers to implementation details.
 */

export interface TaskJson {
  id: string
  project_id: string
  project_name: string
  title: string
  description: string | null
  status: string
  priority: number
  due_date: string | null
  parent_id: string | null
  created_at: string
  updated_at: string
  is_blocked: boolean
  tags: string[]
}

/** Columns the serializer reads from the tasks table — used by SELECT. */
export const TASK_JSON_COLUMNS = [
  't.id',
  't.project_id',
  't.title',
  't.description',
  't.status',
  't.priority',
  't.due_date',
  't.parent_id',
  't.created_at',
  't.updated_at',
] as const

export interface TaskJsonRow extends Record<string, unknown> {
  id: string
  project_id: string
  project_name: string
  title: string
  description: string | null
  status: string
  priority: number
  due_date: string | null
  parent_id: string | null
  created_at: string
  updated_at: string
}

export function serializeTaskForJson(
  row: TaskJsonRow,
  ctx: { isBlocked: boolean; tags: string[] }
): TaskJson {
  return {
    id: row.id,
    project_id: row.project_id,
    project_name: row.project_name,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    due_date: row.due_date,
    parent_id: row.parent_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    is_blocked: ctx.isBlocked,
    tags: ctx.tags,
  }
}
