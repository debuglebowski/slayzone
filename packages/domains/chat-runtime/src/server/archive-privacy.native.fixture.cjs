// Invoked by the existing isolated VFS/packaged-owner fixture. No main SQL beyond
// the instrumentation connection; all real store/archive operations use the owner.
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { readdirSync, readFileSync } = require('node:fs')
const { openComputerChatRuntime } = require('./computer-online-runtime.ts')
module.exports = async function archiveProof(root, workerPath, counter) {
  const sql = (text) => Object.values(counter.prepare(text).get())[0]
  const wait = async (test) => {
    const until = Date.now() + 5000
    while (!test()) {
      assert(Date.now() < until, 'native copy phase deadline')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  const opts = {
    stateDir: root,
    hubScope: 'native-archives',
    computerId: 'pc',
    workerPath,
    blobBackfill: { automatic: false },
    markerBackfill: { automatic: false }
  }
  const r = await openComputerChatRuntime(opts)
  let next
  const other = await openComputerChatRuntime({ ...opts, hubScope: 'other-hub' })
  try {
    for (const taskId of ['alice', 'bob', 'carol']) {
      await r.storage.createConversation({
        id: taskId,
        taskId,
        tabId: taskId,
        mode: 'claude-chat',
        epoch: 1
      })
      await r.storage.append(taskId, 1, {
        kind: 'assistant-text',
        messageId: taskId,
        text: `${taskId} native secret`
      })
    }
    const backup = await r.backups.create()
    const archive = await r.backups.restore(backup.id)
    await r.blobBackfill.runNow()
    assert.equal(await r.blobBackfill.done(), true)
    // Cancel returns promptly; idle remains pending until real native helper exit.
    sql('SELECT block_copy_sync(1)')
    await r.compaction.start()
    await wait(() => sql('SELECT copy_sync_blocked()') > 0)
    await r.compaction.cancel()
    let idleDone = false
    const idle = r.compaction.idle().then(() => {
      idleDone = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(idleDone, false)
    assert(sql('SELECT copy_files()') > 0)
    sql('SELECT block_copy_sync(0)')
    await idle
    assert.equal((await r.compaction.status()).job.phase, 'cancelled')
    assert.equal(sql('SELECT copy_files()'), 0)
    sql('SELECT block_copy_sync(1)')
    const first = r.backups.eraseTask('alice').then(
      () => null,
      (error) => error
    )
    await wait(() => sql('SELECT copy_sync_blocked()') > 0)
    assert(sql('SELECT copy_files()') > 0)
    let acknowledged = false
    const second = r.backups.eraseTask('bob').then(
      () => {
        acknowledged = true
      },
      (error) => error
    )
    const reading = r.backups.read(archive.id, 'carol').catch((error) => error)
    let closeDone = false
    const archiveClose = r.backups.close().then(
      () => {
        closeDone = true
      },
      (error) => error
    )
    // The native checker/sync is blocked in a broker-owned helper. Canonical
    // writer and unrelated hub still execute real storage/control work.
    await r.storage.append('carol', 1, {
      kind: 'assistant-text',
      messageId: 'live',
      text: 'live during archive sync'
    })
    const liveFence = r.storage.flush().catch((error) => error)
    await other.storage.createConversation({
      id: 'other',
      taskId: 'other',
      tabId: 'other',
      mode: 'claude-chat',
      epoch: 1
    })
    await other.storage.append('other', 1, {
      kind: 'assistant-text',
      messageId: 'other',
      text: 'other hub stays usable'
    })
    await other.storage.flush()
    assert.equal(acknowledged, false)
    assert.equal(closeDone, false)
    let terminated = false
    const death = r.storage.terminate().then(() => {
      terminated = true
    })
    await r.storage.exited
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(terminated, false)
    assert(sql('SELECT copy_files()') > 0)
    await assert.rejects(openComputerChatRuntime(opts), /already.*owner/)
    sql('SELECT block_copy_sync(0)')
    await death
    assert((await first) instanceof Error)
    assert((await second) instanceof Error)
    assert((await reading) instanceof Error)
    assert((await liveFence) instanceof Error)
    assert((await archiveClose) instanceof Error)
    assert.equal(closeDone, false)
    assert.equal(acknowledged, false)
    assert.equal(sql('SELECT copy_files()'), 0)
    next = await openComputerChatRuntime(opts)
    await Promise.all([next.backups.eraseTask('alice'), next.backups.eraseTask('bob')])
    assert.deepEqual((await next.backups.read(archive.id, 'alice')).events, [])
    assert.deepEqual((await next.backups.read(archive.id, 'bob')).events, [])
    assert.equal((await next.backups.read(archive.id, 'carol')).events.length, 1)
    const archiveDir = join(next.backups.archiveDir, archive.id)
    for (const name of readdirSync(archiveDir)) {
      if (name === 'blobs') continue
      assert(
        !/alice native secret|bob native secret/.test(
          readFileSync(join(archiveDir, name)).toString()
        )
      )
    }
    assert(
      readFileSync(join(next.backups.dir, backup.id, 'chat.sqlite')).includes(
        Buffer.from('bob native secret')
      )
    )
    return {
      cancelledCopyWaitedForNativeExit: true,
      archiveCloseWaitedForNativeExit: true,
      blockedNativeArchive: true,
      canonicalWriterUsable: true,
      otherHubUsable: true,
      noErasureAckAfterDeath: true,
      replacementWaitedForPhysicalCopyExit: true,
      nativeCopyFilesAfterExit: 0,
      concurrentRetryPreservedOtherTask: true,
      retainedBackup: true
    }
  } finally {
    sql('SELECT block_copy_sync(0)')
    await next?.close()
    await r.close().catch(() => undefined)
    await other.close()
  }
}
