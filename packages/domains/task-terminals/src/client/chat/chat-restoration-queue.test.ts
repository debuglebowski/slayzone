import { expect, test } from 'vitest'
import { createChatRestorationQueue } from './chat-restoration-queue'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const tick = async () => {
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

test('70 restored chats stay bounded; foreground uses reserved capacity', async () => {
  const queue = createChatRestorationQueue()
  const hidden = Array.from({ length: 70 }, () => queue.enqueue(false))
  expect(hidden.filter((t) => t.ready())).toHaveLength(2)
  const visible = queue.enqueue(true)
  expect(visible.ready()).toBe(true)
  const history = deferred(),
    replacement = deferred()
  hidden[0]!.track(history.promise)
  hidden[0]!.track(replacement.promise)
  hidden[0]!.mounted()
  history.resolve()
  await tick()
  expect(hidden[2]!.ready()).toBe(false)
  replacement.resolve()
  await tick()
  expect(hidden[2]!.ready()).toBe(true)
  for (const t of [...hidden, visible]) t.cancel()
})

test('promotion skips queued background work; cancellation keeps in-flight capacity', async () => {
  const queue = createChatRestorationQueue()
  const a = queue.enqueue(false),
    b = queue.enqueue(false),
    c = queue.enqueue(false)
  c.setActive(true)
  expect(c.ready()).toBe(true)
  const work = deferred()
  a.track(work.promise)
  a.cancel()
  const next = queue.enqueue(false)
  expect(next.ready()).toBe(false)
  work.resolve()
  await tick()
  expect(next.ready()).toBe(true)
  b.cancel()
  c.cancel()
  next.cancel()
})

test('a failed request releases its slot; cancelling queued work never starts it', async () => {
  const queue = createChatRestorationQueue()
  const a = queue.enqueue(false),
    b = queue.enqueue(false),
    c = queue.enqueue(false)
  c.cancel()
  await expect(a.track(Promise.reject(new Error('offline')))).rejects.toThrow('offline')
  a.mounted()
  await tick()
  expect(c.ready()).toBe(false)
  expect(queue.snapshot()).toMatchObject({ running: 1, queued: 0 })
  a.cancel()
  b.cancel()
})

test('a ticket knows how long it waited for its slot (open-timing diagnostic)', async () => {
  let now = 1_000
  const queue = createChatRestorationQueue({
    concurrency: 1,
    backgroundConcurrency: 1,
    now: () => now
  })
  const first = queue.enqueue(true)
  const second = queue.enqueue(true)
  expect(first.queuedMs()).toBe(0)
  expect(second.queuedMs()).toBeNull()
  now = 1_250
  first.mounted()
  await tick()
  expect(second.ready()).toBe(true)
  expect(second.queuedMs()).toBe(250)
  first.cancel()
  second.cancel()
})

test('a newly visible tab can open while the previous selection finishes, with one extra slot at most', async () => {
  const queue = createChatRestorationQueue()
  const hidden = [queue.enqueue(false), queue.enqueue(false)]
  const opening = queue.enqueue(true)
  const waiting = queue.enqueue(false)
  const next = queue.enqueue(false)
  const work = [deferred(), deferred(), deferred(), deferred()]
  for (const [i, ticket] of [...hidden, opening].entries()) {
    void ticket.track(work[i].promise)
    ticket.mounted()
  }

  opening.setActive(false)
  waiting.setActive(true)
  expect(waiting.ready()).toBe(true)
  expect(queue.snapshot()).toMatchObject({ running: 4, queued: 1 })
  void waiting.track(work[3].promise)
  waiting.mounted()

  waiting.setActive(false)
  next.setActive(true)
  expect(next.ready()).toBe(false)
  expect(queue.snapshot().peakRunning).toBe(4)
  work[0].resolve()
  await tick()
  expect(next.ready()).toBe(true)
  expect(queue.snapshot().peakRunning).toBe(4)
  for (const item of work) item.resolve()
  for (const ticket of [...hidden, opening, waiting, next]) ticket.cancel()
})
