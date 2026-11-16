import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as turn } from 'node:timers/promises'
import { expect, test, vi } from 'vitest'
import { BYTE_RANGE_MAX_CHUNK } from '@slayzone/platform/bounded-reads'
import { createHubRequestHandler } from '../main'
import { projectScopedDeps } from '../project-scope.fixture'

const walk = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))

test('actual first fallback-content range keeps native reads and full verification off the main control turn', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'content-range-control-'))
  const folder = fs.realpathSync(tmpdir())
  const deps = projectScopedDeps({ p1: folder })
  const dispatch = createHubRequestHandler({
    ...deps,
    stateDir: dir,
    hubScope: 'hub',
    getComputerId: () => 'pc',
    shutdown: () => {},
    dialer: { notify: () => true },
    config: {
      hubUrl: 'ws://hub/computers',
      name: 'fixture',
      allowedRoots: [folder],
      capabilities: ['proc']
    }
  })
  const actor = { userId: null, route: 'test range' }
  const request = (p: unknown) => dispatch.handle('chat.request', p, actor)
  const route = { id: 'c', epoch: 1 }
  let unblock!: () => void
  const gate = new Promise<void>((r) => {
    unblock = r
  })
  let pending: Promise<unknown> | undefined
  try {
    await request({
      kind: 'bootstrap',
      value: {
        identity: { ...route, taskId: 't', tabId: 'tab', mode: 'claude-chat' },
        projectId: 'p1',
        cwd: folder,
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      }
    })
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0x61)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const begun = (await request({
      kind: 'upload.begin',
      route,
      operationId: 'setup',
      sha256,
      size: bytes.length
    })) as { uploadId: string }
    for (let offset = 0; offset < bytes.length; offset += BYTE_RANGE_MAX_CHUNK)
      await request({
        kind: 'upload.chunk',
        route,
        uploadId: begun.uploadId,
        sha256,
        size: bytes.length,
        offset,
        data: bytes.subarray(offset, offset + BYTE_RANGE_MAX_CHUNK).toString('base64')
      })
    const artifact = (await request({
      kind: 'artifact.invoke',
      value: {
        route,
        method: 'uploadArtifactBlob',
        operationId: 'setup',
        args: [
          {
            taskId: 't',
            title: 'large.txt',
            staged: { sha256, size: bytes.length, uploadId: begun.uploadId }
          }
        ]
      }
    })) as { id: string }
    const working = walk(dir).find(
      (p) => p.includes('/artifacts/') && p.split('/').pop()!.startsWith(artifact.id)
    )!
    fs.unlinkSync(working)
    const probe = await open(join(dir, 'probe'), 'w')
    const prototype = Object.getPrototypeOf(probe)
    await probe.close()
    const read = prototype.read
    let entered = false,
      replied = false,
      reads = 0,
      syncBytes = 0
    vi.spyOn(prototype, 'read').mockImplementation(async function (
      this: FileHandle,
      ...args: unknown[]
    ) {
      expect(args[2]).toBeLessThanOrEqual(BYTE_RANGE_MAX_CHUNK)
      if (++reads === 1) {
        entered = true
        await gate
      }
      return read.apply(this, args)
    })
    const syncRead = fs.readSync
    vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const size = Reflect.apply(syncRead, fs, args) as number
      syncBytes += size
      return size
    })
    syncBuiltinESMExports()
    pending = request({
      kind: 'artifact.invoke',
      value: {
        route,
        method: 'readRange',
        args: [artifact.id, { kind: 'content' }, 0, BYTE_RANGE_MAX_CHUNK]
      }
    }).then((v) => {
      replied = true
      return v
    })
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 2000 })
    await turn()
    expect(await dispatch.handle('proc.list', {}, actor)).toEqual({ sessions: [], exited: [] })
    expect(replied).toBe(false)
    unblock()
    const page = (await pending) as { data: string; size: number }
    expect(Buffer.from(page.data, 'base64')).toEqual(bytes.subarray(0, BYTE_RANGE_MAX_CHUNK))
    expect(page.size).toBe(bytes.length)
    expect(reads).toBeGreaterThan(16)
    expect(syncBytes).toBe(0)
  } finally {
    unblock()
    await pending?.catch(() => {})
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    await dispatch.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(deps.stateDir, { recursive: true, force: true })
  }
})
