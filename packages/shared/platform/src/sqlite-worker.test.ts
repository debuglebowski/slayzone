/**
 * The owning-thread SQLite worker client (`sqlite-worker.ts`) against a scripted
 * fake worker (`sqlite-worker.fixture.cjs`) — no SQLite, so it runs under plain
 * node on every OS. Real round-trips against better-sqlite3 live in the hub's
 * `db.test.ts`; this pins the failure paths no real DB produces on demand.
 */
import { fileURLToPath } from 'node:url'
import { MessageChannel } from 'node:worker_threads'
import { expect, test, vi } from 'vitest'
import type { SlayzoneDb } from './db'
import { openSqliteWorker } from './sqlite-worker'
import { deserializeError, reviveBuffers, serializeError } from './sqlite-worker-protocol'

const FIXTURE = fileURLToPath(new URL('./sqlite-worker.fixture.cjs', import.meta.url))

const open = (mode: string, onUnexpectedExit?: (err: Error) => void): Promise<SlayzoneDb> =>
  openSqliteWorker({
    label: 'fake worker',
    workerPath: FIXTURE,
    workerData: { mode },
    onUnexpectedExit
  })

test('a startup init-error rejects the open with message and code', async () => {
  await expect(open('init-error')).rejects.toMatchObject({
    name: 'SqliteError',
    message: 'unable to open database file',
    code: 'SQLITE_CANTOPEN'
  })
})

test('a worker that exits or throws before ready rejects the open (no hang)', async () => {
  await expect(open('exit-before-ready')).rejects.toThrow(/exited with code 3 before it was ready/)
  await expect(open('throw-before-ready')).rejects.toThrow(/startup blew up/)
})

test('worker errors keep name, message, primitive props, and the caller stack', async () => {
  const db = await open('echo')
  try {
    const err = (await db.get('fail').catch((e: unknown) => e)) as Error & Record<string, unknown>
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('VersionError')
    expect(err.message).toBe('boom')
    expect(err.code).toBe('E_VERSION')
    expect(err.retryable).toBe(false)
    expect(err.stack).toContain('sqlite-worker.test.ts')
    expect(err.stack).toContain('workerFrame')
  } finally {
    await db.close()
  }
})

test('values round-trip: Buffers stay Buffers, bigint and null survive', async () => {
  const db = await open('echo')
  try {
    const [buf, big, nul, nested] = (await db.get('echo', [
      Buffer.from('hi'),
      5n,
      null,
      { inner: [Buffer.from('x')] }
    ])) as [Buffer, bigint, null, { inner: Buffer[] }]
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.toString()).toBe('hi')
    expect(big).toBe(5n)
    expect(nul).toBeNull()
    expect(Buffer.isBuffer(nested.inner[0])).toBe(true)
  } finally {
    await db.close()
  }
})

test('params structured clone cannot carry reject that call only', async () => {
  const db = await open('echo')
  try {
    await expect(db.get('echo', [() => 1])).rejects.toThrow(/could not be cloned/)
    expect(await db.get('echo', [1])).toEqual([1])
  } finally {
    await db.close()
  }
})

test('a worker that dies after ready rejects pending + later calls and reports it once', async () => {
  const onUnexpectedExit = vi.fn()
  const db = await open('echo', onUnexpectedExit)
  const slow = db.get('slow')
  await expect(db.get('die')).rejects.toThrow(/worker exited unexpectedly \(code 7\)/)
  await expect(slow).rejects.toThrow(/exited unexpectedly/)
  await expect(db.get('echo')).rejects.toThrow(/exited unexpectedly/)
  expect(onUnexpectedExit).toHaveBeenCalledTimes(1)
  // Closing a dead DB is a no-op, not a hang.
  await expect(db.close()).resolves.toBeUndefined()
})

test('close lets earlier calls finish, then rejects later ones; no unexpected-exit report', async () => {
  const onUnexpectedExit = vi.fn()
  const db = await open('echo', onUnexpectedExit)
  const slow = db.get('slow')
  const closing = db.close()
  await expect(db.get('echo')).rejects.toThrow(/fake worker: database closed/)
  // The fake answers close immediately; the real host waits for in-flight work.
  await closing
  expect(db.close()).toBe(closing)
  await slow.catch(() => undefined)
  await new Promise((r) => setTimeout(r, 50))
  expect(onUnexpectedExit).not.toHaveBeenCalled()
})

