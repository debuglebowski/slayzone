/** Actual source controller + packaged canonical owner: failed startup owns rollback through exit. */
import * as owners from './storage-owner'
import * as uploads from './upload-staging'
import * as publications from './artifact-publication-client'
import * as terminal from '@slayzone/terminal/runtime'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, expect, test, vi, type MockInstance } from 'vitest'
import { openComputerChatRuntime } from './computer-online-runtime'
import { chatStorageDigest } from './storage-digest'
// Fails the test on a lifecycle model / runtime disagreement.
import '../../../terminal/src/server/runtime/chat-lifecycle-strict-testkit'

const workerPath = fileURLToPath(new URL('../../../../apps/computer/dist/bin.cjs', import.meta.url))
type Captured = {
  owner: owners.AsyncChatStorage
  close: MockInstance<owners.AsyncChatStorage['close']>
  terminate: MockInstance<owners.AsyncChatStorage['terminate']>
  exited(): boolean
  retire(): Promise<void>
}
const captured: Captured[] = [],
  directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const entry of captured.splice(0)) await entry.retire()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function root() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'online-startup-')))
  directories.push(dir)
  return dir
}
function observe(prepare?: (owner: owners.AsyncChatStorage) => Promise<void>) {
  const original = owners.openChatStorageOwner
  vi.spyOn(owners, 'openChatStorageOwner').mockImplementation(async (opts) => {
    const owner = await original(opts),
      retire = owner.terminate.bind(owner)
    let exited = false
    void owner.exited.then(() => {
      exited = true
    })
    captured.push({
      owner,
      close: vi.spyOn(owner, 'close'),
      terminate: vi.spyOn(owner, 'terminate'),
      exited: () => exited,
      retire
    })
    await prepare?.(owner)
    return owner
  })
}
function open(stateDir: string) {
  return openComputerChatRuntime({
    stateDir,
    hubScope: 'hub',
    computerId: 'pc',
    workerPath,
    blobBackfill: { automatic: false },
    markerBackfill: { automatic: false },
    compaction: { automaticReclaim: false }
  })
}
function causes(error: unknown): unknown[] {
  return [error, ...(error instanceof AggregateError ? error.errors.flatMap(causes) : [])]
}
async function rejection(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => {
      throw new Error('Startup unexpectedly succeeded')
    },
    (error) => error
  )
}
async function retired(entry: Captured) {
  expect(entry.close).toHaveBeenCalledTimes(1)
  expect(entry.exited()).toBe(true)
  await expect(entry.owner.conversation('missing')).rejects.toThrow(/closed|exited|stopped/i)
}

