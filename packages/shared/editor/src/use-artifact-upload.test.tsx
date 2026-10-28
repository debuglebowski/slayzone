/**
 * @vitest-environment jsdom
 *
 * `useArtifactUpload` — the editor's paste/drop upload hook. Storage goes
 * through the app-registered `ArtifactUploader` (registerArtifactUploader); the
 * editor itself never calls a tRPC route. The real tRPC-backed uploader is
 * tested in @slayzone/task-artifacts (`artifact-uploader.test.tsx`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { registerArtifactUploader, useArtifactUpload } from './use-artifact-upload'

const uploader = {
  getOrCreateFolder: vi.fn(),
  uploadBlob: vi.fn(),
  getFilePath: vi.fn()
}
const useFakeUploader = () => uploader
registerArtifactUploader(useFakeUploader)

afterEach(() => {
  vi.clearAllMocks()
})

// jsdom's `File` polyfill in this vitest environment does not implement
// `.arrayBuffer()` — the hook only ever reads `.name`, `.type`, and
// `.arrayBuffer()`, so a minimal fake covering exactly that shape avoids the
// jsdom gap entirely rather than fighting it.
function makeFile(name: string, content: string, type: string): File {
  const bytes = new TextEncoder().encode(content)
  return { name, type, arrayBuffer: async () => bytes.buffer } as unknown as File
}

describe('registerArtifactUploader', () => {
  it('re-registering the same hook is a no-op; a different one throws', () => {
    expect(() => registerArtifactUploader(useFakeUploader)).not.toThrow()
    expect(() => registerArtifactUploader(() => uploader)).toThrow(/already registered/)
  })
})

describe('useArtifactUpload', () => {
  it('uploads files against a task with no folder', async () => {
    uploader.uploadBlob.mockResolvedValueOnce({ id: 'a1', title: 'photo.png' })
    const { result } = renderHook(() => useArtifactUpload('t1'))

    let refs: unknown
    await waitFor(async () => {
      refs = await result.current.uploadFiles([makeFile('photo.png', 'x', 'image/png')])
    })

    expect(uploader.getOrCreateFolder).not.toHaveBeenCalled()
    expect(uploader.uploadBlob).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1', title: 'photo.png', folderId: null })
    )
    expect(uploader.uploadBlob.mock.calls[0][0].bytes).toBeInstanceOf(Uint8Array)
    expect(refs).toEqual([{ id: 'a1', title: 'photo.png' }])
  })

  it('resolves the folder first when folderName is set, then uploads into it', async () => {
    uploader.getOrCreateFolder.mockResolvedValueOnce('folder-1')
    uploader.uploadBlob.mockResolvedValueOnce({ id: 'a2', title: 'note.txt' })
    const { result } = renderHook(() => useArtifactUpload('t1', { folderName: 'Screenshots' }))

    await waitFor(async () => {
      await result.current.uploadFiles([makeFile('note.txt', 'x', 'text/plain')])
    })

    expect(uploader.getOrCreateFolder).toHaveBeenCalledWith('t1', 'Screenshots')
    expect(uploader.uploadBlob).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: 'folder-1' })
    )
  })

  it('a pasted file with no name gets a generated title, not the empty string', async () => {
    uploader.uploadBlob.mockResolvedValueOnce({ id: 'a3', title: 'x' })
    const { result } = renderHook(() => useArtifactUpload('t1'))

    await waitFor(async () => {
      await result.current.uploadFiles([makeFile('', 'x', 'image/png')])
    })

    const call = uploader.uploadBlob.mock.calls[0][0]
    expect(call.title).toMatch(/^pasted-.*\.png$/)
  })

  it('drops uploads that resolve null', async () => {
    uploader.uploadBlob.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useArtifactUpload('t1'))
    const refs = await result.current.uploadFiles([makeFile('a.png', 'x', 'image/png')])
    expect(refs).toEqual([])
  })

  it('with no taskId, uploadFiles is a no-op returning []', async () => {
    const { result } = renderHook(() => useArtifactUpload(null))
    const refs = await result.current.uploadFiles([makeFile('a.png', 'x', 'image/png')])
    expect(refs).toEqual([])
    expect(uploader.uploadBlob).not.toHaveBeenCalled()
  })

  it('getFilePath delegates to the uploader with the artifact id', async () => {
    uploader.getFilePath.mockResolvedValueOnce('/data/artifacts/a1')
    const { result } = renderHook(() => useArtifactUpload('t1'))

    const path = await result.current.getFilePath('a1')

    expect(uploader.getFilePath).toHaveBeenCalledWith('a1')
    expect(path).toBe('/data/artifacts/a1')
  })
})
