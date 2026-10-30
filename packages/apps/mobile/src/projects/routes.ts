/**
 * The projects screens (files in `src/app/projects/`), named like a task's: by the
 * hub's address and the project's id in that hub.
 *
 *   /projects                 every hub's projects (iPad: `?hub=&project=` beside the list)
 *   /projects/<hub>/<id>      a project (iPad: beside the list)
 */
export const PROJECTS = '/projects'

const segment = (value: string): string => encodeURIComponent(value)

export function projectHref(hubAddress: string, projectId: string): string {
  return `${PROJECTS}/${segment(hubAddress)}/${segment(projectId)}`
}
