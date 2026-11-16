/** One at a time per key (pty-store: a tab's start and the hub's adoption of it). */
import { expect, test } from 'vitest'
import { createKeyedSerializer } from './keyed-serializer'

const tick = () => new Promise((r) => setTimeout(r, 0))

test('a second run for the same key waits for the first; other keys do not', async () => {
  const run = createKeyedSerializer()
  const order: string[] = []
  let release: () => void = () => undefined
  const first = run('a', () => new Promise<void>((r) => (release = r)).then(() => order.push('a1')))
  const second = run('a', async () => order.push('a2'))
  const other = run('b', async () => order.push('b1'))
  await other
  await tick()
  expect(order).toEqual(['b1'])
  release()
  await Promise.all([first, second])
  expect(order).toEqual(['b1', 'a1', 'a2'])
  expect(run.size()).toBe(0)
})

test('a failed run does not block the next one, and keeps its own rejection', async () => {
  const run = createKeyedSerializer()
  const failed = run('a', async () => {
    throw new Error('boom')
  })
  await expect(failed).rejects.toThrow('boom')
  await expect(run('a', async () => 'ok')).resolves.toBe('ok')
  expect(run.size()).toBe(0)
})
