import type { TaskArtifact } from '@slayzone/task-contracts'
import { hubEntryOf } from '../hub-session'
import { hubTarget } from './hub-rest'
import { type UploadFile, type UploadFileRequest, uploadArtifact } from './upload'

const home = hubTarget({ entry: hubEntryOf('home.example'), token: 'h' })
const created = { id: 'a1', task_id: 't1', title: 'IMG_1.jpg' } as TaskArtifact

function fakeUpload(response: { status: number; body: string }) {
  const requests: UploadFileRequest[] = []
  const uploadFile: UploadFile = async (req) => {
    requests.push(req)
    req.onProgress?.(50, 100)
    return response
  }
  return { requests, uploadFile }
}

describe('uploadArtifact', () => {
  it('streams the file as the raw body of POST /api/artifacts on the owning hub, with its bearer', async () => {
    const { requests, uploadFile } = fakeUpload({
      status: 200,
      body: JSON.stringify({ ok: true, data: created })
    })
    const progress: number[] = []
    const artifact = await uploadArtifact(
      home,
      {
        taskId: 't1',
        file: { uri: 'file:///tmp/IMG_1.jpg', name: 'IMG_1.jpg' },
        onProgress: (sent, total) => progress.push(sent / total)
      },
      { uploadFile }
    )

    expect(artifact).toEqual(created)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://home.example/api/artifacts?taskId=t1&title=IMG_1.jpg',
      fileUri: 'file:///tmp/IMG_1.jpg',
      headers: { authorization: 'Bearer h', 'content-type': 'application/octet-stream' }
    })
    expect(progress).toEqual([0.5])
  })

  it('puts the artifact in a folder when one is named', async () => {
    const { requests, uploadFile } = fakeUpload({
      status: 200,
      body: JSON.stringify({ ok: true, data: created })
    })
    await uploadArtifact(
      home,
      { taskId: 't1', folderId: 'f 1', file: { uri: 'file:///x.pdf', name: 'Spec v2.pdf' } },
      { uploadFile }
    )
    expect(requests[0].url).toBe(
      'https://home.example/api/artifacts?taskId=t1&title=Spec%20v2.pdf&folderId=f%201'
    )
  })

  it("fails with the hub's message", async () => {
    const { uploadFile } = fakeUpload({
      status: 404,
      body: JSON.stringify({ ok: false, error: 'Task not found: t1' })
    })
    await expect(
      uploadArtifact(home, { taskId: 't1', file: { uri: 'file:///x', name: 'x' } }, { uploadFile })
    ).rejects.toMatchObject({ status: 404, message: 'Task not found: t1' })
  })

  it('says a refused bearer means signing in again', async () => {
    const { uploadFile } = fakeUpload({ status: 401, body: '{"error":"Unauthorized"}' })
    await expect(
      uploadArtifact(home, { taskId: 't1', file: { uri: 'file:///x', name: 'x' } }, { uploadFile })
    ).rejects.toMatchObject({
      status: 401,
      message: 'Your sign-in to home.example has expired. Sign in again.'
    })
  })

  it('refuses an empty title before sending anything', async () => {
    const { requests, uploadFile } = fakeUpload({ status: 200, body: '{}' })
    await expect(
      uploadArtifact(home, { taskId: 't1', file: { uri: 'file:///x', name: '  ' } }, { uploadFile })
    ).rejects.toThrow('The file has no name')
    expect(requests).toHaveLength(0)
  })
})
