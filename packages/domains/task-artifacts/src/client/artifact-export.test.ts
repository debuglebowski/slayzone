// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactExportRequest } from '@slayzone/platform/electron-bootstrap-contract'
import { exportArtifactOnThisDevice } from './artifact-export'

const exportArtifact = vi.fn<(req: ArtifactExportRequest) => Promise<unknown>>()

beforeEach(() => {
  exportArtifact.mockReset()
  ;(window as unknown as { api: unknown }).api = { app: { exportArtifact }, files: {} }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('exportArtifactOnThisDevice', () => {
  it('hands the host the content and effective mode', async () => {
    exportArtifact.mockResolvedValue({ ok: true })
    await expect(
      exportArtifactOnThisDevice({ title: 'notes.md', render_mode: null }, '# hi', 'pdf')
    ).resolves.toBe(true)
    expect(exportArtifact).toHaveBeenCalledWith({
      format: 'pdf',
      content: '# hi',
      mode: 'markdown',
      title: 'notes.md'
    })
  })

  it('honours an explicit render mode', async () => {
    exportArtifact.mockResolvedValue({ ok: true })
    await exportArtifactOnThisDevice({ title: 'd.txt', render_mode: 'mermaid-preview' }, 'g', 'png')
    expect(exportArtifact.mock.calls[0][0].mode).toBe('mermaid-preview')
  })

  it('is false without asking the host when the mode has no such export', async () => {
    await expect(
      exportArtifactOnThisDevice({ title: 'notes.md', render_mode: null }, '# hi', 'png')
    ).resolves.toBe(false)
    expect(exportArtifact).not.toHaveBeenCalled()
  })

  it('is false when the person cancels the save dialog', async () => {
    exportArtifact.mockResolvedValue({ ok: false, canceled: true })
    await expect(
      exportArtifactOnThisDevice({ title: 'a.svg', render_mode: null }, '<svg/>', 'png')
    ).resolves.toBe(false)
  })

  it('throws the host error', async () => {
    exportArtifact.mockResolvedValue({ ok: false, error: 'disk full' })
    await expect(
      exportArtifactOnThisDevice({ title: 'a.svg', render_mode: null }, '<svg/>', 'pdf')
    ).rejects.toThrow('disk full')
  })

  it('reports a host without export as unsupported', async () => {
    ;(window as unknown as { api: unknown }).api = { app: {}, files: {} }
    await expect(
      exportArtifactOnThisDevice({ title: 'a.svg', render_mode: null }, '<svg/>', 'pdf')
    ).rejects.toThrow('not supported')
  })
})
