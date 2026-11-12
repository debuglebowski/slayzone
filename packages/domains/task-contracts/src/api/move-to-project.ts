import { z } from 'zod'

/**
 * Move tasks to another project on the same hub. With `includeSubtasks` the whole
 * subtree moves (archived subtasks too); without, the subtasks stay and are
 * detached. A moved task whose parent stays behind is detached from it.
 */
export const moveTasksToProjectInputSchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1),
  targetProjectId: z.string().min(1),
  includeSubtasks: z.boolean().default(true),
  /**
   * Agent tabs whose session follows the task (resumed in the new folder). Only a
   * tab the preview marks `canKeep` can; any other resets. Empty: every session
   * starts fresh.
   */
  keepSessionTabIds: z.array(z.string().min(1)).default([])
})
export type MoveTasksToProjectInput = z.input<typeof moveTasksToProjectInputSchema>

export interface MoveTasksToProjectResult {
  /** Rows now in the target project (the selection and, if brought, their subtasks). */
  movedTaskIds: string[]
  /** Rows that lost their parent: moved without it, or subtasks left behind. */
  detachedTaskIds: string[]
}

/** What a move would do — the move dialog's summary. Writes nothing. */
export const movePreviewInputSchema = moveTasksToProjectInputSchema
export type MovePreviewInput = MoveTasksToProjectInput

export interface MoveToProjectPreview {
  /** Selected tasks not already in the target. */
  taskCount: number
  /** Every subtask (any depth, archived included) of the selected tasks. */
  subtaskCount: number
  /** Selected tasks moved without their parent. */
  detachedFrom: Array<{ taskId: string; title: string; parentId: string; parentTitle: string }>
  /** Tag names the target project lacks: created there. */
  tagsToCreate: string[]
  /** Moved rows whose status the target project lacks: re-homed to its default. */
  statusChanges: Array<{
    taskId: string
    title: string
    from: string
    to: string
    fromLabel: string
    toLabel: string
  }>
  /** Moved rows with a worktree, which they lose. */
  worktreeCount: number
  /** The agent tabs of the moved rows: can each one's session follow the task? */
  sessions: Array<{
    taskId: string
    taskTitle: string
    tabId: string
    tabLabel: string
    mode: string
    canKeep: boolean
    /** Why it can't, when it can't. */
    reason?: string
  }>
}
