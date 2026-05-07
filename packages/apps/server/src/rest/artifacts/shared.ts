import { join } from 'node:path'
import { getDataRoot } from '@slayzone/platform'
import { getExtensionFromTitle } from '@slayzone/task/shared'

export { getDataRoot } from '@slayzone/platform'

export function getArtifactsDir(dataRoot: string = getDataRoot()): string {
  return join(dataRoot, 'artifacts')
}

export function getArtifactFilePath(
  taskId: string,
  artifactId: string,
  title: string,
  dataRoot: string = getDataRoot(),
): string {
  const ext = getExtensionFromTitle(title) || '.txt'
  return join(getArtifactsDir(dataRoot), taskId, `${artifactId}${ext}`)
}

/** @deprecated use getArtifactsDir() — module-level constant unsafe before getDataRoot() resolves. */
export const artifactsDir = getArtifactsDir()