test('an idle worker does not hold the event loop; a pending call does', async () => {
  const db = await open('echo')
  const workers = (): number =>
    process.getActiveResourcesInfo().filter((r) => r === 'Worker' || r === 'MessagePort').length
  try {
    const before = workers()
    const slow = db.get('slow')
    expect(workers()).toBeGreaterThan(before)
    await slow
    expect(workers()).toBe(before)
  } finally {
    await db.close()
  }
})

test('protocol helpers: serializeError keeps only primitive own props; reviveBuffers is zero-copy', () => {
  const e = Object.assign(new Error('m'), { code: 'X', n: 1, obj: { a: 1 }, fn: () => 1 })
  const s = serializeError(e)
  expect(s.props).toEqual({ code: 'X', n: 1 })
  expect(serializeError('str')).toEqual({ name: 'Error', message: 'str' })
  expect(deserializeError(s)).toMatchObject({ message: 'm', code: 'X', n: 1 })

  const u8 = new Uint8Array([1, 2, 3])
  const revived = reviveBuffers(u8)
  expect(Buffer.isBuffer(revived)).toBe(true)
  expect(revived.buffer).toBe(u8.buffer)
  const date = new Date(0)
  expect(reviveBuffers({ d: date }).d).toBe(date)
})

test('recovery errors retain aggregate members, causes and SQLite codes across structured clone', () => {
  const original = Object.assign(new Error('rename failed'), { code: 'EACCES' })
  const reopen = Object.assign(new Error('cannot reopen'), { code: 'SQLITE_CANTOPEN' })
  const failure = new AggregateError([original, reopen], 'swap recovery failed', {
    cause: original
  })
  const received = deserializeError(structuredClone(serializeError(failure)))
  expect(received).toBeInstanceOf(AggregateError)
  expect(received.cause).toMatchObject({ message: 'rename failed', code: 'EACCES' })
  expect((received as AggregateError).errors).toMatchObject([
    { message: 'rename failed', code: 'EACCES' },
    { message: 'cannot reopen', code: 'SQLITE_CANTOPEN' }
  ])
})

test('cyclic error causes stay cloneable without losing the original failure', () => {
  const failure = new Error('original')
  failure.cause = failure
  const received = deserializeError(structuredClone(serializeError(failure)))
  expect(received.message).toBe('original')
  expect(received.cause).toBeInstanceOf(Error)
  expect((received.cause as Error).message).toMatch(/circular/i)
})

test('close resolves only after the worker exits, not merely after its close reply', async () => {
  const gate = new Int32Array(new SharedArrayBuffer(4))
  const db = await openSqliteWorker({
    label: 'delayed exit',
    workerPath: FIXTURE,
    workerData: { mode: 'delayed-close', gate }
  })
  let settled = false
  const closing = db.close().finally(() => {
    settled = true
  })
  try {
    await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1))
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
  } finally {
    Atomics.store(gate, 0, 2)
    await closing
  }
})

test('failed startup waits for actual exit before another owner may start', async () => {
  const gate = new Int32Array(new SharedArrayBuffer(4))
  let settled = false
  const opening = openSqliteWorker({
    label: 'failed startup',
    workerPath: FIXTURE,
    workerData: { mode: 'delayed-init-error', gate }
  })
  const result = opening.then(
    () => null,
    (error) => {
      settled = true
      return error
    }
  )
  try {
    await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1))
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
  } finally {
    Atomics.store(gate, 0, 2)
  }
  expect(await result).toMatchObject({ code: 'SQLITE_CANTOPEN' })
})

test('worker data can transfer an owned control port', async () => {
  const { port1, port2 } = new MessageChannel()
  const message = new Promise((resolve) => port1.once('message', resolve))
  try {
    const db = await openSqliteWorker({
      label: 'port owner',
      workerPath: FIXTURE,
      workerData: { mode: 'port-probe', port: port2 },
      transferList: [port2]
    })
    try {
      expect(await message).toBe('worker-owned')
    } finally {
      await db.close()
    }
  } finally {
    port1.close()
    port2.close()
  }
})

test('an owner can terminate only its worker, await exit, and reject pending/later calls', async () => {
  const db = await openSqliteWorker({
    label: 'terminated owner',
    workerPath: FIXTURE,
    workerData: { mode: 'echo' }
  })
  try {
    expect(db).toHaveProperty('terminate', expect.any(Function))
    const pending = expect(db.get('slow')).rejects.toThrow(/exited unexpectedly/)
    await db.terminate()
    await pending
    await db.exited
    await expect(db.get('echo')).rejects.toThrow(/exited unexpectedly/)
  } finally {
    await db.close()
  }
})
