// Actual store/backend/checkpointer and packaged computer worker, isolated VFS process.
require('tsx/cjs')
const assert = require('node:assert/strict')
const Database = require('better-sqlite3')
const { mkdirSync, rmSync } = require('node:fs')
const { openChatStorageOwner } = require('./storage-owner.ts')
const { killCheckpointerThreadForTests } = require('./checkpointer.ts')
const [root, extension, workerPath] = process.argv.slice(2)
const counter = new Database(':memory:')
counter.loadExtension(extension)
const count = () => counter.prepare('SELECT sync_count() main,total_sync_count() total').get()
const control = (sql) => counter.prepare(sql).get()
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
const event = (text) => ({ kind: 'assistant-text', messageId: text, text })
;(async () => {
  const start = count()
  const owner = await openChatStorageOwner({
    stateDir: root,
    hubScope: 'native-owner',
    workerPath,
    checkpointIntervalMs: 60000,
    checkpointerRetryMs: 60000
  })
  try {
    const deadline = Date.now() + 5000
    while ((await owner.db.get('PRAGMA synchronous')).synchronous !== 1) {
      assert(Date.now() < deadline)
      await tick()
    }
    await owner.createConversation({
      id: 'c',
      taskId: 't',
      tabId: 'tab',
      mode: 'claude-chat',
      epoch: 1
    })
    for (let i = 0; i < 30; i++) {
      await owner.maintenance.checkpointNow()
      await owner.append('c', 1, event('cycle-' + i))
    }
    const beforeNormal = count()
    await owner.append('c', 1, event('pending-tail'))
    const afterNormal = count()
    assert.equal(afterNormal.total - beforeNormal.total, 0)
    await killCheckpointerThreadForTests()
    await owner.flush()
    const deathFenceSyncs = count().total - afterNormal.total
    assert(deathFenceSyncs > 0)
    assert.equal(typeof (await owner.maintenanceCursor('storage-durable-prefix-v1')), 'string')
    const beforeCoalesced = count()
    const group = Array.from({ length: 10 }, () => owner.flush())
    assert(group.every((promise) => promise === group[0]))
    await Promise.all(group)
    const coalescedSyncs = count().total - beforeCoalesced.total
    assert.equal(coalescedSyncs, 1)
    const earlier = owner.flush()
    const writing = owner.append('c', 1, event('racing-write'))
    const later = owner.flush()
    assert.notEqual(earlier, later)
    await Promise.all([earlier, writing, later])
    assert((await owner.read('c', -1)).some((row) => row.event.text === 'racing-write'))
    control('SELECT block_sync(1)')
    let acknowledged = false
    const delayed = owner.flush().then(() => {
      acknowledged = true
    })
    try {
      const until = Date.now() + 5000
      while (!control('SELECT sync_blocked() value').value) {
        assert(Date.now() < until)
        await tick()
      }
      await tick()
      assert.equal(acknowledged, false)
    } finally {
      control('SELECT block_sync(0)')
    }
    await delayed
    control('SELECT fail_next_sync()')
    let failedCode
    await assert.rejects(owner.flush(), (error) => {
      failedCode = error.code
      return failedCode === 'SQLITE_IOERR_FSYNC'
    })
    assert.deepEqual(await owner.db.get('PRAGMA synchronous'), { synchronous: 2 })
    const integrity = Object.values(await owner.db.get('PRAGMA integrity_check'))[0]
    assert.equal(integrity, 'ok')
    // Both recovery and successful swap run on the same canonical worker. An
    // EISDIR after native close is real filesystem failure, not a mocked owner.
    await owner.maintenance.pauseCheckpointer()
    const cachedSql = 'SELECT count(*) n FROM events'
    const cached = await owner.db.get(cachedSql)
    const epoch = await owner.maintenance.connectionEpoch()
    const beforeId = await owner.storeId()
    const copy = await owner.maintenance.tempPath()
    await owner.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    await owner.db.run('VACUUM INTO ?', [copy])
    mkdirSync(owner.path + '.pre-compact')
    await assert.rejects(owner.maintenance.swapIn(copy), (error) => {
      assert.equal(error.name, 'ChatStorageSwapError')
      assert.equal(error.usable, true)
      assert(error.cause.code)
      return true
    })
    rmSync(owner.path + '.pre-compact', { recursive: true })
    assert.equal(await owner.maintenance.connectionEpoch(), epoch + 1)
    assert.deepEqual(await owner.db.get(cachedSql), cached)
    const next = await owner.maintenance.tempPath()
    await owner.db.run('VACUUM INTO ?', [next])
    await owner.maintenance.swapIn(next)
    assert.equal(await owner.storeId(), beforeId)
    assert.deepEqual(await owner.db.get(cachedSql), cached)
    assert((await owner.db.get('SELECT chat_storage_owner_thread() n')).n > 0)
    await owner.maintenance.resumeCheckpointer()
    await owner.append('c', 1, event('after native swaps'))
    await owner.flush()
    // Process-only unclean restart, same short boot. Ready cannot precede sync.
    await owner.terminate()
    const rotationStart = count()
    control('SELECT block_sync(1)')
    let ready = false
    let reopened
    const opening = openChatStorageOwner({
      stateDir: root,
      hubScope: 'native-owner',
      workerPath,
      checkpointIntervalMs: 60000
    }).then((value) => {
      ready = true
      reopened = value
      return value
    })
    try {
      const until = Date.now() + 5000
      while (!control('SELECT sync_blocked() value').value) {
        assert(Date.now() < until)
        await tick()
      }
      assert.equal(ready, false)
    } finally {
      control('SELECT block_sync(0)')
    }
    reopened = await opening
    try {
      assert.notEqual(await reopened.storeId(), beforeId)
      assert((await reopened.read('c', -1)).some((row) => row.event.text === 'after native swaps'))
      assert(count().total > rotationStart.total)
    } finally {
      await reopened.close()
    }
    const archives = await require('./archive-privacy.native.fixture.cjs')(
      root,
      workerPath,
      counter
    )
    const end = count()
    assert.equal(end.main - start.main, 0)
    console.log(
      JSON.stringify({
        actualStore: true,
        packagedWorker: true,
        cycles: 30,
        mainSyncs: end.main - start.main,
        workerSyncAttempts: end.total - start.total,
        normalTailSyncs: afterNormal.total - beforeNormal.total,
        deathFenceSyncs,
        coalescedSyncs,
        racingPrefixes: true,
        pendingDuringSync: true,
        failedCode,
        integrity,
        recoveredSwap: true,
        successfulSwap: true,
        uncleanRotation: true,
        rotationWaitedForSync: true,
        archives
      })
    )
  } finally {
    await owner.close()
    counter.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
