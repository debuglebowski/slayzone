import path from 'node:path'
import { assertPathSafeId, containedPath } from '@slayzone/platform/safe-path'
import { getExtensionFromTitle } from '@slayzone/task/shared'

// The ONE place an artifact's on-disk location is computed:
// `<dataDir>/artifacts/<taskId>/<artifactId><ext>`. The store, the named txns, task
// cleanup and the REST routes all come here, so every task/artifact id is checked as
// one plain path segment and every result stays inside its base before any disk access
// (T-104: a task id of `..` used to name the data dir itself).

export function artifactsDirOf(dataDir: string): string {
  return path.join(dataDir, 'artifacts')
}

/** `<artifactsDir>/<taskId>`, strictly inside `artifactsDir`. Throws `UnsafePathError`. */
export function artifactTaskDir(artifactsDir: string, taskId: string): string {
  return containedPath(artifactsDir, assertPathSafeId(taskId, 'taskId'))
}

/**
 * `<artifactsDir>/<taskId>/<artifactId><ext>`, where `<ext>` comes from the title
 * (`.txt` without one). Strictly inside the task dir. Throws `UnsafePathError`.
 */
export function artifactFilePathIn(
  artifactsDir: string,
  taskId: string,
  artifactId: string,
  title: string
): string {
  const ext = getExtensionFromTitle(title) || '.txt'
  return containedPath(
    artifactTaskDir(artifactsDir, taskId),
    `${assertPathSafeId(artifactId, 'artifactId')}${ext}`
  )
}
