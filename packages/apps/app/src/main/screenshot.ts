import { app, webContents } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import type { BrowserViewManager } from './browser-view-manager'

export async function captureBrowserViewScreenshot(
  browserViewManager: BrowserViewManager,
  viewId: string,
): Promise<{ success: boolean; path?: string }> {
  const wcId = browserViewManager.getWebContentsId(viewId)
  if (wcId == null) return { success: false }
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) return { success: false }
  try {
    const image = await wc.capturePage()
    if (image.isEmpty()) return { success: false }
    const dir = join(app.getPath('temp'), 'slayzone')
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `${randomUUID()}.png`)
    writeFileSync(filePath, image.toPNG())
    return { success: true, path: filePath }
  } catch {
    return { success: false }
  }
}
