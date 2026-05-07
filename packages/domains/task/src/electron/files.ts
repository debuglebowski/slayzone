import { app } from 'electron'
import { writeFile, mkdir, access } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'

export async function pathExists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true } catch { return false }
}

export async function saveTempImage(base64: string, mimeType: string): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/gif' ? 'gif' : 'jpg'
    const filename = `paste-${randomUUID()}.${ext}`
    const tempDir = join(app.getPath('temp'), 'slayzone')
    await mkdir(tempDir, { recursive: true })
    const filepath = join(tempDir, filename)
    const buffer = Buffer.from(base64, 'base64')
    await writeFile(filepath, buffer)
    return { success: true, path: filepath }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}
