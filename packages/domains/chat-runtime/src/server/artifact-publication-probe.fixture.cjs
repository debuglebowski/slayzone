// Test-only preload. Actual packaged worker/SQLite/files; no replacement store implementation.
const threads = require('node:worker_threads')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { syncBuiltinESMExports } = require('node:module')
const { basename } = require('node:path')
const body = (path) =>
  typeof path === 'string' &&
  !path.endsWith('.json') &&
  /[/\\]computer-runtime[/\\][a-f0-9]{64}[/\\](?:uploads|artifacts|blobs)[/\\]/.test(path)
if (threads.isMainThread) {
  const shared = new SharedArrayBuffer(64)
  const cacheShared = process.argv.at(-1)?.startsWith('cache-')
    ? new SharedArrayBuffer(48)
    : undefined
  if (cacheShared) global.__fu2PublicationCacheProbe = new Int32Array(cacheShared)
  global.__fu2PublicationProbe = new Int32Array(shared)
  const rejectBody = (path) => {
    if (global.__fu2PublicationProbe[8] && body(path)) {
      Atomics.add(global.__fu2PublicationProbe, 11, 1)
      throw new Error('Publication body I/O on main')
    }
  }
  for (const key of [
    'readFileSync',
    'readFile',
    'writeFileSync',
    'writeFile',
    'openSync',
    'open'
  ]) {
    const original = fs[key]
    fs[key] = function (path, ...args) {
      rejectBody(path)
      return Reflect.apply(original, this, [path, ...args])
    }
  }
  for (const key of ['readFile', 'writeFile', 'open']) {
    const original = fsp[key]
    fsp[key] = async (path, ...args) => {
      rejectBody(path)
      return original(path, ...args)
    }
  }
  const Worker = threads.Worker
  threads.Worker = class extends Worker {
    constructor(path, options) {
      if (options?.workerData?.kind === 'slayzone-chat-storage-owner-v1')
        options = {
          ...options,
          workerData: {
            ...options.workerData,
            __fu2PublicationProbe: shared,
            __fu2PublicationCacheProbe: cacheShared,
            __fu2PublicationCacheNegative: process.argv.at(-1) === 'cache-negative',
            __fu2PublicationExtension: global.__fu2PublicationExtension
          }
        }
      super(path, options)
    }
  }
  syncBuiltinESMExports()
} else if (threads.workerData?.__fu2PublicationProbe) {
  const probe = new Int32Array(threads.workerData.__fu2PublicationProbe)
  if (threads.workerData.__fu2PublicationCacheProbe) {
    // Observe the actual owner's maps, not a second status ledger or a replacement owner.
    // Weak request references cannot themselves keep positive-control bodies alive.
    const metrics = new Int32Array(threads.workerData.__fu2PublicationCacheProbe)
    const requests = new WeakMap()
    const negative = threads.workerData.__fu2PublicationCacheNegative
    const set = Map.prototype.set,
      remove = Map.prototype.delete
    let completed, executions
    const observe = () => {
      if (!completed || !executions) return
      let bytes = 0
      for (const size of completed.values()) bytes += size
      metrics[2] = completed.size
      metrics[3] = bytes
      metrics[4] = executions.size
      metrics[8] = Math.max(metrics[8], completed.size)
      metrics[9] = Math.max(metrics[9], bytes)
    }
    Map.prototype.set = function (key, value) {
      if (typeof key === 'string' && value?.request && value.executionId === key) {
        executions = this
        const request = value.request,
          data = request.intent.args[0].data
        requests.set(value, {
          request: new WeakRef(request),
          // Only the isolated negative control deliberately reintroduces old retention.
          ...(negative ? { data } : {})
        })
        metrics[1] += data?.length ?? 0
      }
      if (key?.settled?.kind === 'settled' && typeof value === 'number') {
        completed = this
        const original = requests.get(key),
          request = original?.request.deref()
        if (negative && request) {
          key.request = request
          request.intent.args[0].data = original.data
        }
        metrics[0]++
        if (key.request !== undefined) metrics[6]++
        const retained = request?.intent.args[0].data?.length ?? 0
        if (retained) metrics[7] += retained
        if (key.request === undefined && !retained) metrics[5]++
        queueMicrotask(observe) // After the real pruning loop, before its RPC resolves.
      }
      return Reflect.apply(set, this, [key, value])
    }
    Map.prototype.delete = function (key) {
      const result = Reflect.apply(remove, this, [key])
      if (this === completed || this === executions) queueMicrotask(observe)
      return result
    }
  }
  const originalOpen = fsp.open
  const held = []
  const after = (path) =>
    basename(String(path)) === 'after' && String(path).includes('.transactions')
  fsp.open = async (...args) => {
    const file = await originalOpen(...args),
      path = args[0]
    if (!body(path)) return file
    Atomics.add(probe, 12, 1)
    let counted = true
    const read = file.read.bind(file),
      sync = file.sync.bind(file),
      close = file.close.bind(file)
    file.read = async (...input) => {
      if (String(path).includes('uploads') && Atomics.compareExchange(probe, 0, 6, 0) === 6)
        throw Object.assign(new Error('portable source read failure'), { code: 'EIO' })
      const length = typeof input[2] === 'number' ? input[2] : (input[0]?.length ?? 0)
      if (probe[8]) {
        Atomics.store(probe, 3, Math.max(probe[3], length))
        if (length > 256 * 1024) throw new Error('Unbounded publication descriptor read')
      }
      return read(...input)
    }
    file.sync = async (...input) => {
      const failMode =
        basename(String(path)) === 'blob' ? 7 : basename(String(path)) === 'publish' ? 8 : 0
      if (failMode && Atomics.compareExchange(probe, 0, failMode, 0) === failMode)
        throw Object.assign(new Error('portable output sync failure'), { code: 'EIO' })
      const mode = after(path)
        ? 1
        : basename(String(path)) === 'publish' && String(path).includes('.transactions')
          ? 5
          : 0
      if (mode && Atomics.compareExchange(probe, 0, mode, 0) === mode) {
        Atomics.store(probe, 1, 1)
        while (!Atomics.load(probe, 2)) await new Promise((resolve) => setTimeout(resolve, 1))
        if (Atomics.load(probe, 9))
          throw Object.assign(new Error('portable publication sync failure'), { code: 'EIO' })
      }
      return sync(...input)
    }
    file.close = async (...input) => {
      if (after(path) && Atomics.compareExchange(probe, 0, 3, 0) === 3) {
        held.push(file) // Deliberately leave the real FD live until actual owner exit.
        Atomics.store(probe, 1, 1)
        throw Object.assign(new Error('injected native close refusal'), { code: 'EIO' })
      }
      const result = await close(...input)
      if (counted) {
        counted = false
        Atomics.sub(probe, 12, 1)
      }
      return result
    }
    return file
  }
  for (const key of ['readFileSync', 'readFile']) {
    const original = fs[key]
    fs[key] = function (path, ...args) {
      if (probe[8] && body(path)) {
        Atomics.add(probe, 4, 1)
        throw new Error('Whole-file publication body read')
      }
      return Reflect.apply(original, this, [path, ...args])
    }
  }
  const originalReadFile = fsp.readFile
  fsp.readFile = async (path, ...args) => {
    if (probe[8] && body(path)) {
      Atomics.add(probe, 4, 1)
      throw new Error('Whole-file publication body read')
    }
    return originalReadFile(path, ...args)
  }
  const syncPaths = new Map(),
    nativeOpen = fs.openSync,
    nativeClose = fs.closeSync,
    nativeSync = fs.fsyncSync
  fs.openSync = function (path, ...args) {
    const fd = Reflect.apply(nativeOpen, this, [path, ...args])
    syncPaths.set(fd, path)
    return fd
  }
  fs.closeSync = function (fd, ...args) {
    try {
      return Reflect.apply(nativeClose, this, [fd, ...args])
    } finally {
      syncPaths.delete(fd)
    }
  }
  fs.fsyncSync = function (fd, ...args) {
    const path = syncPaths.get(fd)
    if (
      typeof path === 'string' &&
      /[/\\]artifacts[/\\]t$/.test(path) &&
      Atomics.compareExchange(probe, 0, 9, 0) === 9
    )
      throw Object.assign(new Error('portable working-parent sync failure'), { code: 'EIO' })
    return Reflect.apply(nativeSync, this, [fd, ...args])
  }
  const Database = require('better-sqlite3'),
    pragma = Database.prototype.pragma
  Database.prototype.pragma = function (sql, ...args) {
    if (/synchronous\s*=\s*FULL/i.test(sql) && Atomics.load(probe, 0) === 4) {
      let delivered = false
      try {
        delivered = !!this.prepare("SELECT 1 FROM receipts WHERE id=? AND state='delivered'").get(
          probe[10] ? 'native-fail' : 'native-pub'
        )
      } catch {
        /* Startup databases may not have receipts yet. */
      }
      if (delivered && Atomics.compareExchange(probe, 0, 4, 0) === 4) {
        this.loadExtension(threads.workerData.__fu2PublicationExtension)
        this.prepare('SELECT target_sync_thread(1)').get()
        Atomics.store(probe, 1, 1)
        // Worker only. Parent arms the real POSIX VFS before releasing this pre-fence gate.
        Atomics.wait(probe, 2, 0)
      }
    }
    return Reflect.apply(pragma, this, [sql, ...args])
  }
  syncBuiltinESMExports()
}
