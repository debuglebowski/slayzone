import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { downloadArtifactFile, type ArtifactDownloadSource } from './artifact-downloads'
import type { ArtifactDownloadHost } from './artifact-downloads'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'

test('download streams owner bytes to user-selected destination without a hub working copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-download-')),
    dest = join(dir, 'out.pdf'),
    bytes = Buffer.from([0, 255, 128])
  const h = await createTestHarness()
  try {
    const source: ArtifactDownloadSource = {
      get: async () => ({ id: 'a', task_id: 't', title: 'real.pdf' }),
      read: async () => bytes,
      artifacts: async () => [],
      folders: async () => [],
      folder: async () => undefined
    }
    const unused = async () => {
      throw new Error('Unexpected download host operation')
    }
    const host: ArtifactDownloadHost = {
      getDownloadsDir: async () => dir,
      showSaveDialog: async () => ({ canceled: false, filePath: dest }),
      showOpenDialog: unused,
      showItemInFolder: () => {
        throw new Error('Unexpected download host operation')
      },
      buildExportHtml: unused,
      renderPdfToFile: unused,
      renderPngToFile: unused
    }
    await expect(
      downloadArtifactFile(host, h.slayDb, join(dir, 'no-hub-copy'), 'a', source)
    ).resolves.toBe(true)
    expect(readFileSync(dest)).toEqual(bytes)
  } finally {
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})
