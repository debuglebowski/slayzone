// Actual store/backend/checkpointer and packaged computer worker, isolated VFS process.
require('tsx/cjs')
const assert = require('node:assert/strict')
const Database = require('better-sqlite3')
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
    await owner.close()
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
        integrity
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
