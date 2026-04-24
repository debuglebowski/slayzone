import { app as electronApp } from 'electron'
import { join } from 'node:path'
import { getExtensionFromTitle } from '@slayzone/task/shared'

export const assetsDir = join(process.env.SLAYZONE_DB_DIR || electronApp.getPath('userData'), 'assets')

export function getAssetFilePath(taskId: string, assetId: string, title: string): string {
  const ext = getExtensionFromTitle(title) || '.txt'
  return join(assetsDir, taskId, `${assetId}${ext}`)
}
