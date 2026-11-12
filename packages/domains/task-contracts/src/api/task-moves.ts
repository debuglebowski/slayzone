import { z } from 'zod'

/**
 * Moving tasks to a project on ANOTHER hub. The app (the only party connected to
 * both hubs) runs the move as a series of steps; the hub the tasks leave keeps the
 * journal (`task_moves`), so a paused or interrupted move resumes from any device.
 * Every step is safe to run again. While a move is running, paused or failed, its
 * tasks are locked: their writes are refused.
 */
export const TASK_MOVE_STEPS = [
  /** Lock the tasks and stop their agents (done when the move begins). */
  'lock',
  /** Read the tasks' rows and file manifest from the source hub. */
  'export',
  /** Write the rows into the target project (ids kept). */
  'import',
  /** Copy the artifact files, checked by hash. */
  'copy-files',
  /** Blockers between a moved task and one staying behind become cross-hub links. */
  'links',
  /** The target hub takes the tasks as its own. */
  'commit',
  /** The source hub lets the tasks go (rows removed, redirects left). */
  'release'
] as const
export type TaskMoveStep = (typeof TASK_MOVE_STEPS)[number]

/** The step after `step`, or null after the last one. */
export function nextTaskMoveStep(step: TaskMoveStep): TaskMoveStep | null {
  const i = TASK_MOVE_STEPS.indexOf(step)
  return i >= 0 && i + 1 < TASK_MOVE_STEPS.length ? TASK_MOVE_STEPS[i + 1] : null
}

export const TASK_MOVE_STATUSES = ['running', 'paused', 'failed', 'canceled', 'done'] as const
export type TaskMoveStatus = (typeof TASK_MOVE_STATUSES)[number]
/** A move in these states holds its tasks' lock. */
export const TASK_MOVE_LOCKING_STATUSES: readonly TaskMoveStatus[] = ['running', 'paused', 'failed']

export interface TaskMove {
  id: string
  direction: 'out' | 'in'
  /** The other hub: where the tasks go ('out'), or where they come from ('in'). */
  peerHubId: string
  targetProjectId: string
  /** The tasks the user picked. */
  rootTaskIds: string[]
  /** Every task the move carries (the roots and, if brought, their subtasks). */
  taskIds: string[]
  includeSubtasks: boolean
  /** The step to run next (the last one finished: status 'done'). */
  step: TaskMoveStep
  status: TaskMoveStatus
  error: string | null
  /** The running step's progress, e.g. bytes copied. */
  progress: { step: TaskMoveStep; done: number; total: number } | null
  createdAt: number
  updatedAt: number
}

export const beginTaskMoveInputSchema = z.object({
  /** Client-chosen, so a retried begin is the same move. */
  id: z.string().uuid().optional(),
  taskIds: z.array(z.string().min(1)).min(1),
  targetHubId: z.string().min(1),
  targetProjectId: z.string().min(1),
  includeSubtasks: z.boolean().default(true)
})
export type BeginTaskMoveInput = z.input<typeof beginTaskMoveInputSchema>

export const taskMoveIdInputSchema = z.object({ id: z.string().min(1) })

export const advanceTaskMoveInputSchema = z.object({
  id: z.string().min(1),
  /** The step the caller finished. A move already past it is answered unchanged. */
  completed: z.enum(TASK_MOVE_STEPS)
})

export const reportTaskMoveProgressInputSchema = z.object({
  id: z.string().min(1),
  step: z.enum(TASK_MOVE_STEPS),
  done: z.number().int().min(0),
  total: z.number().int().min(0)
})

export const failTaskMoveInputSchema = z.object({
  id: z.string().min(1),
  error: z.string().min(1).max(2000)
})

export const listTaskMovesInputSchema = z
  .object({ statuses: z.array(z.enum(TASK_MOVE_STATUSES)).optional() })
  .default({})

export const taskMoveRedirectsInputSchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1).max(500)
})
/** Where moved tasks went: task id → the hub, by which move. A task not listed did not move away. */
export type TaskMoveRedirects = Record<string, { hubId: string; moveId: string }>

/**
 * What a move carries from hub to hub: the moved tasks' rows in every table that
 * holds task content on a hub. Ids are kept. Artifact bytes travel in their own step
 * (`copy-files`), which pins them on the target as it writes them. What a computer holds (sessions, chat,
 * scrollback) is not here; nor is hub↔computer delivery state, which the target
 * rebuilds for its own computers.
 */
export const TASK_MOVE_TABLES = [
  'tasks',
  'terminal_tabs',
  'task_tags',
  'task_dependencies',
  'artifact_folders',
  'task_artifacts',
  'artifact_versions',
  'activity_events',
  'usage_records'
] as const
export type TaskMoveTable = (typeof TASK_MOVE_TABLES)[number]

export interface TaskMoveBundle {
  moveId: string
  rootTaskIds: string[]
  /** Rows per table, as the source stores them (column → value). */
  rows: Record<TaskMoveTable, Array<Record<string, unknown>>>
  /** The tags `task_tags` names: the target uses its own of the same name, or makes one. */
  tags: Array<{ id: string; name: string; color: string; text_color: string }>
  /** Blockers between a moved task and one staying on the source (cross-hub links, 3d). */
  externalDependencies: Array<{ task_id: string; blocks_task_id: string }>
}

export const exportTaskMoveInputSchema = z.object({ id: z.string().min(1) })

export const importTaskMoveInputSchema = z.object({
  /** The hub the tasks come from (the app's registry id). */
  sourceHubId: z.string().min(1),
  targetProjectId: z.string().min(1),
  bundle: z.custom<TaskMoveBundle>(
    (v) =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as TaskMoveBundle).moveId === 'string' &&
      Array.isArray((v as TaskMoveBundle).rootTaskIds) &&
      typeof (v as TaskMoveBundle).rows === 'object'
  )
})
export type ImportTaskMoveInput = z.infer<typeof importTaskMoveInputSchema>
