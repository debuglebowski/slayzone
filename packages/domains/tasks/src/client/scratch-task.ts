/**
 * Temporary ("scratch") tasks: a throwaway agent session in a project, named
 * "Terminal N", hidden from the board. Desktop opens one as a tab (⌘T), mobile from
 * the board's ＋. "Keep as task" turns one into a regular, started task.
 *
 * DOM- and React-free: exported through `@slayzone/tasks/board` for the mobile app.
 */
import type { CreateTaskInput, UpdateTaskInput } from '@slayzone/task-contracts'
import { type ColumnConfig, getDefaultStatus, getStatusByCategory } from '@slayzone/workflow'

const SCRATCH_TITLE = /^Terminal (\d+)$/

/** The `task.create` input of a new temporary task in `project`. */
export function scratchTaskInput(
  project: { id: string; columns_config: ColumnConfig[] | null },
  tasks: readonly { project_id: string; title: string }[]
): CreateTaskInput {
  let highest = 0
  for (const task of tasks) {
    if (task.project_id !== project.id) continue
    const match = SCRATCH_TITLE.exec(task.title)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return {
    projectId: project.id,
    title: `Terminal ${highest + 1}`,
    status: getDefaultStatus(project.columns_config),
    isTemporary: true,
    // Opened right away — lets the hub hand it the project's warm agent.
    openAfterCreate: true
  }
}

/** The `task.update` input that keeps a temporary task as a regular, started one. */
export function keepScratchTaskInput(
  taskId: string,
  columns: ColumnConfig[] | null | undefined
): UpdateTaskInput {
  return {
    id: taskId,
    title: 'Untitled task',
    status: getStatusByCategory('started', columns) ?? getDefaultStatus(columns),
    isTemporary: false
  }
}
