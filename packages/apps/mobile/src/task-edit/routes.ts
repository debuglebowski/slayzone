/**
 * The create-task screen (`src/app/(tabs)/(board)/new-task.tsx`, in the Board tab):
 *
 *   /new-task?hub=<hub address>&project=<project id>[&status=<status>][&priority=<1-5>]
 *     [&due=<YYYY-MM-DD>][&parent=<task id>]
 *
 * The hub and project it opens on (both changeable there, unless it creates a subtask),
 * the status, priority or due date to start with (the board's "+" in a status, priority
 * or due-date group: desktop's `columnToCreateTaskDraft`), the parent of a subtask.
 */
export const NEW_TASK = '/new-task'

export interface NewTaskParams {
  hub: string
  project: string
  status?: string
  priority?: number
  /** YYYY-MM-DD. */
  due?: string
  parent?: string
}

export function newTaskHref(params: NewTaskParams): string {
  const query = (['hub', 'project', 'status', 'priority', 'due', 'parent'] as const)
    .flatMap((key) => {
      const value = params[key]
      return value ? [`${key}=${encodeURIComponent(String(value))}`] : []
    })
    .join('&')
  return `${NEW_TASK}?${query}`
}
