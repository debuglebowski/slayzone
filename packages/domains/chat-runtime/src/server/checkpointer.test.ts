/** Exercise the real shared-worker dispatcher with deterministic resource failures. */
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { expect, test, vi } from 'vitest'
import { attachCheckpointer, CHECKPOINTER_SOURCE } from './checkpointer'

const workers = vi.hoisted(() => [] as Array<EventEmitter & { respond: boolean }>)
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Worker: class extends EventEmitter {
      respond = true
      constructor() {
        super()
        workers.push(this)
      }
      ref() {}
      unref() {}
      postMessage(message: { req: number }) {
        if (this.respond)
          queueMicrotask(() => this.emit('message', { t: 'reply', req: message.req, ok: true }))
      }
    }
  }
})

function harness() {
  const port = new EventEmitter() as EventEmitter & { postMessage(value: unknown): void }
  const messages: unknown[] = []
  port.postMessage = (value) => messages.push(value)
  const live = new Set<string>()
  const timers = new Map<number, () => void>()
  const checkpointFailures = new Set<string>()
  const setupFailures = new Set<string>()
  const closeFailures = new Set<string>()
  const descriptors = new Set<number>()
  let next = 0
  class Db {
    constructor(readonly path: string) {
      if (live.has(path)) throw new Error('duplicate connection')
      live.add(path)
    }
    pragma(source: string) {
      if (setupFailures.has(this.path) || checkpointFailures.has(this.path)) {
        throw new Error('injected storage failure')
      }
      if (source.startsWith('wal_checkpoint')) return [{ busy: 0, log: 1, checkpointed: 1 }]
      return []
    }
    close() {
      if (closeFailures.has(this.path)) throw new Error('injected close failure')
      live.delete(this.path)
    }
  }
  runInNewContext(CHECKPOINTER_SOURCE, {
    require(name: string) {
      if (name === 'node:worker_threads')
        return { parentPort: port, workerData: { modulePath: 'fixture.sqlite' } }
      if (name === 'fixture.sqlite') return Db
      if (name === 'node:fs')
        return {
          openSync() {
            const fd = ++next
            descriptors.add(fd)
            return fd
          },
          fsyncSync() {},
          closeSync(fd: number) {
            descriptors.delete(fd)
          }
        }
      throw new Error(`Unexpected dependency ${name}`)
    },
    setInterval(callback: () => void) {
      const timer = ++next
      timers.set(timer, callback)
      return timer
    },
    clearInterval(timer: number) {
      timers.delete(timer)
    }
  })
  return {
    live,
    timers,
    descriptors,
    checkpointFailures,
    setupFailures,
    closeFailures,
    messages,
    request(t: 'open' | 'close', id: string) {
      port.emit('message', { t, id, path: id, intervalMs: 1000, req: ++next })
    },
    tick() {
      for (const timer of [...timers.values()]) timer()
    }
  }
}

test('a failed checkpoint retires that store connection and timer before notifying or retrying', () => {
  const h = harness()
  h.request('open', 'a')
  h.request('open', 'b')
  h.checkpointFailures.add('a')
  h.tick()
  expect(h.messages).toContainEqual({ t: 'failed', id: 'a', message: 'injected storage failure' })
  expect([...h.live]).toEqual(['b'])
  expect(h.timers.size).toBe(1)
  expect(h.descriptors.size).toBe(1)
  h.checkpointFailures.clear()
  h.request('open', 'a')
  expect(h.messages.at(-1)).toMatchObject({ ok: true })
  expect(h.live.size).toBe(2)
  h.request('close', 'a')
  h.request('close', 'b')
  expect(h.live.size).toBe(0)
  expect(h.timers.size).toBe(0)
  expect(h.descriptors.size).toBe(0)
})

test('failed checkpointer setup closes its partial connection before the startup error reply', () => {
  const h = harness()
  h.setupFailures.add('a')
  h.request('open', 'a')
  expect(h.messages.at(-1)).toMatchObject({ ok: false, message: 'injected storage failure' })
  expect(h.live.size).toBe(0)
  expect(h.timers.size).toBe(0)
  h.setupFailures.clear()
  h.request('open', 'a')
  expect(h.messages.at(-1)).toMatchObject({ ok: true })
  h.request('close', 'a')
  expect(h.live.size).toBe(0)
})

test('failed native cleanup escapes the dispatcher to retire the helper instead of replying before file release', () => {
  const h = harness()
  h.request('open', 'a')
  h.closeFailures.add('a')
  const before = h.messages.length
  expect(() => h.request('close', 'a')).toThrow(/cleanup failed/)
  expect(h.messages.length).toBe(before)
  expect(h.timers.size).toBe(0)
})

test('an error notification cannot release the shared generation before its actual exit', async () => {
  const onFailure = vi.fn()
  const a = attachCheckpointer('/a', { onFailure })
  await a.open()
  const first = workers.at(-1)!
  first.respond = false
  first.emit('error', new Error('helper failed'))
  expect(onFailure).not.toHaveBeenCalled()
  const b = attachCheckpointer('/b', { onFailure: vi.fn() })
  const opening = b.open()
  expect(workers).toHaveLength(1)
  first.emit('exit', 1)
  await opening
  expect(onFailure).toHaveBeenCalledTimes(1)
  expect(a.active).toBe(false)
  expect(b.active).toBe(false)
  const c = attachCheckpointer('/c', { onFailure: vi.fn() })
  await c.open()
  expect(workers).toHaveLength(2)
  await c.close(false)
})
