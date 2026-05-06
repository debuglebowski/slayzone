import { app as electronApp } from 'electron'
import { join } from 'node:path'
import { getExtensionFromTitle } from '@slayzone/task/shared'

export const artifactsDir = join(electronApp.getPath('userData'), 'artifacts')

export function getArtifactFilePath(taskId: string, artifactId: string, title: string): string {
  const ext = getExtensionFromTitle(title) || '.txt'
  return join(artifactsDir, taskId, `${artifactId}${ext}`)
}
