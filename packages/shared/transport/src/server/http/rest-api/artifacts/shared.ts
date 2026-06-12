import { join } from 'node:path'
import { getStateDir } from '@slayzone/platform'
import { getExtensionFromTitle } from '@slayzone/task/shared'

// Same resolution the Electron host used: SLAYZONE_DB_DIR override first, then
// the data root (the app sets `userData` to this same dir at boot, so swapping
// app.getPath('userData') for the platform helper is behavior-preserving — and
// it works in the standalone server, which has no Electron `app`).
export const artifactsDir = join(
  process.env.SLAYZONE_DB_DIR || process.env.SLAYZONE_STORE_DIR || getStateDir(),
  'artifacts'
)

export function getArtifactFilePath(taskId: string, artifactId: string, title: string): string {
  const ext = getExtensionFromTitle(title) || '.txt'
  return join(artifactsDir, taskId, `${artifactId}${ext}`)
}
