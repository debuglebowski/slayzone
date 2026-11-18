import * as terminalRuntime from '@slayzone/terminal/runtime'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, test, vi } from 'vitest'
import { openComputerChatRuntime } from './computer-online-runtime'
// Fails the test on a lifecycle model / runtime disagreement.
import '../../../terminal/src/server/runtime/chat-lifecycle-strict-testkit'

const workerPath = fileURLToPath(new URL('../../../../apps/computer/dist/bin.cjs', import.meta.url))
const bootstrap = {
  identity: { id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
  projectId: null,
  cwd: '/tmp',
  revision: 1,
  providerConfig: {},
  defaultFlags: null,
  env: {}
}

test.each(['close', 'task fence'])(
  'transient control ACK rechecks live authority after %s',
  async (scenario) => {
    const stateDir = mkdtempSync(join(tmpdir(), 'online-control-epoch-'))
    const runtime = await openComputerChatRuntime({
      stateDir,
      hubScope: 'h',
      computerId: 'pc',
      workerPath
    })
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    let block: ReturnType<typeof runtime.taskAdmission.block> | undefined
    try {
      await runtime.bootstrap(bootstrap)
      // Controller boundary fixture; actual provider/network/native ACKs have
      // separate subprocess proofs. This isolates authority changing mid-ACK.
      vi.spyOn(runtime.transport, 'controlSession').mockImplementation(async (_tab, spawnId) => {
        await held
        return { acknowledged: true, spawnId, scope: 'provider' }
      })
      const controlling = runtime.processControl({
        kind: 'control',
        identity: bootstrap.identity,
        spawnId: 'generation',
        action: 'interrupt'
      })
      void controlling.catch(() => undefined)
      if (scenario === 'close') await runtime.close()
      else block = runtime.taskAdmission.block('t')
      release()
      await expect(controlling).rejects.toThrow(/authority changed/)
    } finally {
      release()
      block?.release()
      await runtime.close()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }
)

test('online factory owns composed bootstrap/drafts/timeline/metadata on its worker; main retains its controller', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'online-chat-owner-'))
  const nativeMethods = ['prepare', 'exec', 'pragma', 'close', 'backup'] as const
  const spies = nativeMethods.map((method) => vi.spyOn(Database.prototype, method))
  let runtime: Awaited<ReturnType<typeof openComputerChatRuntime>> | undefined
  try {
    runtime = await openComputerChatRuntime({
      stateDir,
      hubScope: 'hub',
      computerId: 'pc',
      workerPath
    })
    await runtime.bootstrap(bootstrap)
    await runtime.ops.hydrate({ taskId: 't', tabId: 'tab', mode: 'claude-chat', cwd: '/tmp' })
    expect(
      await runtime.invoke({
        route: { id: 'c', epoch: 1 },
        target: 'ops',
        method: 'saveTabDraft',
        operationId: 'draft',
        args: ['tab', { text: 'on worker', attachments: [] }]
      })
    ).toEqual({ rev: 1 })
    expect(await runtime.ops.getTabState('tab')).toMatchObject({ draft: { text: 'on worker' } })
    expect(await runtime.local.metadataSnapshot('c')).toMatchObject({
      identity: bootstrap.identity
    })
    const records = runtime.local.data.timelineRecords!('tab')
    expect(await records.pageIds()).toEqual([])
    expect(await runtime.queueOps.list('tab')).toEqual([])
    await runtime.close()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  } finally {
    for (const spy of spies) spy.mockRestore()
    await runtime?.close()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === 'win32')(
  'native online owner fences history publication and fails closed after real xSync failure',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'online-owner-native-'))
    try {
      const extension = join(
        dir,
        process.platform === 'darwin' ? 'syncprobe.dylib' : 'syncprobe.so'
      )
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
      const output = execFileSync(
        process.execPath,
        [
          '--require',
          fileURLToPath(new URL('./computer-online-no-main-sqlite.fixture.cjs', import.meta.url)),
          fileURLToPath(new URL('./computer-online-runtime.native.fixture.cjs', import.meta.url)),
          dir,
          extension,
          workerPath
        ],
        { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 25000 }
      )
      process.stdout.write('POSIX online native proof ' + output.trim() + '\n')
      expect(JSON.parse(output)).toMatchObject({
        actualOnlineRuntime: true,
        packagedWorker: true,
        committedPublication: true,
        blockedNativeSync: true,
        failedCode: 'SQLITE_IOERR_FSYNC',
        failedPublicationSuppressed: true,
        mainConstructorsRefused: true,
        mainSyncs: 0,
        oldPermitRevoked: true,
        heldProcessRejected: true,
        heldPtyRejected: true,
        alreadyLivePreserved: true,
        otherHubHealthy: true,
        secondaryRetained: true
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

test('a stale lifecycle delivery leaves the active online controller intact', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'online-lifecycle-'))
  const runtime = await openComputerChatRuntime({
    stateDir,
    hubScope: 'h',
    computerId: 'pc',
    workerPath
  })
  try {
    await runtime.bootstrap(bootstrap)
    await runtime.applyTaskLifecycle('t', 'active', 2)
    await runtime.ops.hydrate({ taskId: 't', tabId: 'tab', mode: 'claude-chat', cwd: '/tmp' })
    const remove = vi.spyOn(runtime.transport, 'removeSession')
    expect(await runtime.applyTaskLifecycle('t', 'paused', 1)).toEqual({
      state: 'active',
      revision: 2
    })
    expect(remove).not.toHaveBeenCalled()
    expect(runtime.transport.getSessionInfo('tab')).not.toBeNull()
  } finally {
    await runtime.close()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('online retention drains and restores a hydrated projection through its private owner lease', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'online-retention-'))
  const runtime = await openComputerChatRuntime({
    stateDir,
    hubScope: 'h',
    computerId: 'pc',
    workerPath,
    blobBackfill: { automatic: false },
    markerBackfill: { automatic: false },
    compaction: { automaticReclaim: false }
  })
  try {
    await runtime.bootstrap(bootstrap)
    await runtime.storage.appendAt(
      'c',
      1,
      0,
      { kind: 'assistant-text', messageId: 'old', text: 'expired' },
      1
    )
    await runtime.ops.hydrate({ taskId: 't', tabId: 'tab', mode: 'claude-chat', cwd: '/tmp' })
    await runtime.ops.saveTabDraft('tab', { text: 'keep draft', attachments: [] })
    await runtime.retention.configure(1)
    expect(await runtime.retention.runNow(Date.now())).toMatchObject({ events: 1 })
    expect(await runtime.ops.getTabState('tab')).toMatchObject({ draft: { text: 'keep draft' } })
    expect(runtime.transport.getSessionInfo('tab')).not.toBeNull()
    expect(await runtime.storage.read('c', -1)).toEqual([])
    expect(await runtime.storage.maintenance.secondaryConnections()).toEqual([])
  } finally {
    await runtime.close()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('task erasure drains an accepted online caller before purging its native ownership', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'online-caller-lifetime-'))
  const runtime = await openComputerChatRuntime({
    stateDir,
    hubScope: 'h',
    computerId: 'pc',
    workerPath
  })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  try {
    await runtime.bootstrap(bootstrap)
    const reading = runtime.retention.access('c', async () => {
      entered()
      await gate
      return runtime.local.owner('tab')
    })
    await started
    let acknowledged = false
    const deleting = runtime.applyTaskLifecycle('t', 'deleted', 1).then((value) => {
      acknowledged = true
      return value
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(acknowledged).toBe(false)
    release()
    expect(await reading).toEqual(bootstrap.identity)
    expect(await deleting).toEqual({ state: 'deleted', revision: 1 })
  } finally {
    release()
    await runtime.close()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('fatal diagnostic rejection revokes the online controller permit and preserves its first failure', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'online-diagnostic-admission-'))
  const create = terminalRuntime.createChatTransport
  let diagnostic: NonNullable<Parameters<typeof create>[0]>['diagnostic']
  const factory = vi
    .spyOn(terminalRuntime, 'createChatTransport')
    .mockImplementation((opts, ...args) => {
      diagnostic = opts?.diagnostic
      return create(opts, ...args)
    })
  let runtime: Awaited<ReturnType<typeof openComputerChatRuntime>> | undefined
  let permit:
    | Awaited<ReturnType<NonNullable<typeof runtime>['taskAdmission']['acquire']>>
    | undefined
  try {
    runtime = await openComputerChatRuntime({
      stateDir,
      hubScope: 'h',
      computerId: 'pc',
      workerPath
    })
    await runtime.bootstrap(bootstrap)
    permit = await runtime.taskAdmission.acquire('t')
    const first = new Error('first diagnostic failure'),
      second = new Error('later diagnostic failure')
    let releaseControl!: () => void
    const controlGate = new Promise<void>((resolve) => {
      releaseControl = resolve
    })
    vi.spyOn(runtime.transport, 'controlSession').mockImplementation(async (_tab, spawnId) => {
      await controlGate
      return { acknowledged: true, spawnId, scope: 'provider' }
    })
    const controlling = runtime.processControl({
      kind: 'control',
      identity: bootstrap.identity,
      spawnId: 'generation',
      action: 'interrupt'
    })
    void controlling.catch(() => undefined)
    const write = vi
      .spyOn(runtime.control, 'diagnostic')
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(second)
    const event = {
      level: 'error' as const,
      source: 'main' as const,
      event: 'test.admission',
      message: 'diagnostic failure'
    }
    diagnostic!('tab', event)
    await vi.waitFor(async () => {
      await expect(runtime!.retention.access('c', async () => undefined)).rejects.toBe(first)
    })
    expect(() => permit!.assert()).toThrow(/admission/)
    releaseControl()
    await expect(controlling).rejects.toBe(first)
    diagnostic!('tab', event)
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setImmediate(resolve))
    await expect(runtime.retention.access('c', async () => undefined)).rejects.toBe(first)
    expect(() => permit!.assert()).toThrow(/admission/)
    await expect(runtime.taskAdmission.acquire('t')).rejects.toThrow(/admission|diagnostic/)
  } finally {
    permit?.release()
    await runtime?.close()
    factory.mockRestore()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a lifecycle transition revokes a preparation admitted while its fresh lifecycle read was pending', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'online-control-lifecycle-'))
  const runtime = await openComputerChatRuntime({
    stateDir,
    hubScope: 'h',
    computerId: 'pc',
    workerPath
  })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((r) => {
      release = r
    }),
    reading = new Promise<void>((r) => {
      entered = r
    })
  const close = vi.fn()
  try {
    await runtime.bootstrap(bootstrap)
    const taskLifecycle = runtime.storage.taskLifecycle
    vi.spyOn(runtime.storage, 'taskLifecycle').mockImplementation(async (task) => {
      entered()
      await gate
      return taskLifecycle(task)
    })
    vi.spyOn(runtime.transport, 'prepareDurableControl').mockReturnValue({
      spawnId: 'held-generation',
      onPhysicalExit: () => () => {
        /* Fixture has no process. */
      },
      ownsPhysicalStop: () => false,
      acknowledged: Promise.resolve(),
      close,
      run: async (work) => work()
    })
    const pausing = runtime.applyTaskLifecycle('t', 'paused', 1)
    await reading
    await runtime.prepareControl({
      kind: 'control.prepare',
      identity: bootstrap.identity,
      value: {
        route: { id: 'c', epoch: 1 },
        target: 'ops',
        method: 'interrupt',
        operationId: 'during-lifecycle-read',
        args: [{ taskId: 't', tabId: 'tab', mode: 'claude-chat', cwd: '/tmp' }]
      }
    })
    expect(close).not.toHaveBeenCalled()
    release()
    await pausing
    expect(close).toHaveBeenCalled()
  } finally {
    release()
    await runtime.close()
    rmSync(stateDir, { recursive: true, force: true })
  }
})
