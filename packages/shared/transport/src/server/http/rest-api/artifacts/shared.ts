import { join } from 'node:path'
import { getStateDir } from '@slayzone/platform'
import { getExtensionFromTitle } from '@slayzone/task/shared'

// Data root for artifact files — SLAYZONE_STORE_DIR (the single data-root var,
// same as hub/db.ts + ensureDataRoot), else the platform default. Lazy (function,
// not module-load const) so tests can point env at a temp root after import.
export function getArtifactsDataRoot(): string {
  return process.env.SLAYZONE_STORE_DIR || getStateDir()
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
