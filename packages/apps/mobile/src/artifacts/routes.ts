/**
 * The artifact screens (`src/app/artifacts/`) and how to name them. Like a task, an
 * artifact is named by its hub's address and its ids in that hub, so a deep link —
 * `slayzone://artifacts/<hub>/<task id>/<artifact id>` — opens it on any device signed in
 * to that hub.
 *
 *   /artifacts                              search every hub's artifacts
 *   /artifacts/<hub>/<task>                 a task's artifacts (iPad: the first beside them)
 *   /artifacts/<hub>/<task>/<id>[?version=] one artifact (iPad: beside the list)
 */

export const ARTIFACT_SEARCH = '/artifacts'

const segment = (value: string): string => encodeURIComponent(value)

export function taskArtifactsHref(hubAddress: string, taskId: string): string {
  return `/artifacts/${segment(hubAddress)}/${segment(taskId)}`
}

export function artifactHref(
  hubAddress: string,
  taskId: string,
  artifactId: string,
  options: { version?: number } = {}
): string {
  const path = `/artifacts/${segment(hubAddress)}/${segment(taskId)}/${segment(artifactId)}`
  return options.version !== undefined ? `${path}?version=${options.version}` : path
}
