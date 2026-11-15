/**
 * FU5 (computer stalls, request fan-out): every saved user message — and again its
 * delivery receipt — made the hub tell every client "this task's prompts and sessions
 * changed", and each told client re-read the sessions list (a full summaries scan and
 * two ledger queries on the computer). A tab's notifications are now coalesced: one
 * per tab per window, sent at most `delayMs` after the first.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createTabChangeCoalescer } from './tab-change-coalescer'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('a burst of one tab’s changes is one notification, at most delayMs after the first', () => {
  const flushed: string[] = []
  const c = createTabChangeCoalescer({ delayMs: 200, flush: (tab) => flushed.push(tab) })
  c.notify('tab-a') // user-message
  vi.advanceTimersByTime(50)
  c.notify('tab-a') // user-message-delivery
  c.notify('tab-a')
  vi.advanceTimersByTime(149)
  expect(flushed).toEqual([])
  vi.advanceTimersByTime(1)
  expect(flushed).toEqual(['tab-a'])
  vi.advanceTimersByTime(1_000)
  expect(flushed).toEqual(['tab-a'])
})

test('tabs are independent; a change after the window opens a new one', () => {
  const flushed: string[] = []
  const c = createTabChangeCoalescer({ delayMs: 200, flush: (tab) => flushed.push(tab) })
  c.notify('tab-a')
  c.notify('tab-b')
  vi.advanceTimersByTime(200)
  expect(flushed.sort()).toEqual(['tab-a', 'tab-b'])
  c.notify('tab-a')
  vi.advanceTimersByTime(200)
  expect(flushed).toHaveLength(3)
})

test('close() drops what is pending; a flush that throws never escapes', () => {
  const flushed: string[] = []
  const c = createTabChangeCoalescer({
    delayMs: 200,
    flush: (tab) => {
      flushed.push(tab)
      throw new Error('owner lookup failed')
    }
  })
  c.notify('tab-a')
  expect(() => vi.advanceTimersByTime(200)).not.toThrow()
  c.notify('tab-b')
  c.close()
  vi.advanceTimersByTime(1_000)
  expect(flushed).toEqual(['tab-a'])
})
