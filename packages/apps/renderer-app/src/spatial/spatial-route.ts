import type { TaskWindowPanel } from '@slayzone/task/client/TaskDetailPage'

export interface SpatialGroup {
  id: string
  name: string
}

export const spatialTaskPanels = [
  'terminal',
  'settings'
] as const satisfies readonly TaskWindowPanel[]
export type SpatialTaskPanel = (typeof spatialTaskPanels)[number]

function isSpatialTaskPanel(value: string | null): value is SpatialTaskPanel {
  return spatialTaskPanels.some((panel) => panel === value)
}

export type SpatialRoute =
  | { panel: 'launcher' }
  | { panel: 'board'; projectId: string; group?: SpatialGroup }
  | { panel: 'task'; taskId: string; group?: SpatialGroup }
  | { panel: 'panel'; taskId: string; view: SpatialTaskPanel; group?: SpatialGroup }

/** Unknown or incomplete spatial links open the launcher. */
export function parseSpatialRoute(search: string): SpatialRoute | null {
  const params = new URLSearchParams(search)
  const panel = params.get('spatial')
  if (panel === null) return null

  const id = params.get('group')
  const name = params.get('groupName')
  const scope = id && name ? { group: { id, name } } : {}
  const projectId = params.get('project')
  const taskId = params.get('task')
  const view = params.get('view')

  if (panel === 'board' && projectId) return { panel, projectId, ...scope }
  if (panel === 'task' && taskId) return { panel, taskId, ...scope }
  if (panel === 'panel' && taskId && isSpatialTaskPanel(view)) {
    return { panel, taskId, view, ...scope }
  }
  return { panel: 'launcher' }
}

export function spatialRouteSearch(route: SpatialRoute): string {
  const params = new URLSearchParams({ spatial: route.panel })
  if (route.panel === 'board') params.set('project', route.projectId)
  if (route.panel === 'task' || route.panel === 'panel') params.set('task', route.taskId)
  if (route.panel === 'panel') params.set('view', route.view)
  if (route.panel !== 'launcher' && route.group) {
    params.set('group', route.group.id)
    params.set('groupName', route.group.name)
  }
  return `?${params.toString()}`
}