test('failed upload initialization attempts its rejecting cleanup and retires the real owner before retry', async () => {
  const stateDir = root(),
    uploadsPath = join(stateDir, 'computer-runtime', chatStorageDigest('hub'), 'uploads')
  mkdirSync(join(uploadsPath, '..'), { recursive: true })
  writeFileSync(uploadsPath, 'not a directory')
  observe()
  const error = await rejection(open(stateDir))
  expect(error).toBeInstanceOf(AggregateError)
  expect((error as AggregateError).cause).toMatchObject({ code: 'EEXIST' })
  expect((error as AggregateError).errors).toHaveLength(2)
  await retired(captured[0])
  rmSync(uploadsPath)
  const retry = await open(stateDir)
  try {
    expect(captured).toHaveLength(2)
    expect(captured[0].exited()).toBe(true)
    expect(captured[1].exited()).toBe(false)
    await retry.bootstrap({
      identity: { id: 'c', taskId: 't', tabId: 'tab', epoch: 1, mode: 'claude-chat' },
      projectId: null,
      cwd: stateDir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
    expect(await retry.storage.conversation('c')).toMatchObject({ identity: { taskId: 't' } })
  } finally {
    await retry.close()
  }
  expect(captured[1].exited()).toBe(true)
})

test('later controller failure attempts publication/upload/queue/transport cleanup and preserves every cause', async () => {
  const initial = new Error('controller creation failed'),
    pubError = new Error('publication cleanup failed'),
    uploadError = new Error('upload cleanup failed'),
    queueError = new Error('queue cleanup failed'),
    transportError = { id: 'startup-tab', phase: 'shutdown', message: 'transport cleanup failed' }
  observe()
  const makeUploads = uploads.createUploadStaging
  const uploadClose = vi.fn<() => Promise<void>>()
  vi.spyOn(uploads, 'createUploadStaging').mockImplementation((...args) => {
    const manager = makeUploads(...args),
      close = manager.close.bind(manager)
    uploadClose.mockImplementation(async () => {
      await close()
      throw uploadError
    })
    vi.spyOn(manager, 'close').mockImplementation(uploadClose)
    return manager
  })
  const makePublication = publications.createArtifactPublicationClient
  const pubClose = vi.fn<() => Promise<void>>().mockRejectedValue(pubError)
  vi.spyOn(publications, 'createArtifactPublicationClient').mockImplementation((...args) => {
    const client = makePublication(...args)
    vi.spyOn(client, 'close').mockImplementation(pubClose)
    return client
  })
  const makeTransport = terminal.createChatTransport,
    shutdown = vi.fn()
  vi.spyOn(terminal, 'createChatTransport').mockImplementation((...args) => {
    const transport = makeTransport(...args)
    const close = transport.shutdownAll.bind(transport)
    shutdown.mockImplementation(async () => {
      const result = await close()
      return { ...result, errors: [...result.errors, transportError] }
    })
    vi.spyOn(transport, 'shutdownAll').mockImplementation(shutdown)
    return transport
  })
  const makeQueue = terminal.createChatQueueRuntime,
    queueClose = vi.fn<() => Promise<void>>()
  vi.spyOn(terminal, 'createChatQueueRuntime').mockImplementation((...args) => {
    const queue = makeQueue(...args),
      close = queue.close.bind(queue)
    queueClose.mockImplementation(async () => {
      await close()
      throw queueError
    })
    vi.spyOn(queue, 'close').mockImplementation(queueClose)
    return queue
  })
  vi.spyOn(terminal, 'createChatOps').mockImplementation(() => {
    throw initial
  })
  const error = await rejection(open(root()))
  expect(error).toBeInstanceOf(AggregateError)
  expect((error as AggregateError).cause).toBe(initial)
  expect(causes(error)).toEqual(
    expect.arrayContaining([initial, pubError, uploadError, queueError, transportError])
  )
  expect(pubClose).toHaveBeenCalledTimes(1)
  expect(uploadClose).toHaveBeenCalledTimes(1)
  expect(queueClose).toHaveBeenCalledTimes(1)
  expect(shutdown).toHaveBeenCalledTimes(1)
  await retired(captured[0])
})

test('early close/terminate rejection cannot acknowledge failed startup before actual physical exit', async () => {
  const initial = new Error('publication creation failed'),
    closeError = new Error('early close rejection'),
    terminateError = new Error('early terminate rejection')
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    terminating = new Promise<void>((resolve) => {
      entered = resolve
    })
  let physical: Promise<void> | undefined
  observe(async (owner) => {
    const terminate = captured[captured.length - 1].retire
    vi.mocked(owner.close).mockRejectedValue(closeError)
    vi.mocked(owner.terminate).mockImplementation(() => {
      entered()
      physical = gate.then(terminate)
      void physical.catch(() => undefined)
      return Promise.reject(terminateError)
    })
  })
  vi.spyOn(publications, 'createArtifactPublicationClient').mockImplementation(() => {
    throw initial
  })
  let acknowledged = false
  const failed = rejection(open(root())).then((error) => {
    acknowledged = true
    return error
  })
  try {
    await vi.waitFor(() => expect(captured[0]?.close).toHaveBeenCalledTimes(1))
    // Wait for the actual termination attempt, not for a fabricated exit promise.
    await Promise.race([
      terminating,
      failed.then(() => {
        throw new Error('Startup rejected before retiring its owner')
      })
    ])
    expect(acknowledged).toBe(false)
    expect(captured[0].exited()).toBe(false)
    expect(await captured[0].owner.conversation('missing')).toBeNull()
    release()
    const error = await failed
    expect((error as AggregateError).cause).toBe(initial)
    expect(causes(error)).toEqual(expect.arrayContaining([initial, closeError, terminateError]))
    expect(captured[0].exited()).toBe(true)
    await expect(captured[0].owner.conversation('missing')).rejects.toThrow(
      /closed|exited|stopped/i
    )
  } finally {
    release()
    await failed
    await physical
  }
})

test.skipIf(process.platform === 'win32')(
  'real native startup-rollback fence failure retains SQLITE_IOERR_FSYNC and retires the owner',
  async () => {
    const stateDir = root(),
      extension = join(stateDir, process.platform === 'darwin' ? 'syncprobe.dylib' : 'syncprobe.so')
    execFileSync('cc', [
      '-std=c11',
      ...(process.platform === 'darwin' ? ['-dynamiclib'] : ['-shared', '-fPIC']),
      '-O2',
      '-pthread',
      '-I',
      fileURLToPath(
        new URL('../../../../../node_modules/better-sqlite3/deps/sqlite3', import.meta.url)
      ),
      fileURLToPath(new URL('./storage-fence.syncprobe.c', import.meta.url)),
      '-o',
      extension
    ])
    const counter = new Database(':memory:')
    counter.loadExtension(extension)
    const initial = new Error('controller creation failed before native close')
    observe(async (owner) => {
      await owner.createConversation({
        id: 'native',
        taskId: 't',
        tabId: 'tab',
        epoch: 1,
        mode: 'claude-chat'
      })
      await owner.maintenance.pauseCheckpointer()
      counter.prepare('SELECT fail_next_sync()').get()
      console.log('STARTUP_NATIVE native-failure-armed')
    })
    vi.spyOn(terminal, 'createChatOps').mockImplementation(() => {
      throw initial
    })
    try {
      const error = await rejection(open(stateDir))
      expect((error as AggregateError).cause).toBe(initial)
      expect(
        causes(error).some(
          (error) =>
            error instanceof Error &&
            (error as Error & { code?: string }).code === 'SQLITE_IOERR_FSYNC'
        )
      ).toBe(true)
      await retired(captured[0])
    } finally {
      counter.close()
    }
  }
)
