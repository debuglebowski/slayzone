/**
 * What moving a task on the board writes, as plain data: a status change (swipe) or a
 * drop (drag) becomes a `MovePlan` — the `task.update` and the `task.reorder` the owning
 * hub gets — and `applyMovePlan` is the same change applied to the board the app shows
 * (optimistic, until the hub's own reload replaces it).
 *
 * The hub's `task.reorder` sets `order = index` for each id it is given and touches no
 * other row. A column on screen hides rows that share its order space: subtasks (they
 * carry their own status), archived, filtered-out and snoozed tasks. Desktop splices
 * the visible drop index into a list that counts those rows, so a drop can land
 * somewhere else than where it was made; here the list sent is the FULL ordered set of
 * the project's tasks with the target status (board order = the hub's `TASK_ORDER_BY`),
 * the moved task placed right before the row it was dropped on (or right after the
 * column's last visible row), every other row keeping its place relative to the rest.
 *
 * Under desktop's Display options (`Grouping`): a column is the project's tasks of a
 * status, a priority (`p1`…`p5`), every task ("No groups") or the active / inactive ones
 * ("Activity"); the full set sent is that group's. As on desktop: due-date groups can't
 * be dragged; a move to another group sets its status or priority (Activity: none, desktop
 * has no field to set); a reorder within a column needs the Manual order, or the
 * Priority order onto a task of the same priority.
 */
import type { UpdateTaskInput } from '@slayzone/task-contracts'
import type { GroupKey, SortKey } from '@slayzone/tasks/board'
import type { BoardData, BoardTask } from '../hub-board'

/** The board's virtual column of blocked tasks (desktop's `__blocked__`). */
export const BLOCKED_COLUMN = '__blocked__'

export type MoveUpdate = Pick<
  UpdateTaskInput,
  'id' | 'status' | 'priority' | 'isBlocked' | 'blockedComment'
>

/** How the board is grouped and sorted (its Display options). */
export interface Grouping {
  groupBy: GroupKey
  sortBy: SortKey
  /** "Activity": the tasks with an alive agent session. */
  activeTaskIds?: ReadonlySet<string>
}

const MANUAL_BY_STATUS: Grouping = { groupBy: 'status', sortBy: 'manual' }

/** Cards can be dragged (desktop: not in due-date groups). */
export const dragAllowed = (groupBy: GroupKey): boolean => groupBy !== 'due_date'

/** A drop within a column can reorder it (desktop: Manual, or Priority within a priority). */
export const reorderAllowed = (sortBy: SortKey): boolean =>
  sortBy === 'manual' || sortBy === 'priority'

const priorityOf = (column: string): number | null => {
  const p = /^p([1-5])$/.exec(column)
  return p ? Number(p[1]) : null
}

/** Is `task` in the group `column` (null = the grouping has no such group)? */
function inGroup(task: BoardTask, column: string, g: Grouping): boolean | null {
  switch (g.groupBy) {
    case 'status':
      return task.status === column
    case 'priority': {
      const p = priorityOf(column)
      return p === null ? null : task.priority === p
    }
    case 'none':
      return column === 'all' ? true : null
    case 'active': {
      const active = g.activeTaskIds?.has(task.id) ?? false
      return column === 'active' ? active : column === 'inactive' ? !active : null
    }
    default:
      return null
  }
}

export interface MovePlan {
  taskId: string
  /** `task.update`; null = none. */
  update: MoveUpdate | null
  /** `task.reorder`: the full ordered list; null = none. */
  reorder: string[] | null
  /** Out of the Blocked column: its dependency blockers go too (`task.setBlockers` []). */
  clearBlockers: boolean
}

export interface Drop {
  taskId: string
  /** The column the task was dragged from (a status, or a virtual `__…__` column). */
  fromColumn: string
  toColumn: string
  /** The visible row it was dropped on (lands before it); null = the end of the column. */
  beforeTaskId: string | null
}

const isVirtual = (column: string): boolean => column.startsWith('__')

/** A status change (swipe): the status only, like desktop's status change; the order stays. */
export function planStatusChange(taskId: string, status: string): MovePlan {
  return { taskId, update: { id: taskId, status }, reorder: null, clearBlockers: false }
}

