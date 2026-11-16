// Test-only observation around the actual native addon and packaged canonical owner.
// No new writer, production request or callback crosses the worker port.
const assert = require('node:assert/strict')
const { dirname, join } = require('node:path')
const { isMainThread, threadId } = require('node:worker_threads')
const Database = require('better-sqlite3')
const binding = require(join(dirname(require.resolve('better-sqlite3')), 'binding.js')).getBinding()

// Hook native prototypes before fixture startup. Cached statements/iterators and
// the driver's internal transaction statements reach these same native methods.
function observeNative(onCall) {
  const restore = []
  const constructor = Object.getOwnPropertyDescriptor(binding, 'Database')
  assert(constructor.writable)
  binding.Database = new Proxy(constructor.value, {
    construct(target, args, newTarget) {
      const call = onCall({ kind: 'Database.constructor', path: args[0] })
      const result = Reflect.construct(target, args, newTarget)
      if (call) call.completed = true
      return result
    }
  })
  restore.push(() => Object.defineProperty(binding, 'Database', constructor))
  for (const label of ['Database', 'Statement', 'StatementIterator', 'Backup']) {
    const proto = binding[label].prototype
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (key === 'constructor' || typeof descriptor.value !== 'function') continue
      assert(descriptor.writable)
      const original = descriptor.value
      Object.defineProperty(proto, key, {
        ...descriptor,
        value: function (...args) {
          const statement = label === 'Statement' ? this : this.statement
          const call = onCall({
            kind: `${label}.${key}`,
            sql: statement?.source ?? (['prepare', 'exec'].includes(key) ? args[0] : undefined),
            params: label === 'Statement' ? args : undefined,
            path: statement?.database?.name ?? (label === 'Database' ? this.name : undefined)
          })
          const result = Reflect.apply(original, this, args)
          if (call) call.completed = true
          return result
        }
      })
      restore.push(() => Object.defineProperty(proto, key, descriptor))
    }
  }
  return () => {
    for (const undo of restore.reverse()) undo()
  }
}

// The hub fixture legitimately opens SQLite on main outside the computer request
// window. Keep observing from startup, but count only the measured request.
exports.installMainNativeAudit = () => {
  assert.equal(isMainThread, true)
  let active = false
  let calls = []
  const restore = observeNative((event) => {
    if (!active) return
    // Keep fixture fault reports bounded even when a cached get binds a body.
    const call = { ...event }
    delete call.params
    calls.push(call)
    return call
  })
  return {
    begin() {
      calls = []
      active = true
    },
    end() {
      active = false
      return calls
    },
    restore
  }
}

if (!isMainThread) {
  const prepare = Database.prototype.prepare
  const parse = JSON.parse
  const installed = new WeakSet()
  let active = false
  let internal = false
  let reads = []
  let parsed = []
  let nativeCalls = []
  let payloadVisits = { rows: 0, bytes: 0 }
  observeNative((event) => {
    if (!active || internal || event.sql === 'SELECT audit_metadata_end() AS report') return
    nativeCalls.push(event)
    return event
  })
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
        nativeCalls = []
        payloadVisits = { rows: 0, bytes: 0 }
        active = true
        return 1
      })
      this.function('audit_metadata_end', () => {
        active = false
        return JSON.stringify({ threadId, reads, parsed, nativeCalls, payloadVisits })
      })
      this.function('audit_metadata_payload_seen', (text) => {
        payloadVisits.rows++
        payloadVisits.bytes += Buffer.byteLength(text)
        return 1
      })
    }
    const stmt = prepare.call(this, sql)
    if (!stmt.reader || !/\b(records|events|receipts|timeline_page_metadata)\b/i.test(sql))
      return stmt
    const db = this
    const record = (params, rows) => {
      // Only our own EXPLAIN is outside the measured native SQL. The production
      // statement has already executed; never replay it to invent an exec count.
      internal = true
      let plan
      try {
        plan = prepare
          .call(db, `EXPLAIN QUERY PLAN ${sql}`)
          .all(...params)
          .map((row) => row.detail)
      } finally {
        internal = false
      }
      reads.push({ sql, params, rows, path: db.name, plan })
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
}
