/**
 * @vitest-environment jsdom
 *
 * `useArtifactUpload` — routes through `trpcClient.artifacts.*` (imperative
 * vanilla client via `useTRPCClient`), not a `window`-global `api.artifacts` /
 * `api.artifactFolders` reach-through. Those namespaces never existed in the
 * `ElectronAPI` contract (@slayzone/types), so the unguarded cast threw on
 * every host but the Electron app — this hook is used inside `packages/apps/
 * web-shell` (renderer-app's tree), so it must work there too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

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

const { useArtifactUpload } = await import('./use-artifact-upload')

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

describe('useArtifactUpload', () => {
  it('uploads files against a task with no folder, narrowing the result to {id, title}', async () => {
    trpcClientMock.artifacts.uploadBlob.mutate.mockResolvedValueOnce({
      id: 'a1',
      title: 'photo.png',
      task_id: 't1',
      folder_id: null,
      extra_field_the_hook_must_drop: 'should not appear on ArtifactRef'
    })
    const { result } = renderHook(() => useArtifactUpload('t1'))

    let refs: unknown
    await waitFor(async () => {
      refs = await result.current.uploadFiles([makeFile('photo.png', 'x', 'image/png')])
    })

    expect(trpcClientMock.artifacts.foldersGetOrCreateByName.mutate).not.toHaveBeenCalled()
    expect(trpcClientMock.artifacts.uploadBlob.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1', title: 'photo.png', folderId: null })
    )
    expect(refs).toEqual([{ id: 'a1', title: 'photo.png' }])
  })

  it('resolves the folder first when folderName is set, then uploads into it', async () => {
    trpcClientMock.artifacts.foldersGetOrCreateByName.mutate.mockResolvedValueOnce({
      id: 'folder-1'
    })
    trpcClientMock.artifacts.uploadBlob.mutate.mockResolvedValueOnce({
      id: 'a2',
      title: 'note.txt'
    })
    const { result } = renderHook(() => useArtifactUpload('t1', { folderName: 'Screenshots' }))

    await waitFor(async () => {
      await result.current.uploadFiles([makeFile('note.txt', 'x', 'text/plain')])
    })

    expect(trpcClientMock.artifacts.foldersGetOrCreateByName.mutate).toHaveBeenCalledWith({
      taskId: 't1',
      name: 'Screenshots'
    })
    expect(trpcClientMock.artifacts.uploadBlob.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: 'folder-1' })
    )
  })

  it('a pasted file with no name gets a generated title, not the empty string', async () => {
    trpcClientMock.artifacts.uploadBlob.mutate.mockResolvedValueOnce({ id: 'a3', title: 'x' })
    const { result } = renderHook(() => useArtifactUpload('t1'))

    await waitFor(async () => {
      await result.current.uploadFiles([makeFile('', 'x', 'image/png')])
    })

    const call = trpcClientMock.artifacts.uploadBlob.mutate.mock.calls[0][0]
    expect(call.title).toMatch(/^pasted-.*\.png$/)
  })

  it('with no taskId, uploadFiles is a no-op returning []', async () => {
    const { result } = renderHook(() => useArtifactUpload(null))
    const refs = await result.current.uploadFiles([makeFile('a.png', 'x', 'image/png')])
    expect(refs).toEqual([])
    expect(trpcClientMock.artifacts.uploadBlob.mutate).not.toHaveBeenCalled()
  })

  it('getFilePath calls artifacts.getFilePath.query with the artifact id', async () => {
    trpcClientMock.artifacts.getFilePath.query.mockResolvedValueOnce('/data/artifacts/a1')
    const { result } = renderHook(() => useArtifactUpload('t1'))

    const path = await result.current.getFilePath('a1')

    expect(trpcClientMock.artifacts.getFilePath.query).toHaveBeenCalledWith({ id: 'a1' })
    expect(path).toBe('/data/artifacts/a1')
  })
})
