// Isolated POSIX native VFS proof: actual async online owner + committed history pipeline.
require('tsx/cjs')
const assert = require('node:assert/strict')
const Database = require('better-sqlite3')
const { spawn } = require('node:child_process')
const { createProcHandlers } = require('../../../../apps/computer/src/handlers/proc.ts')
const { createPtyHandlers } = require('../../../../apps/computer/src/handlers/pty.ts')
const nativePty = require('node-pty')
const { openComputerChatRuntime } = require('./computer-online-runtime.ts')
const [root, extension, workerPath] = process.argv.slice(2)
const counter = new Database(':memory:')
counter.loadExtension(extension)
assert.throws(() => new Database(':memory:'), /Native SQLite constructor refused/)
const control = (sql) => counter.prepare(sql).get()
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
const until = async (test) => {
  const deadline = Date.now() + 8000
  while (!test()) {
    assert(Date.now() < deadline, 'native proof deadline')
    await tick()
  }
}
const bootstrap = {
  identity: { id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
  projectId: null,
  cwd: '/tmp',
  revision: 1,
  providerConfig: {},
  defaultFlags: null,
  env: {}
}
;(async () => {
  const metadata = [],
    events = []
  let runtime, otherRuntime, sourceLease, permit, procs, otherProcs, ptys
  let releasePreparation = () => undefined
  const start = control('SELECT sync_count() n').n
  try {
    runtime = await openComputerChatRuntime({
      stateDir: root,
      hubScope: 'online-native',
      computerId: 'pc',
      workerPath,
      blobBackfill: { automatic: false },
      markerBackfill: { automatic: false },
      compaction: { automaticReclaim: false },
      onMetadata: (value) => metadata.push(value),
      transport: { broadcastEvent: (...args) => events.push(args) }
    })
    await runtime.bootstrap(bootstrap)
    await runtime.ops.hydrate({ taskId: 't', tabId: 'tab', mode: 'claude-chat', cwd: '/tmp' })
    // A real FULL fence is executing on the canonical owner, not a fake promise.
    control('SELECT block_sync(1)')
    let published = false
    const writing = runtime.transport
      .switchTabConversation('tab', {
        conversationId: 'cli-session',
        branch: {
          kind: 'notice',
          id: 'branch',
          level: 'info',
          code: 'native-proof',
          text: 'branch'
        },
        history: [{ kind: 'assistant-text', messageId: 'history', text: 'committed history' }],
        notices: []
      })
      .then(() => {
        published = true
      })
    await until(() => !!control('SELECT sync_blocked() n').n)
    assert.equal(published, false)
    assert.equal(events.length, 0)
    control('SELECT block_sync(0)')
    await writing
    const rows = await runtime.storage.read('c', -1)
    assert(events.some((args) => args[1].text === 'committed history'))
    for (const args of events)
      assert(rows.some((row) => row.seq === args[2] && row.event.text === args[1].text))
    await runtime.transport.removeSession('tab')
    otherRuntime = await openComputerChatRuntime({
      stateDir: root,
      hubScope: 'online-other',
      computerId: 'pc',
      workerPath,
      blobBackfill: { automatic: false },
      markerBackfill: { automatic: false },
      compaction: { automaticReclaim: false }
    })
    await otherRuntime.bootstrap(bootstrap)
    const ctx = {
      config: {
        hubUrl: 'ws://native-proof/computers',
        name: 'native-proof',
        allowedRoots: [root],
        capabilities: ['proc', 'pty']
      },
      dialer: { notify: () => true },
      log: () => undefined
    }
    let hold = false,
      held = 0,
      processSpawns = 0,
      ptySpawns = 0
    const preparation = new Promise((resolve) => {
      releasePreparation = resolve
    })
    const admission = {
      acquire: async (taskId) => {
        const acquired = await runtime.taskAdmission.acquire(taskId)
        acquired.assert()
        if (hold) {
          held++
          await preparation
        }
        return acquired
      }
    }
    procs = createProcHandlers(ctx, undefined, {
      taskAdmission: admission,
      spawnProcess: (...args) => {
        processSpawns++
        return spawn(...args)
      }
    })
    otherProcs = createProcHandlers(ctx, undefined, { taskAdmission: otherRuntime.taskAdmission })
    ptys = createPtyHandlers(ctx, undefined, {
      taskAdmission: admission,
      spawnPty: (...args) => {
        ptySpawns++
        return nativePty.spawn(...args)
      }
    })
    const spec = {
      sessionId: 'already-live',
      spawnId: 'live',
      taskId: 't',
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: root,
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }
    const live = await procs.handlers['proc.spawn'](spec)
    const otherLive = await otherProcs.handlers['proc.spawn'](spec)
    await otherRuntime.storage.maintenance.pauseCheckpointer()
    sourceLease = await runtime.storage.maintenance.registerSecondary('retained-source')
    permit = await runtime.taskAdmission.acquire('t')
    permit.assert()
    hold = true
    const processBefore = processSpawns
    const starts = Promise.allSettled([
      procs.handlers['proc.spawn']({ ...spec, sessionId: 'held-process', spawnId: 'held' }),
      ptys.handlers['pty.spawn']({
        sessionId: 'held-pty',
        spawnId: 'held',
        taskId: 't',
        command: '/bin/sh',
        args: ['-c', 'printf started; exec cat'],
        cwd: root
      })
    ])
    await until(() => held === 2)
    const eventsBefore = events.length,
      metadataBefore = metadata.length
    control('SELECT fail_next_sync()')
    let failedCode
    await assert.rejects(
      runtime.ops.saveTabDraft('tab', { text: 'never publish', attachments: [] }),
      (error) => {
        failedCode = error.code
        return failedCode === 'SQLITE_IOERR_FSYNC'
      }
    )
    await tick()
    assert.equal(events.length, eventsBefore)
    assert.equal(metadata.length, metadataBefore)
    await assert.rejects(
      runtime.authority.scope({ kind: 'task', taskId: 't' }),
      /disk I\/O|fsync|IOERR/i
    )
    await assert.rejects(
      runtime.local.data.saveTabDraft('tab', { text: 'after failed fence', attachments: [] }),
      /disk I\/O|fsync|IOERR/i
    )
    let authorityChecks = 0
    const taskActive = runtime.control.taskActive
    runtime.control.taskActive = (...args) => {
      authorityChecks++
      return taskActive(...args)
    }
    await assert.rejects(runtime.taskAdmission.acquire('t'))
    assert.equal(
      authorityChecks,
      0,
      'controller failure must already be latched before testing old permits'
    )
    runtime.control.taskActive = taskActive
    const secondaryRetained = (await runtime.storage.maintenance.secondaryConnections()).includes(
      'retained-source'
    )
    process.kill(live.pid, 0)
    process.kill(otherLive.pid, 0)
    const healthyPermit = await otherRuntime.taskAdmission.acquire('t')
    healthyPermit.assert()
    healthyPermit.release()
    await otherRuntime.authority.scope({ kind: 'task', taskId: 't' })
    let oldPermitRevoked = false
    try {
      permit.assert()
    } catch {
      oldPermitRevoked = true
    }
    releasePreparation()
    const [heldProcess, heldPty] = await starts
    if (processSpawns !== processBefore || ptySpawns !== 0)
      console.error(
        JSON.stringify({
          phase: 'after-logical-failure',
          failedCode,
          authorityChecks,
          oldPermitRevoked,
          heldProcess: heldProcess.status,
          heldPty: heldPty.status,
          processBefore,
          processSpawns,
          ptySpawns,
          secondaryRetained
        })
      )
    assert.equal(processSpawns, processBefore, 'failed store must revoke held native process start')
    assert.equal(ptySpawns, 0, 'failed store must revoke held native PTY start')
    assert.equal(heldProcess.status, 'rejected')
    assert.equal(heldPty.status, 'rejected')
    assert.equal(oldPermitRevoked, true)
    assert.equal(
      secondaryRetained,
      true,
      'logical failure must not release a physical source lease'
    )
    assert.deepEqual(
      await procs.handlers['proc.kill']({ sessionId: 'already-live', spawnId: 'live' }),
      { ok: true, clean: true }
    )
    assert(otherProcs.ownedPids().includes(otherLive.pid), 'another hub keeps its live process')
    permit.release()
    permit = undefined
    await sourceLease.release()
    sourceLease = undefined
    await otherRuntime.storage.maintenance.resumeCheckpointer()
    await runtime.close()
    assert.equal(control('SELECT sync_count() n').n - start, 0)
    console.log(
      JSON.stringify({
        mainConstructorsRefused: true,
        actualOnlineRuntime: true,
        packagedWorker: true,
        committedPublication: true,
        blockedNativeSync: true,
        failedCode,
        failedPublicationSuppressed: true,
        oldPermitRevoked,
        heldProcessRejected: heldProcess.status === 'rejected',
        heldPtyRejected: heldPty.status === 'rejected',
        alreadyLivePreserved: true,
        otherHubHealthy: true,
        secondaryRetained,
        mainSyncs: 0
      })
    )
  } finally {
    control('SELECT block_sync(0)')
    releasePreparation()
    permit?.release()
    await sourceLease?.release()
    if (procs)
      for (const id of ['held-process', 'already-live'])
        await procs.handlers['proc.kill']({ sessionId: id })
    if (ptys) await ptys.handlers['pty.kill']({ sessionId: 'held-pty' })
    if (otherProcs) await otherProcs.handlers['proc.kill']({ sessionId: 'already-live' })
    procs?.disposeAll()
    ptys?.disposeAll()
    otherProcs?.disposeAll()
    await otherRuntime?.close()
    await runtime?.close()
    counter.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
