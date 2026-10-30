/**
 * Organising a task, from its hub's board (`task.loadBoardData`, reloaded on every
 * change): its subtasks, its project's tags, and the tasks that may block it. Pure.
 * Everything is one hub's: subtasks, tags and blockers never cross hubs.
 */
import type { Tag } from '@slayzone/tags/shared'
import { isTerminalStatus } from '@slayzone/workflow'
import type { BoardData, BoardTask } from '../hub-board'

/** The task's subtasks, in the board's order. */
export const subtasksOf = (board: BoardData, taskId: string): BoardTask[] =>
  board.tasks.filter((t) => t.parent_id === taskId)

/** The tags of a project (tags belong to one project; desktop offers the task's project's). */
export const projectTags = (board: BoardData, projectId: string): Tag[] =>
  (board.tags as Tag[]).filter((t) => t.project_id === projectId)

/** The task's tag ids with `tagId` added, or removed when it was there. */
export const toggleTag = (tagIds: readonly string[], tagId: string): string[] =>
  tagIds.includes(tagId) ? tagIds.filter((id) => id !== tagId) : [...tagIds, tagId]

/** Shown blocked: it has a blocker or its blocked flag is set (the board's rule). */
export const isBlocked = (board: BoardData, taskId: string): boolean =>
  board.blockedTaskIds.includes(taskId)

/**
 * The tasks that may block `taskId`, desktop's rule: any of the hub's tasks but itself
 * and its current blockers, not finished (completed or canceled in its project's
 * workflow); `query` matches the title, case-insensitively.
 */
export function blockerCandidates(
  board: BoardData,
  taskId: string,
  blockerIds: readonly string[],
  query: string
): BoardTask[] {
  const columns = new Map(board.projects.flatMap((p) => (p ? [[p.id, p.columns_config]] : [])))
  const q = query.trim().toLowerCase()
  return board.tasks.filter(
    (t) =>
      t.id !== taskId &&
      !blockerIds.includes(t.id) &&
      !isTerminalStatus(t.status, columns.get(t.project_id)) &&
      (!q || t.title.toLowerCase().includes(q))
  )
}
