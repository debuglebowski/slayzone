import type { SlayzoneDb } from '@slayzone/platform'
import type { DuplicateTaskInput, DuplicateTaskResult } from '@slayzone/task-contracts'
import { buildTaskDuplicatedEvents } from '../history.js'
import { createTaskOp, PROJECT_NOT_FOUND } from './create.js'
import { getTaskOp } from './get.js'
import type { OpDeps } from './shared.js'
// Loads the TxnRegistry augmentation that types this file's `db.namedTxn` calls.
import type {} from '../task-txns.js'

/** `err.code` on "no such task to duplicate". */
export const TASK_NOT_FOUND = 'TASK_NOT_FOUND'

/**
 * `task.duplicate`: a fresh follow-up of a task, in a project of this hub (its own
 * included). Created the way any task is (`createTaskOp`: the target's default
 * status, its default flags, auto-worktree when the project asks for one), from what
 * describes the work — title, description, priority, assignee, agent. Then, in one
 * transaction (`task:finish-duplicate`): the description's format, the tags by name,
 * and an activity entry on both tasks. Its repo is kept only within the same project
 * (a repo is a folder of the project). Subtasks, artifacts, sessions and history
 * stay with the source.
 */
export async function duplicateTaskOp(
  db: SlayzoneDb,
  input: DuplicateTaskInput,
  deps: OpDeps
): Promise<DuplicateTaskResult> {
  const source = await getTaskOp(db, input.taskId)
  if (!source || source.deleted_at) {
    throw Object.assign(new Error(`Task ${input.taskId} does not exist on this hub.`), {
      code: TASK_NOT_FOUND
    })
  }
  const target = await db.get<{ name: string }>('SELECT name FROM projects WHERE id = ?', [
    input.targetProjectId
  ])
  if (!target) {
    throw Object.assign(new Error(`Project ${input.targetProjectId} does not exist on this hub.`), {
      code: PROJECT_NOT_FOUND
    })
  }
  const sameProject = source.project_id === input.targetProjectId
  const copy = await createTaskOp(
    db,
    {
      projectId: input.targetProjectId,
      title: input.title ?? source.title,
      description: source.description ?? undefined,
      assignee: source.assignee,
      priority: source.priority,
      agentId: source.agent_id,
      repoName: sameProject ? source.repo_name : null
    },
    // The copy's own create signals its row; the tags below signal again.
    deps
  )
  if (!copy) throw new Error('The duplicate could not be created.')

  const { createdTagIds } = await db.namedTxn('task:finish-duplicate', {
    sourceTaskId: source.id,
    copyTaskId: copy.id,
    targetProjectId: input.targetProjectId,
    descriptionFormat: source.description_format,
    events: buildTaskDuplicatedEvents(source, copy, target.name)
  })
  // Created tags change every card's tag list: then a full reload, else the copy's row.
  deps.onMutation?.(createdTagIds.length > 0 ? undefined : { taskIds: [copy.id] })
  return { taskId: copy.id }
}
