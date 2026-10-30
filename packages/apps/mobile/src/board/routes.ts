/**
 * The create-task screen of the Tasks tab (`new-task`, the task-detail wave's route):
 * the hub by address (like every route), the project's id on it, optionally the status
 * the task starts in (a column's "+") and its parent (a subtask).
 */
export const NEW_TASK = '/new-task'

export interface NewTaskTarget {
  /** The hub's address (`hub.label`). */
  hub: string
  project: string
  status?: string
  parent?: string
}

export function newTaskHref({ hub, project, status, parent }: NewTaskTarget): string {
  // By hand: React Native's URLSearchParams lacks most of its methods.
  const params: [string, string][] = [
    ['hub', hub],
    ['project', project]
  ]
  if (status) params.push(['status', status])
  if (parent) params.push(['parent', parent])
  return `${NEW_TASK}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`
}
