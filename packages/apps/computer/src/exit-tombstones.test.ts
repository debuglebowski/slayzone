import { afterEach, describe, expect, test, vi } from 'vitest'
import { RingBuffer } from '@slayzone/terminal/pty-detection'
import { CARRY_WINDOW_MS, ExitTombstones } from './exit-tombstones'

afterEach(() => {
  vi.useRealTimers()
})

describe('exit tombstones: buffer handover to a continuing spawn', () => {
  test('the reaped attempt hands its buffer over once, to the matching attempt only', () => {
    const t = new ExitTombstones()
    const buffer = new RingBuffer(1024)
    buffer.append('agent-out')
    t.add('s', { spawnId: 'a', exitCode: 1, signal: null, buffer, bufferUntil: Date.now() + 1000 })
    expect(t.takeBuffer('s', 'other')).toBeNull()
    expect(t.takeBuffer('s', 'a')).toBe(buffer)
    expect(t.takeBuffer('s', 'a')).toBeNull()
    // The exit itself is still remembered.
    expect(t.list()).toEqual([expect.objectContaining({ sessionId: 's', spawnId: 'a' })])
  })

  test('a carry-window buffer is dropped after the window; the tombstone stays', () => {
    vi.useFakeTimers()
    const t = new ExitTombstones()
    t.add('s', {
      spawnId: 'a',
      exitCode: 0,
      signal: null,
      buffer: new RingBuffer(1024),
      bufferUntil: Date.now() + CARRY_WINDOW_MS
    })
    vi.advanceTimersByTime(CARRY_WINDOW_MS)
    expect(t.get('s')?.buffer).toBeUndefined()
    expect(t.takeBuffer('s', 'a')).toBeNull()
    expect(t.get('s')?.spawnId).toBe('a')
  })

  test('an undelivered exit keeps its buffer to the TTL (no window)', () => {
    vi.useFakeTimers()
    const t = new ExitTombstones()
    const buffer = new RingBuffer(1024)
    t.add('s', { spawnId: 'a', exitCode: 0, signal: null, buffer })
    vi.advanceTimersByTime(CARRY_WINDOW_MS * 2)
    expect(t.get('s')?.buffer).toBe(buffer)
  })
})
