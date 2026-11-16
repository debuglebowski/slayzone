import type Database from 'better-sqlite3'
import { afterEach, expect, test, vi } from 'vitest'
import type { SqliteWorkerRequest, SqliteWorkerResponse } from './sqlite-worker-protocol'

const port = vi.hoisted(() => ({
  postMessage: vi.fn(),
  close: vi.fn(),
  on: vi.fn()
}))
vi.mock('node:worker_threads', () => ({ parentPort: port, workerData: {} }))
import { serveSqliteWorker } from './sqlite-worker-host'

afterEach(() => vi.clearAllMocks())

function connection(value: number) {
  let closed = false
  const db = {
    prepare: vi.fn((_sql: string) => ({
      get: () => {
        if (closed) throw new Error('The database connection is not open')
        return { value }
      }
    })),
    close: vi.fn(() => {
      closed = true
    })
  }
  return db
}
const native = (db: ReturnType<typeof connection>) => db as unknown as Database.Database
async function dispatch() {
  await vi.waitFor(() => expect(port.on).toHaveBeenCalledWith('message', expect.any(Function)))
  const listener = port.on.mock.calls.find(([event]) => event === 'message')![1] as (
    req: SqliteWorkerRequest
  ) => void
  return async (req: SqliteWorkerRequest) => {
    listener(req)
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: req.id }))
    )
    return port.postMessage.mock.calls
      .map(([msg]) => msg as SqliteWorkerResponse)
      .find((msg) => 'id' in msg && msg.id === req.id)!
  }
}

test('cached statements follow connection replacement, including replacement during a failed operation', async () => {
  const old = connection(1),
    next = connection(2)
  let current = old,
    epoch = 0
  const facade = { prepare: (sql: string) => current.prepare(sql) }
  serveSqliteWorker({
    label: 'swappable test store',
    open: () => facade as unknown as Database.Database,
    connectionEpoch: () => epoch,
    txns: {
      swap: () => {
        old.close()
        current = next
        epoch++
        throw Object.assign(new Error('swap recovered on a new connection'), { code: 'E_SWAP' })
      }
    }
  })
  const send = await dispatch()
  const query = (id: number): SqliteWorkerRequest => ({
    id,
    type: 'get',
    sql: 'SELECT value',
    params: []
  })
  expect(await send(query(1))).toMatchObject({ ok: true, result: { value: 1 } })
  expect(await send(query(2))).toMatchObject({ ok: true, result: { value: 1 } })
  expect(old.prepare).toHaveBeenCalledTimes(1)
  expect(await send({ id: 3, type: 'named-txn', name: 'swap', params: null })).toMatchObject({
    ok: false,
    error: { props: { code: 'E_SWAP' } }
  })
  expect(await send(query(4))).toMatchObject({ ok: true, result: { value: 2 } })
  expect(next.prepare).toHaveBeenCalledTimes(1)
})

test('custom asynchronous close owns final fencing and file release; later work is refused', async () => {
  const db = connection(1)
  let finish: () => void = () => undefined
  const closing = new Promise<void>((resolve) => {
    finish = resolve
  })
  const close = vi.fn(async () => {
    await closing
    db.close()
  })
  serveSqliteWorker({ label: 'owned store', open: () => native(db), close })
  const send = await dispatch()
  const closeRequest = send({ id: 1, type: 'close' })
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  expect(db.close).not.toHaveBeenCalled()
  expect(port.close).not.toHaveBeenCalled()
  expect(await send({ id: 2, type: 'get', sql: 'SELECT value', params: [] })).toMatchObject({
    ok: false,
    error: { message: 'owned store: database closed' }
  })
  finish()
  expect(await closeRequest).toMatchObject({ ok: true })
  expect(db.close).toHaveBeenCalledTimes(1)
  expect(port.close).toHaveBeenCalledTimes(1)
})

test('failed final fencing rejects close with the original recovery errors', async () => {
  const db = connection(1)
  const original = Object.assign(new Error('wal sync failed'), { code: 'SQLITE_IOERR_FSYNC' })
  const recovery = Object.assign(new Error('reopen failed'), { code: 'SQLITE_CANTOPEN' })
  serveSqliteWorker({
    label: 'failed close',
    open: () => native(db),
    close: async () => {
      throw new AggregateError([original, recovery], 'close failed', { cause: original })
    }
  })
  const send = await dispatch()
  expect(await send({ id: 1, type: 'close' })).toMatchObject({
    ok: false,
    error: {
      name: 'AggregateError',
      message: 'close failed',
      cause: { message: 'wal sync failed', props: { code: 'SQLITE_IOERR_FSYNC' } },
      errors: [{ props: { code: 'SQLITE_IOERR_FSYNC' } }, { props: { code: 'SQLITE_CANTOPEN' } }]
    }
  })
  expect(port.close).toHaveBeenCalledTimes(1)
})