/**
 * A drop. `visibleTarget`: the target column's rows as shown (needed for a drop at the
 * end: the moved task goes right after the last one). Null = the drop changes nothing
 * (or lands in a column a task can't be moved to).
 */
export function planDrop(
  data: BoardData,
  projectId: string,
  drop: Drop,
  visibleTarget?: readonly string[],
  grouping: Grouping = MANUAL_BY_STATUS
): MovePlan | null {
  const { taskId, fromColumn, toColumn, beforeTaskId } = drop
  const task = data.tasks.find((t) => t.id === taskId)
  if (!task || !dragAllowed(grouping.groupBy)) return null

  // Blocked is a column of the status grouping only.
  if (toColumn === BLOCKED_COLUMN) {
    if (fromColumn === BLOCKED_COLUMN) return null
    return { taskId, update: { id: taskId, isBlocked: true }, reorder: null, clearBlockers: false }
  }
  if (isVirtual(toColumn)) return null
  const sameColumn = fromColumn === toColumn
  if (sameColumn) {
    if (!reorderAllowed(grouping.sortBy)) return null
    if (grouping.sortBy === 'priority') {
      const over = data.tasks.find((t) => t.id === beforeTaskId)
      if (!over || over.priority !== task.priority) return null
    }
  } else if (grouping.groupBy === 'active') {
    return null
  }
  if (inGroup(task, toColumn, grouping) === null) return null

  const current = data.tasks
    .filter((t) => t.project_id === projectId && inGroup(t, toColumn, grouping))
    .map((t) => t.id)
  const rest = current.filter((id) => id !== taskId)
  let at: number
  if (beforeTaskId !== null && beforeTaskId !== taskId && rest.includes(beforeTaskId)) {
    at = rest.indexOf(beforeTaskId)
  } else if (beforeTaskId === taskId) {
    at = current.indexOf(taskId)
  } else {
    const lastVisible = [...(visibleTarget ?? [])].reverse().find((id) => id !== taskId)
    at = lastVisible && rest.includes(lastVisible) ? rest.indexOf(lastVisible) + 1 : rest.length
  }
  const reorder = [...rest.slice(0, at), taskId, ...rest.slice(at)]

  const fromBlocked = fromColumn === BLOCKED_COLUMN
  const moved = !inGroup(task, toColumn, grouping)
  if (!moved && !fromBlocked && sameOrder(reorder, current)) return null

  let update: MoveUpdate | null = null
  if (moved && grouping.groupBy === 'status') update = { id: taskId, status: toColumn }
  if (moved && grouping.groupBy === 'priority')
    update = { id: taskId, priority: priorityOf(toColumn) ?? task.priority }
  if (fromBlocked)
    update = { ...(update ?? { id: taskId }), isBlocked: false, blockedComment: null }
  return { taskId, update, reorder, clearBlockers: fromBlocked }
}

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i])

/** The board after the plan: a new object (the input is the snapshot a failed write restores). */
export function applyMovePlan(data: BoardData, plan: MovePlan): BoardData {
  const { update, reorder } = plan
  const orderOf = new Map(reorder?.map((id, i) => [id, i]) ?? [])
  const tasks: BoardTask[] = data.tasks.map((t) => {
    const order = orderOf.get(t.id)
    if (t.id !== plan.taskId && order === undefined) return t
    const next = { ...t }
    if (order !== undefined) next.order = order
    if (t.id === plan.taskId && update) {
      if (update.status !== undefined) next.status = update.status
      if (update.priority !== undefined) next.priority = update.priority
      if (update.isBlocked !== undefined) next.is_blocked = update.isBlocked
      if (update.blockedComment !== undefined) next.blocked_comment = update.blockedComment
    }
    return next
  })
  // The hub's board order is `order` first; a stable sort keeps ties as they were.
  if (reorder) tasks.sort((a, b) => a.order - b.order)

  let blockedTaskIds = data.blockedTaskIds
  if (update?.isBlocked === true && !blockedTaskIds.includes(plan.taskId)) {
    blockedTaskIds = [...blockedTaskIds, plan.taskId]
  } else if (update?.isBlocked === false) {
    blockedTaskIds = blockedTaskIds.filter((id) => id !== plan.taskId)
  }
  return { ...data, tasks, blockedTaskIds }
}
