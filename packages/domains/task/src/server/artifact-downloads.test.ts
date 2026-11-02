import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { downloadArtifactFile, type ArtifactDownloadSource } from './artifact-downloads'

test('download streams owner bytes to user-selected destination without a hub working copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-download-')),
    dest = join(dir, 'out.pdf'),
    bytes = Buffer.from([0, 255, 128])
  try {
    const source: ArtifactDownloadSource = {
      get: async () => ({ id: 'a', task_id: 't', title: 'real.pdf' }),
      read: async () => bytes,
      artifacts: async () => [],
      folders: async () => [],
      folder: async () => undefined
    }
    const host = {
      getDownloadsDir: async () => dir,
      showSaveDialog: async () => ({ canceled: false, filePath: dest })
    }
    await expect(
      downloadArtifactFile(host as any, {} as any, join(dir, 'no-hub-copy'), 'a', source)
    ).resolves.toBe(true)
    expect(readFileSync(dest)).toEqual(bytes)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
