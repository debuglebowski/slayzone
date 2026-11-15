/**
 * The storage-compaction worker (`storage-compaction.ts`), as source for an
 * `eval: true` worker thread: the computer ships as one bundled file, so a worker
 * entry file would be an extra asset to find at runtime (same approach as
 * `platform/event-loop-stall.ts`). Plain JavaScript on purpose: no bundler or test
 * transform touches it, so what the tests run is what ships.
 *
 * It holds two connections and never writes the live store:
 *   - `live`: the live `chat.sqlite`, READ-ONLY (SQLite enforces it);
 *   - `out`:  the compacted copy, read-write.
 *
 * mode `build`: creates the copy (live page size, `auto_vacuum = INCREMENTAL`) with the
 *   live schema's tables and indexes — NOT its triggers: replaying captured changes must
 *   not fire them twice; their SQL goes back to the owner, which restores them verbatim
 *   in the swap window. Then copies every table in key order, in batches of a byte
 *   budget, with an fsync and a pause every `syncBytes`: the disk never holds more than
 *   that much of our unwritten data, so the live store's own fsyncs never queue behind
 *   gigabytes (one `VACUUM INTO` is a single unthrottled burst: a live commit waited
 *   4.7 s behind it). Rows read in different batches are not one snapshot — the owner's
 *   captured keys cover every row changed since capture began.
 * mode `resume`: opens an existing copy for more catch-up rounds.
 *
 * Messages in:  {t:'copy', tables, keys} — copy each key's CURRENT row from live
 *               (deleted there = deleted here); {t:'finish', check} — optional
 *               quick_check, make the copy durable (full fsync), close, exit.
 * Messages out: {t:'progress', bytes} (build, after each fsync) | {t:'ready', triggers}
 *               | {t:'copied'} | {t:'finished', check} | {t:'error', message}.
 * A key is [table, k1..k4] (primary-key values, typed: BigInt for integers); a table
 * without a primary key is copied whole (key [table]).
 */
