import { join } from 'node:path'
import { getStorageDir } from '@slayzone/platform'
import { getExtensionFromTitle } from '@slayzone/task/shared'

// Data root for artifact files = the single storage dir (`<ROOT>/storage`,
// derived from SLAYZONE_ROOT via platform.getStorageDir — same as the DB +
// ensureDataRoot). Lazy (function, not module-load const) so tests can point
// SLAYZONE_ROOT at a temp root.
export function getArtifactsDataRoot(): string {
  return getStorageDir()
}

export const artifactsDir = join(getArtifactsDataRoot(), 'artifacts')

export function getArtifactFilePath(taskId: string, artifactId: string, title: string): string {
  const ext = getExtensionFromTitle(title) || '.txt'
  return join(artifactsDir, taskId, `${artifactId}${ext}`)
}

/** Env-lazy variant of {@link getArtifactFilePath} for the content routes. */
export function resolveArtifactFilePath(taskId: string, artifactId: string, title: string): string {
  const ext = getExtensionFromTitle(title) || '.txt'
  return join(getArtifactsDataRoot(), 'artifacts', taskId, `${artifactId}${ext}`)
}
