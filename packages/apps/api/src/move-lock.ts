/**
 * The move lock: while a task is being moved to another hub (a `task_moves` row
 * running, paused or failed), every write to it is refused — its rows are on their
 * way out, and a write landing after the export would be lost. One decision for
 * every transport: the tRPC gate (`moveLockGate`, via `procedure-policy.ts`), the REST
 * owner guard and the MCP gate each hand it the resources a request names, from the
 * same owner policies that already list them.
 *
 * Login or not: unlike the owner gates this is about the data, not the caller.
 *
 * @module api/move-lock
 */
import type { SlayzoneDb } from '@slayzone/platform'
import { anyTaskMoveLocking, lockedProjectIds, lockedTaskIds } from '@slayzone/task/server'
import type { OwnedResource } from './access'
import type { HttpIdRef } from './http-owner-policy'
import { idValuesAt } from './http/owner-scope'

/**
 * Writes the lock lets through though they name a moving project: the order of the
 * project list is not the project's content (a reorder names every listed project).
 */
export const MOVE_LOCK_EXEMPT: ReadonlySet<string> = new Set(['projects.reorder'])

/** A write to a task, or to a project, that is being moved to another hub. */
export class TaskMovingError extends Error {
  override name = 'TaskMovingError'
  constructor(
    readonly taskIds: readonly string[],
    readonly projectIds: readonly string[] = []
  ) {
    super(
      projectIds.length > 0
        ? 'This project is being moved to another hub. Wait for the move to finish, or cancel it.'
        : 'This task is being moved to another hub. Wait for the move to finish, or cancel it.'
    )
  }
}

/**
 * The project each kind belongs to, for a project move's lock (the project's own id
 * for a project). Its tasks, tabs and artifacts are locked as tasks of the move.
 */
const PROJECT_OF: Partial<Record<OwnedResource['kind'], string | null>> = {
  project: null,
  tag: 'SELECT project_id FROM tags WHERE id = ?',
  template: 'SELECT project_id FROM task_templates WHERE id = ?',
  testCategory: 'SELECT project_id FROM test_categories WHERE id = ?',
  testLabel: 'SELECT project_id FROM test_labels WHERE id = ?',
  automation: 'SELECT project_id FROM automations WHERE id = ?',
  automationRun: `SELECT a.project_id FROM automation_runs r
    JOIN automations a ON a.id = r.automation_id WHERE r.id = ?`,
  aiConfigItem: 'SELECT project_id FROM ai_config_items WHERE id = ?',
  process: 'SELECT project_id FROM processes WHERE id = ?'
}

async function projectIdsOf(
  db: SlayzoneDb,
  resources: readonly OwnedResource[]
): Promise<string[]> {
  const out = new Set<string>()
  for (const r of resources) {
    if (!(r.kind in PROJECT_OF)) continue
    const sql = PROJECT_OF[r.kind]
    if (sql === null) {
      out.add(r.id)
      continue
    }
    const row = sql ? await db.get<{ project_id: string | null }>(sql, [r.id]) : undefined
    if (row?.project_id) out.add(row.project_id)
  }
  return [...out]
}

/** The table holding each kind's task id (the resource's own id for a task). */
const TASK_OF: Partial<Record<OwnedResource['kind'], string | null>> = {
  task: null,
  tab: 'SELECT task_id FROM terminal_tabs WHERE id = ?',
  artifact: 'SELECT task_id FROM task_artifacts WHERE id = ?',
  artifactFolder: 'SELECT task_id FROM artifact_folders WHERE id = ?'
}

async function taskIdsOf(db: SlayzoneDb, resources: readonly OwnedResource[]): Promise<string[]> {
  const out = new Set<string>()
  for (const r of resources) {
    if (!(r.kind in TASK_OF)) continue
    const sql = TASK_OF[r.kind]
    if (sql === null) {
      out.add(r.id)
      continue
    }
    const row = sql ? await db.get<{ task_id: string | null }>(sql, [r.id]) : undefined
    if (row?.task_id) out.add(row.task_id)
  }
  return [...out]
}

/**
 * Throws {@link TaskMovingError} when a resource belongs to a task that is moving, or
 * to a project that is (a project move locks the project's own rows too).
 */
export async function assertNotMoving(
  db: SlayzoneDb,
  resources: readonly OwnedResource[]
): Promise<void> {
  if (resources.length === 0) return
  // The common case — no move anywhere on this hub — costs one indexed read.
  if (!(await anyTaskMoveLocking(db))) return
  const locked = await lockedTaskIds(db, await taskIdsOf(db, resources))
  const lockedProjects = await lockedProjectIds(db, await projectIdsOf(db, resources))
  if (locked.length > 0 || lockedProjects.length > 0)
    throw new TaskMovingError(locked, lockedProjects)
}

/** The tables a REST / MCP id PREFIX resolves in, per kind the lock cares about. */
const TABLE_OF: Partial<Record<OwnedResource['kind'], string>> = {
  task: 'tasks',
  artifact: 'task_artifacts',
  artifactFolder: 'artifact_folders',
  tab: 'terminal_tabs',
  project: 'projects'
}

/**
 * {@link assertNotMoving} for a REST route or MCP tool: the ids its owner rule lists
 * (`HttpIdRef`s). A prefix (the CLI addresses tasks by prefix) counts every row it
 * matches — the handler later refuses an ambiguous one, the lock never lets one by.
 */
export async function assertHttpNotMoving(
  db: SlayzoneDb,
  refs: readonly HttpIdRef[],
  raw: unknown
): Promise<void> {
  if (refs.length === 0 || !(await anyTaskMoveLocking(db))) return
  const resources: OwnedResource[] = []
  for (const ref of refs) {
    const table = TABLE_OF[ref.kind]
    if (!table) continue
    for (const value of idValuesAt(raw, ref.at, ref.except).values) {
      if (ref.match === 'exact') {
        resources.push({ kind: ref.kind, id: value })
        continue
      }
      const rows = await db.all<{ id: string }>(
        `SELECT id FROM ${table} WHERE id LIKE ? || '%' LIMIT 50`,
        [value]
      )
      for (const row of rows) resources.push({ kind: ref.kind, id: row.id })
    }
  }
  await assertNotMoving(db, resources)
}
