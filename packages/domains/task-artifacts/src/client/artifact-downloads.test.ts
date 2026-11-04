// @vitest-environment jsdom
import { unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  base64ToBytes,
  downloadArtifactOnThisDevice,
  downloadFolderOnThisDevice,
  downloadTaskZipOnThisDevice
} from './artifact-downloads'

const saveFile = vi.fn()
const saveFiles = vi.fn()
const enc = (s: string) => new TextEncoder().encode(s)

const folders = [
  { id: 'f1', name: 'docs', parent_id: null },
  { id: 'f2', name: 'empty', parent_id: 'f1' }
]
const artifacts = [
  { id: 'a', title: 'root.md', folder_id: null },
  { id: 'b', title: 'top.md', folder_id: 'f1' },
  { id: 'gone', title: 'gone.md', folder_id: 'f1' }
]
const read = vi.fn(async (id: string) => (id === 'gone' ? null : enc(`bytes of ${id}`)))

beforeEach(() => {
  saveFile.mockReset().mockResolvedValue({ ok: true })
  saveFiles.mockReset().mockResolvedValue({ ok: true })
  ;(window as unknown as { api: unknown }).api = { app: { saveFile, saveFiles }, files: {} }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('downloadArtifactOnThisDevice', () => {
  it('saves the bytes under the title', async () => {
    await expect(downloadArtifactOnThisDevice(artifacts[0], read)).resolves.toBe(true)
    expect(saveFile).toHaveBeenCalledWith({
      fileName: 'root.md',
      title: 'Download Artifact',
      data: enc('bytes of a')
    })
  })

  it('throws when the file is gone, and is false on cancel', async () => {
    await expect(downloadArtifactOnThisDevice(artifacts[2], read)).rejects.toThrow('not found')
    saveFile.mockResolvedValue({ ok: false, canceled: true })
    await expect(downloadArtifactOnThisDevice(artifacts[0], read)).resolves.toBe(false)
  })

  it('surfaces a host error', async () => {
    saveFile.mockResolvedValue({ ok: false, error: 'EACCES' })
    await expect(downloadArtifactOnThisDevice(artifacts[0], read)).rejects.toThrow('EACCES')
  })
})

describe('downloadFolderOnThisDevice', () => {
  it('saves the folder tree, empty folders included, missing files left out', async () => {
    await expect(downloadFolderOnThisDevice(folders, artifacts, 'f1', read)).resolves.toBe(true)
    expect(saveFiles).toHaveBeenCalledWith({
      folderName: 'docs',
      title: 'Download Folder To',
      dirs: ['docs', 'docs/empty'],
      files: [{ path: 'docs/top.md', data: enc('bytes of b') }]
    })
  })

  it('is false for an unknown folder', async () => {
    await expect(downloadFolderOnThisDevice(folders, artifacts, 'x', read)).resolves.toBe(false)
    expect(saveFiles).not.toHaveBeenCalled()
  })
})

describe('downloadTaskZipOnThisDevice', () => {
  it('zips every artifact at its folder path and reveals it', async () => {
    await expect(downloadTaskZipOnThisDevice(folders, artifacts, read)).resolves.toBe(true)
    const req = saveFile.mock.calls[0][0]
    expect(req).toMatchObject({
      fileName: 'artifacts.zip',
      title: 'Download All as ZIP',
      reveal: true
    })
    const zip = unzipSync(req.data)
    expect(Object.keys(zip).sort()).toEqual(['docs/top.md', 'root.md'])
    expect(new TextDecoder().decode(zip['root.md'])).toBe('bytes of a')
  })

  it('is false with no artifacts', async () => {
    await expect(downloadTaskZipOnThisDevice(folders, [], read)).resolves.toBe(false)
  })
})

it('decodes base64', () => {
  expect(Array.from(base64ToBytes('AAH/'))).toEqual([0, 1, 255])
})
