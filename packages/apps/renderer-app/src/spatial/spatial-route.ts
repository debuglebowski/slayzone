// Spatial (visionOS POC) panel routing.
//
// A spatial host opens every panel as its own window, each loading this same
// bundle with a `?spatial=<panel>` query. The query is the whole contract
// between the web renderer and the native host: the host never needs to know
// how a panel renders, only which route to load.

export type SpatialRoute =
  | { panel: 'launcher' }
  | { panel: 'board'; projectId: string }
  | { panel: 'task'; taskId: string }

const PANEL_PARAM = 'spatial'
const PROJECT_PARAM = 'project'
const TASK_PARAM = 'task'

/** The spatial route in a `location.search` string, or null when the page is not spatial.
 *  A spatial page with an unknown panel or a missing id falls back to the launcher. */
export function parseSpatialRoute(search: string): SpatialRoute | null {
  const params = new URLSearchParams(search)
  const panel = params.get(PANEL_PARAM)
  if (panel === null) return null
  if (panel === 'board') {
    const projectId = params.get(PROJECT_PARAM)
    if (projectId) return { panel, projectId }
  }
  if (panel === 'task') {
    const taskId = params.get(TASK_PARAM)
    if (taskId) return { panel, taskId }
  }
  return { panel: 'launcher' }
}

/** The `?…` search string that loads `route`. */
export function spatialRouteSearch(route: SpatialRoute): string {
  const params = new URLSearchParams({ [PANEL_PARAM]: route.panel })
  if (route.panel === 'board') params.set(PROJECT_PARAM, route.projectId)
  if (route.panel === 'task') params.set(TASK_PARAM, route.taskId)
  return `?${params.toString()}`
}
