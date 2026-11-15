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
 * mode `build`: `VACUUM INTO out` with `auto_vacuum = INCREMENTAL` (the live file's
 *   header is not touched), then drops the copy's persistent triggers so replaying
 *   captured changes cannot fire them twice — their SQL goes back to the owner, which
 *   restores them verbatim in the swap window.
 * mode `resume`: opens an existing copy for more catch-up rounds.
 *
 * Messages in:  {t:'copy', tables, keys} — copy each key's CURRENT row from live
 *               (deleted there = deleted here); {t:'finish', check} — optional
 *               quick_check, make the copy durable (full fsync), close, exit.
 * Messages out: {t:'ready', triggers} | {t:'copied'} | {t:'finished', check} |
 *               {t:'error', message}.
 * A key is [table, k1..k4] (primary-key values, typed: BigInt for integers); a table
 * without a primary key is copied whole (key [table]).
 */
export const COMPACTION_WORKER_SOURCE = `
'use strict'
const { parentPort, workerData } = require('node:worker_threads')
const Database = require(workerData.modulePath)
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
try {
  live = new Database(workerData.live, { readonly: true, fileMustExist: true })
  let triggers = []
  if (workerData.mode === 'build') {
    live.pragma('auto_vacuum = INCREMENTAL')
    live.prepare('VACUUM INTO ?').run(workerData.out)
  }
  out = new Database(workerData.out, { fileMustExist: true })
  out.pragma('synchronous = OFF')
  out.pragma('secure_delete = ON')
  if (workerData.mode === 'build') {
    triggers = out.prepare("SELECT name, sql FROM main.sqlite_master WHERE type = 'trigger' ORDER BY rowid").all()
    out.transaction(() => {
      for (const t of triggers) out.exec('DROP TRIGGER main.' + ident(t.name))
    })()
  }
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
`
