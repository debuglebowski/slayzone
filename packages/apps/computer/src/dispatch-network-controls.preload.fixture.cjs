// Isolated VFS proof. Main may open only its counter. Target only hub A's
// canonical writer thread; hub B's actual writes must still complete.
require('../../../domains/chat-runtime/src/server/computer-online-no-main-sqlite.fixture.cjs')
const threads = require('node:worker_threads')
if (!threads.isMainThread && threads.workerData?.hubScope === 'native-a') {
  const Database = require('better-sqlite3')
  const pragma = Database.prototype.pragma
  Database.prototype.pragma = function (sql, ...args) {
    if (/synchronous\s*=\s*FULL/i.test(sql)) {
      this.loadExtension(process.env.SLAYZONE_TEST_CONTROL_SYNC_EXTENSION)
      this.prepare('SELECT target_sync_thread(1)').get()
    }
    return Reflect.apply(pragma, this, [sql, ...args])
  }
}
