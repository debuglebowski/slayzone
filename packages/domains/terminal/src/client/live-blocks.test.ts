/**
 * LiveBlockStore: what streams into each row, published once per render of the
 * panel; a row hears only about its own key (plan 3.2 — a delta re-renders the
 * one row that streams, not the timeline).
 */
import { expect, test, vi } from 'vitest'
import { LiveBlockStore } from './live-blocks'

test('a publish notifies only the keys whose block changed', () => {
  const store = new LiveBlockStore()
  const a = vi.fn()
  const b = vi.fn()
  store.subscribe('text:m:0', a)
  store.subscribe('tool:t1', b)
  const text = { key: 'text:m:0', text: 'He', json: '' }
  const tool = { key: 'tool:t1', text: '', json: '{' }
  const first = [text, tool]
  store.publish(first)
  expect(a).toHaveBeenCalledTimes(1)
  expect(b).toHaveBeenCalledTimes(1)
  store.publish([{ ...text, text: 'Hello' }, tool])
  expect(a).toHaveBeenCalledTimes(2)
  expect(b).toHaveBeenCalledTimes(1)
  expect(store.get('text:m:0')?.text).toBe('Hello')
})

test('the same object is a no-op; a dropped key notifies once', () => {
  const store = new LiveBlockStore()
  const a = vi.fn()
  store.subscribe('k', a)
  const blocks = [{ key: 'k', text: 'x', json: '' }]
  store.publish(blocks)
  store.publish(blocks)
  expect(a).toHaveBeenCalledTimes(1)
  store.publish([])
  expect(a).toHaveBeenCalledTimes(2)
  expect(store.get('k')).toBeUndefined()
})

test('unsubscribe stops notifications and forgets an empty key', () => {
  const store = new LiveBlockStore()
  const a = vi.fn()
  const off = store.subscribe('k', a)
  off()
  store.publish([{ key: 'k', text: 'x', json: '' }])
  expect(a).not.toHaveBeenCalled()
  expect(store.listenerCount()).toBe(0)
})
