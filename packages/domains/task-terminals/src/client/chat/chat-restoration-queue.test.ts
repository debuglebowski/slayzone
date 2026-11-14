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
    metadata = deferred()
  hidden[0]!.track(history.promise)
  hidden[0]!.track(metadata.promise)
  hidden[0]!.mounted()
  history.resolve()
  await tick()
  expect(hidden[2]!.ready()).toBe(false)
  metadata.resolve()
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
