// Test-only observation around the actual packaged canonical owner. No new writer,
// runtime implementation, production request or callback crosses the worker port.
const assert = require('node:assert/strict')
const { isMainThread, threadId } = require('node:worker_threads')
const Database = require('better-sqlite3')
assert.equal(isMainThread, false)
const prepare = Database.prototype.prepare
const parse = JSON.parse
const installed = new WeakSet()
let active = false
let reads = []
let parsed = []
JSON.parse = function (text, reviver) {
  if (active) parsed.push(typeof text === 'string' ? text.length : 0)
  return parse(text, reviver)
}
Database.prototype.prepare = function (sql) {
  if (!installed.has(this)) {
    installed.add(this)
    this.function('audit_metadata_begin', () => {
      reads = []
      parsed = []
      active = true
      return 1
    })
    this.function('audit_metadata_end', () => {
      active = false
      return JSON.stringify({ threadId, reads, parsed })
    })
  }
  const stmt = prepare.call(this, sql)
  if (!stmt.reader || !/\b(records|events|receipts|timeline_page_metadata)\b/i.test(sql))
    return stmt
  const db = this
  const record = (params, rows) => {
    reads.push({
      sql,
      params,
      rows,
      path: db.name,
      plan: prepare
        .call(db, `EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((row) => row.detail)
    })
  }
  for (const method of ['all', 'get']) {
    const original = stmt[method]
    stmt[method] = function (...params) {
      const result = original.apply(this, params)
      if (active) record(params, method === 'all' ? result.length : Number(result !== undefined))
      return result
    }
  }
  const iterate = stmt.iterate
  stmt.iterate = function* (...params) {
    let rows = 0
    try {
      for (const row of iterate.apply(this, params)) {
        rows++
        yield row
      }
    } finally {
      if (active) record(params, rows)
    }
  }
  return stmt
}
require('../../computer/dist/bin.cjs')
