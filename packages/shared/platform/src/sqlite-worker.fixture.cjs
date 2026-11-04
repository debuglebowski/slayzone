// A scripted stand-in for a SQLite worker (sqlite-worker.test.ts): speaks the
// `sqlite-worker-protocol` wire format without SQLite, so the owning-thread client's
// failure paths can be driven deterministically. Plain CJS: runs as-is in a worker.
const { parentPort, workerData } = require('node:worker_threads')

const mode = workerData.mode

if (mode === 'init-error') {
  parentPort.postMessage({
    type: 'init-error',
    error: {
      name: 'SqliteError',
      message: 'unable to open database file',
      props: { code: 'SQLITE_CANTOPEN' }
    }
  })
  parentPort.close()
} else if (mode === 'exit-before-ready') {
  process.exit(3)
} else if (mode === 'throw-before-ready') {
  throw new Error('startup blew up')
} else {
  parentPort.on('message', (req) => {
    if (req.type === 'close') {
      parentPort.postMessage({ id: req.id, ok: true, result: undefined })
      parentPort.close()
      return
    }
    if (req.type === 'get' && req.sql === 'die') {
      // Answer nothing; die with the request outstanding.
      setTimeout(() => process.exit(7), 10)
      return
    }
    if (req.type === 'get' && req.sql === 'slow') {
      setTimeout(() => parentPort.postMessage({ id: req.id, ok: true, result: 'slow-done' }), 200)
      return
    }
    if (req.type === 'get' && req.sql === 'fail') {
      parentPort.postMessage({
        id: req.id,
        ok: false,
        error: {
          name: 'VersionError',
          message: 'boom',
          stack: 'VersionError: boom\n    at workerFrame (w.js:1:1)',
          props: { code: 'E_VERSION', retryable: false }
        }
      })
      return
    }
    // Echo: return what arrived, so value round-trips are observable.
    parentPort.postMessage({ id: req.id, ok: true, result: req.params })
  })
  parentPort.postMessage({ type: 'ready' })
}
