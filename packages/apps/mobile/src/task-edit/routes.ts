/**
 * The create-task screen (`src/app/(tabs)/(tasks)/new-task.tsx`, in the Tasks tab):
 *
 *   /new-task?hub=<hub address>&project=<project id>[&status=<status>][&parent=<task id>]
 *
 * The hub and project it opens on (both changeable there, unless it creates a subtask),
 * the status to start with (a board column's "+"), the parent of a subtask.
 */
export const NEW_TASK = '/new-task'

export interface NewTaskParams {
  hub: string
  project: string
  status?: string
  parent?: string
}

export function newTaskHref(params: NewTaskParams): string {
  const query = (['hub', 'project', 'status', 'parent'] as const)
    .flatMap((key) => {
      const value = params[key]
      return value ? [`${key}=${encodeURIComponent(value)}`] : []
    })
    .join('&')
  return `${NEW_TASK}?${query}`
}
