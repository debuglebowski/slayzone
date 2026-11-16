import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as turn } from 'node:timers/promises'
import { expect, test, vi } from 'vitest'
import { createHubRequestHandler } from '../main'
import { projectScopedDeps } from '../project-scope.fixture'

test('main dispatch serves process control and heartbeat while upload native sync awaits durability', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'upload-main-responsive-'))
  const folder = realpathSync(tmpdir())
  const deps = projectScopedDeps({ p1: folder })
  const dispatch = createHubRequestHandler({
    ...deps,
    stateDir,
    hubScope: 'hub',
    getComputerId: () => 'computer',
    shutdown: () => {},
    dialer: { notify: () => true },
    config: {
      hubUrl: 'ws://hub/computers',
      name: 'test',
      allowedRoots: [folder],
      capabilities: ['proc']
    }
  })
  const actor = { userId: null, route: 'test upload' }
  const request = (params: unknown) => dispatch.handle('chat.request', params, actor)
  let unblock!: () => void
  const block = new Promise<void>((r) => {
    unblock = r
  })
  let pending: Promise<unknown> | undefined
  try {
    await request({
      kind: 'bootstrap',
      value: {
        identity: { id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
        projectId: 'p1',
        cwd: folder,
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      }
    })
    const bytes = Buffer.from('durable chunk')
    const sha256 = createHash('sha256').update(bytes).digest('hex'),
      route = { id: 'c', epoch: 1 }
    const ref = (await request({
      kind: 'upload.begin',
      route,
      operationId: 'upload',
      sha256,
      size: bytes.length
    })) as { uploadId: string }
    const probe = await open(join(stateDir, 'sync-probe'), 'w')
    const prototype = Object.getPrototypeOf(probe)
    await probe.close()
    const original = prototype.sync
    let entered = false,
      acknowledged = false
    vi.spyOn(prototype, 'sync').mockImplementationOnce(async function (this: FileHandle) {
      entered = true
      await block
      return original.call(this)
    })
    pending = request({
      kind: 'upload.chunk',
      route,
      uploadId: ref.uploadId,
      sha256,
      size: bytes.length,
      offset: 0,
      data: bytes.toString('base64')
    }).then((v) => {
      acknowledged = true
      return v
    })
    await vi.waitFor(() => expect(entered).toBe(true))
    let heartbeat = false
    const beat = turn().then(() => {
      heartbeat = true
    })
    expect(await dispatch.handle('proc.list', {}, actor)).toEqual({ sessions: [], exited: [] })
    await beat
    expect(heartbeat).toBe(true)
    expect(acknowledged).toBe(false)
    unblock()
    expect(await pending).toEqual({ received: bytes.length })
  } finally {
    unblock()
    await pending?.catch(() => {})
    vi.restoreAllMocks()
    await dispatch.dispose()
    await rm(stateDir, { recursive: true, force: true })
    await rm(deps.stateDir, { recursive: true, force: true })
  }
})
