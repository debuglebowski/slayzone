// Standalone instrumentation process; the production VFS is never modified.
require('tsx/cjs')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { isMainThread, workerData } = require('node:worker_threads')
const Database = require('better-sqlite3')
const { commitStorageFence } = require('./storage-fence.ts')

if (!isMainThread) {
  const { serveSqliteWorker } = require('@slayzone/platform/sqlite-worker-host')
  serveSqliteWorker({
    label: 'native chat owner fixture',
    open: () => {
      const db = new Database(workerData.path)
      db.pragma('journal_mode=WAL')
      db.pragma('synchronous=NORMAL')
      db.pragma('wal_autocheckpoint=0')
      db.exec(
        'CREATE TABLE maintenance_cursors(id TEXT PRIMARY KEY,value TEXT);CREATE TABLE events(value);INSERT INTO events VALUES(0)'
      )
      return db
    },
    txns: {
      cycle: (db, value) => {
        const [status] = db.pragma('wal_checkpoint(PASSIVE)')
        assert.equal(status.busy, 0)
        assert.equal(status.log, status.checkpointed)
        db.prepare('INSERT INTO events VALUES(?)').run(value)
      },
      fence: (db, params) => commitStorageFence(db, params)
    },
    close: (db) => {
      db.pragma('wal_checkpoint(TRUNCATE)')
      db.close()
    }
  })
} else {
  const { openSqliteWorker } = require('@slayzone/platform/sqlite-worker')
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
  const [root, extension] = process.argv.slice(2)
  const counter = new Database(':memory:')
  counter.loadExtension(extension)
  const count = () => counter.prepare('SELECT sync_count() main,total_sync_count() total').get()
  const control = (sql) => counter.prepare(sql).get()
  ;(async () => {
    const before = count()
    const db = await openSqliteWorker({
      label: 'native owner',
      workerPath: __filename,
      workerData: { path: join(root, 'chat.sqlite') }
    })
    try {
      for (let i = 1; i <= 30; i++) await db.namedTxn('cycle', i)
      const beforeNormal = count()
      await db.run('INSERT INTO events VALUES(?)', ['pending-tail'])
      const beforeFence = count()
      const normalCommitSyncs = beforeFence.total - beforeNormal.total
      await db.namedTxn('fence', { resumeNormal: true })
      const fenceSyncs = count().total - beforeFence.total
      assert(await db.get("SELECT 1 FROM events WHERE value='pending-tail'"))
      control('SELECT block_sync(1)')
      let ack = false
      const delayed = db.namedTxn('fence', { resumeNormal: true }).then(() => {
        ack = true
      })
      try {
        const deadline = Date.now() + 5000
        while (!control('SELECT sync_blocked() value').value) {
          assert(Date.now() < deadline)
          await tick()
        }
        await tick()
        assert.equal(ack, false)
      } finally {
        control('SELECT block_sync(0)')
      }
      await delayed
      control('SELECT fail_next_sync()')
      let failedCode
      await assert.rejects(db.namedTxn('fence', { resumeNormal: true }), (error) => {
        failedCode = error.code
        return error.code === 'SQLITE_IOERR_FSYNC'
      })
      assert.deepEqual(await db.get('PRAGMA synchronous'), { synchronous: 2 })
      const integrity = Object.values(await db.get('PRAGMA integrity_check'))[0]
      await db.close()
      const after = count()
      console.log(
        JSON.stringify({
          mainSyncs: after.main - before.main,
          workerSyncs: after.total - before.total,
          normalCommitSyncs,
          fenceSyncs,
          cycles: 30,
          failedCode,
          heartbeatDuringSync: true,
          earlyAck: false,
          integrity
        })
      )
    } finally {
      await db.close()
    }
    counter.close()
  })().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
