/**
 * @vitest-environment jsdom
 *
 * `useArtifactUploader` — task-artifacts' implementation of the editor's
 * `ArtifactUploader` contract. Routes through `trpcClient.artifacts.*` (the
 * imperative vanilla client via `useTRPCClient`), never a `window`-global
 * `api.artifacts` reach-through — it must work on every host (web-shell too).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const trpcClientMock = {
  artifacts: {
    foldersGetOrCreateByName: { mutate: vi.fn() },
    uploadBlob: { mutate: vi.fn() },
    getFilePath: { query: vi.fn() }
  }
}

vi.mock('@slayzone/transport/client', () => ({
  useTRPCClient: () => trpcClientMock
}))

const { useArtifactUploader } = await import('./artifact-uploader')

afterEach(() => {
  vi.clearAllMocks()
})

describe('useArtifactUploader', () => {
  it('is referentially stable across renders', () => {
    const { result, rerender } = renderHook(() => useArtifactUploader())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it('getOrCreateFolder calls foldersGetOrCreateByName and resolves the folder id', async () => {
    trpcClientMock.artifacts.foldersGetOrCreateByName.mutate.mockResolvedValueOnce({
      id: 'folder-1'
    })
    const { result } = renderHook(() => useArtifactUploader())

    const id = await result.current.getOrCreateFolder('t1', 'Screenshots')

    expect(trpcClientMock.artifacts.foldersGetOrCreateByName.mutate).toHaveBeenCalledWith({
      taskId: 't1',
      name: 'Screenshots'
    })
    expect(id).toBe('folder-1')
  })

  it('getOrCreateFolder resolves null when no folder comes back', async () => {
    trpcClientMock.artifacts.foldersGetOrCreateByName.mutate.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useArtifactUploader())
    expect(await result.current.getOrCreateFolder('t1', 'X')).toBeNull()
  })

  it('uploadBlob passes the input through and narrows the row to {id, title}', async () => {
    trpcClientMock.artifacts.uploadBlob.mutate.mockResolvedValueOnce({
      id: 'a1',
      title: 'photo.png',
      task_id: 't1',
      folder_id: null,
      extra_field_the_hook_must_drop: 'should not appear on ArtifactRef'
    })
    const { result } = renderHook(() => useArtifactUploader())
    const bytes = new Uint8Array([1, 2, 3])

    const ref = await result.current.uploadBlob({
      taskId: 't1',
      title: 'photo.png',
      bytes,
      folderId: null
    })

    expect(trpcClientMock.artifacts.uploadBlob.mutate).toHaveBeenCalledWith({
      taskId: 't1',
      title: 'photo.png',
      bytes,
      folderId: null
    })
    expect(ref).toEqual({ id: 'a1', title: 'photo.png' })
  })

  it('uploadBlob resolves null when the procedure returns nothing', async () => {
    trpcClientMock.artifacts.uploadBlob.mutate.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useArtifactUploader())
    const ref = await result.current.uploadBlob({
      taskId: 't1',
      title: 'x',
      bytes: new Uint8Array(),
      folderId: null
    })
    expect(ref).toBeNull()
  })

  it('getFilePath calls artifacts.getFilePath.query with the artifact id', async () => {
    trpcClientMock.artifacts.getFilePath.query.mockResolvedValueOnce('/data/artifacts/a1')
    const { result } = renderHook(() => useArtifactUploader())

    const path = await result.current.getFilePath('a1')

    expect(trpcClientMock.artifacts.getFilePath.query).toHaveBeenCalledWith({ id: 'a1' })
    expect(path).toBe('/data/artifacts/a1')
  })
})
