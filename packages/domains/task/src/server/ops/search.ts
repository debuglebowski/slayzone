import type { SlayzoneDb } from '@slayzone/platform'
import { toCardRow, type Task } from '@slayzone/task-contracts'
import { NOT_IN_TRANSIT, parseTasks } from './shared.js'

export interface SearchTasksInput {
  /** Words to find; each must appear in the title or the description. */
  query: string
  /** Only this project's tasks. */
  projectId?: string
  /** At most this many tasks (default 50, at most 200). */
  limit?: number
}

export interface SearchTasksResult {
  /** Card rows (`toCardRow`), best match first. */
  tasks: Task[]
  /** More tasks matched than `limit`. */
  hasMore: boolean
}

export const SEARCH_TASKS_DEFAULT_LIMIT = 50
export const SEARCH_TASKS_MAX_LIMIT = 200

const escapeLike = (term: string): string => term.replace(/[\\%_]/g, (c) => `\\${c}`)

/**
 * The hub-side task search: every word of `query` in a task's title or
 * description, case-insensitive. Archived tasks are included (a client's board may
 * not hold them); deleted ones and tasks moving to another hub never are. Tasks
 * whose title holds every word rank first, then by most recently updated.
 *
 * `projectIds` restricts the search to those projects (null = no restriction): the
 * caller's own on a hub with login, so `limit` counts tasks they may see. Private
 * tasks inside those projects are still cut by the owner gate.
 */
export async function searchTasksOp(
  db: SlayzoneDb,
  input: SearchTasksInput,
  projectIds: readonly string[] | null = null
): Promise<SearchTasksResult> {
  const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 16)
  if (terms.length === 0 || projectIds?.length === 0) return { tasks: [], hasMore: false }
  const limit = Math.min(
    Math.max(1, Math.floor(input.limit ?? SEARCH_TASKS_DEFAULT_LIMIT)),
    SEARCH_TASKS_MAX_LIMIT
  )
  const where = ['t.deleted_at IS NULL', NOT_IN_TRANSIT]
  const params: unknown[] = []
  const titleAll: string[] = []
  const titleParams: unknown[] = []
  for (const term of terms) {
    const like = `%${escapeLike(term)}%`
    where.push(
      "(LOWER(t.title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(t.description, '')) LIKE ? ESCAPE '\\')"
    )
    params.push(like, like)
    titleAll.push("LOWER(t.title) LIKE ? ESCAPE '\\'")
    titleParams.push(like)
  }
  if (input.projectId) {
    where.push('t.project_id = ?')
    params.push(input.projectId)
  }
  if (projectIds) {
    where.push('t.project_id IN (SELECT value FROM json_each(?))')
    params.push(JSON.stringify(projectIds))
  }
  const rows = await db.all<Record<string, unknown>>(
    `SELECT t.*, el.external_url AS linear_url
       FROM tasks t
       LEFT JOIN external_links el ON el.task_id = t.id AND el.provider = 'linear'
      WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN ${titleAll.join(' AND ')} THEN 0 ELSE 1 END, t.updated_at DESC, t.rowid DESC
      LIMIT ?`,
    [...params, ...titleParams, limit + 1]
  )
  const tasks = parseTasks(rows.slice(0, limit)).map((t) => toCardRow(t))
  return { tasks, hasMore: rows.length > limit }
}
