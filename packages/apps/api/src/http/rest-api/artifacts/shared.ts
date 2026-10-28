import { getStorageDir } from '@slayzone/platform'
import { artifactFilePathIn, artifactsDirOf } from '@slayzone/task/server'

// Data root for artifact files = the single storage dir (`<ROOT>/storage`,
// derived from SLAYZONE_ROOT via platform.getStorageDir — same as the DB +
// ensureDataRoot). Lazy (function, not module-load const) so tests can point
// SLAYZONE_ROOT at a temp root.
export function getArtifactsDataRoot(): string {
  return getStorageDir()
}

export const artifactsDir = artifactsDirOf(getArtifactsDataRoot())

// Both go through the task domain's one artifact-path helper, which refuses an id that
// is not one plain path segment (`UnsafePathError`).
export function getArtifactFilePath(taskId: string, artifactId: string, title: string): string {
  return artifactFilePathIn(artifactsDir, taskId, artifactId, title)
}

/** Env-lazy variant of {@link getArtifactFilePath} for the content routes. */
export function resolveArtifactFilePath(taskId: string, artifactId: string, title: string): string {
  return artifactFilePathIn(artifactsDirOf(getArtifactsDataRoot()), taskId, artifactId, title)
}