export const COMPACTION_WORKER_SOURCE = `
'use strict'
const { parentPort, workerData } = require('node:worker_threads')
const Database = require(workerData.modulePath)
const fs = require('node:fs')
const ident = (name) => '"' + String(name).replace(/"/g, '""') + '"'
let live = null
let out = null
const statements = new Map()
function closeAll() {
  for (const db of [out, live]) {
    try { if (db && db.open) db.close() } catch {}
  }
  out = live = null
}
function fail(error) {
  closeAll()
  parentPort.postMessage({ t: 'error', message: String((error && error.message) || error) })
  parentPort.close()
}
function prepared(table) {
  let s = statements.get(table.name)
  if (s) return s
  const cols = table.cols.map(ident).join(',')
  const name = 'main.' + ident(table.name)
  const insert = out.prepare('INSERT OR REPLACE INTO ' + name + '(' + cols + ') VALUES(' + table.cols.map(() => '?').join(',') + ')')
  if (table.pk.length) {
    const where = table.pk.map((c) => ident(c) + ' IS ?').join(' AND ')
    s = {
      select: live.prepare('SELECT ' + cols + ' FROM ' + name + ' WHERE ' + where).raw(true).safeIntegers(true),
      remove: out.prepare('DELETE FROM ' + name + ' WHERE ' + where),
      insert
    }
  } else {
    s = {
      all: live.prepare('SELECT ' + cols + ' FROM ' + name).raw(true).safeIntegers(true),
      clear: out.prepare('DELETE FROM ' + name),
      insert
    }
  }
  statements.set(table.name, s)
  return s
}
function copy(tables, keys) {
  const byName = new Map(tables.map((t) => [t.name, t]))
  out.transaction(() => {
    for (const key of keys) {
      const table = byName.get(key[0])
      if (!table) throw new Error('Unknown table in compaction delta')
      const s = prepared(table)
      if (!table.pk.length) {
        s.clear.run()
        for (const row of s.all.all()) s.insert.run(...row)
        continue
      }
      const values = key.slice(1, 1 + table.pk.length)
      const row = s.select.get(...values)
      s.remove.run(...values)
      if (row) s.insert.run(...row)
    }
  })()
}
/** Rough bytes of one row (text length, blob length, 8 per number): the batch budget. */
function rowBytes(row) {
  let n = 0
  for (const v of row) n += typeof v === 'string' ? v.length : v && v.length !== undefined ? v.length : 8
  return n
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function build() {
  const { batchBytes, syncBytes, pauseMs } = workerData.throttle
  out = new Database(workerData.out)
  out.pragma('page_size = ' + Number(live.pragma('page_size', { simple: true })))
  out.pragma('auto_vacuum = INCREMENTAL')
  out.pragma('journal_mode = OFF')
  out.pragma('synchronous = OFF')
  const schema = live
    .prepare('SELECT type, name, sql FROM main.sqlite_master WHERE sql IS NOT NULL ORDER BY rowid')
    .all()
  out.transaction(() => {
    for (const o of schema) if (o.type === 'table' && !o.name.startsWith('sqlite_')) out.exec(o.sql)
    for (const o of schema) if (o.type === 'index' || o.type === 'view') out.exec(o.sql)
  })()
  out.pragma('user_version = ' + Number(live.pragma('user_version', { simple: true })))
  const fd = fs.openSync(workerData.out, 'r+')
  let copied = 0
  let unsynced = 0
  const synced = async () => {
    fs.fsyncSync(fd)
    unsynced = 0
    parentPort.postMessage({ t: 'progress', bytes: copied })
    await pause(pauseMs)
  }
  try {
    for (const table of workerData.tables) {
      const cols = table.cols.map(ident).join(',')
      const name = 'main.' + ident(table.name)
      const insert = out.prepare('INSERT INTO ' + name + '(' + cols + ') VALUES(' + table.cols.map(() => '?').join(',') + ')')
      if (!table.pk.length) {
        out.transaction(() => {
          for (const row of live.prepare('SELECT ' + cols + ' FROM ' + name).raw(true).safeIntegers(true).all()) insert.run(...row)
        })()
        continue
      }
      // Keyset pagination: rowid tables by rowid, WITHOUT ROWID tables by primary key.
      const keys = table.withoutRowid ? table.pk.map(ident) : ['rowid']
      const keyList = keys.join(',')
      const first = live.prepare('SELECT ' + keyList + ',' + cols + ' FROM ' + name + ' ORDER BY ' + keyList + ' LIMIT 16').raw(true).safeIntegers(true)
      const next = live
        .prepare('SELECT ' + keyList + ',' + cols + ' FROM ' + name + ' WHERE (' + keyList + ') > (' + keys.map(() => '?').join(',') + ') ORDER BY ' + keyList + ' LIMIT 16')
        .raw(true)
        .safeIntegers(true)
      let after = null
      for (;;) {
        let batch = 0
        let done = false
        out.transaction(() => {
          while (batch < batchBytes) {
            const rows = after === null ? first.all() : next.all(...after)
            if (!rows.length) {
              done = true
              return
            }
            for (const row of rows) {
              const values = row.slice(keys.length)
              insert.run(...values)
              batch += rowBytes(values)
            }
            after = rows[rows.length - 1].slice(0, keys.length)
          }
        })()
        copied += batch
        unsynced += batch
        if (unsynced >= syncBytes) await synced()
        if (done) break
      }
    }
    await synced()
  } finally {
    fs.closeSync(fd)
  }
}
async function main() {
try {
  live = new Database(workerData.live, { readonly: true, fileMustExist: true })
  let triggers = []
  if (workerData.mode === 'build') {
    await build()
    triggers = live.prepare("SELECT name, sql FROM main.sqlite_master WHERE type = 'trigger' ORDER BY rowid").all()
  } else {
    out = new Database(workerData.out, { fileMustExist: true })
    out.pragma('synchronous = OFF')
  }
  out.pragma('secure_delete = ON')
  parentPort.postMessage({ t: 'ready', triggers })
  parentPort.on('message', (m) => {
    try {
      if (m.t === 'copy') {
        copy(m.tables, m.keys)
        parentPort.postMessage({ t: 'copied' })
      } else if (m.t === 'finish') {
        const check = m.check ? out.pragma('quick_check', { simple: true }) : 'ok'
        // Durable now, off the main thread: the rounds ran with synchronous OFF, and
        // the swap window's commit must flush only its own small delta. Rewriting the
        // header's user_version (same value) is a write whose commit syncs the file.
        // Plain fsync, like the live store: F_FULLFSYNC flushes the whole drive cache
        // and stalled the main thread's own commits for seconds (measured 4.7 s).
        out.pragma('synchronous = FULL')
        // Already WAL, like the live store: reopening it in the window converts nothing.
        out.pragma('journal_mode = WAL')
        out.pragma('user_version = ' + Number(out.pragma('user_version', { simple: true })))
        closeAll()
        parentPort.postMessage({ t: 'finished', check })
        parentPort.close()
      }
    } catch (error) {
      fail(error)
    }
  })
} catch (error) {
  fail(error)
}
}
main()
`
