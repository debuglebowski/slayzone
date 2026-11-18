import { describe, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { ChatStreamPosition } from './chat-stream-position'

const status = (epoch: string, revision = 1): AgentEvent =>
  ({
    kind: 'turn-status',
    authoritative: true,
    epoch,
    revision,
    state: 'idle',
    reportedState: 'idle',
    turnOpen: false,
    mainTurnOpen: false,
    pendingRequestIds: [],
    outboxInFlight: 0
  }) as AgentEvent
const delta: AgentEvent = { kind: 'assistant-text-delta', text: 'x' } as unknown as AgentEvent

describe('saved events', () => {
  test('apply once, in seq order; anything at or below the newest is a duplicate', () => {
    const p = new ChatStreamPosition()
    expect(p.saved(0)).toBe('apply')
    expect(p.saved(1)).toBe('apply')
    expect(p.saved(1)).toBe('duplicate')
    expect(p.saved(0)).toBe('duplicate')
    expect(p.seq).toBe(1)
  })
})

describe('live events', () => {
  test('apply right after the newest saved event, with a newer live counter', () => {
    const p = new ChatStreamPosition()
    p.saved(3)
    expect(p.live(delta, 3, 1)).toBe('apply')
    expect(p.live(delta, 3, 1)).toBe('drop')
    expect(p.live(delta, 2, 2)).toBe('drop')
    expect(p.live(delta, 3, 2)).toBe('apply')
  })

  test('a live event after a saved event this client never got: resync (the gap)', () => {
    const p = new ChatStreamPosition()
    p.saved(3)
    expect(p.live(delta, 5, 9)).toBe('resync')
    // Nothing moved: the catch-up starts from what this client has.
    expect(p.seq).toBe(3)
  })

  test('a status from another server instance: resync, even with a lower live counter', () => {
    const p = new ChatStreamPosition()
    p.saved(3)
    expect(p.live(status('a'), 3, 40)).toBe('apply')
    expect(p.epoch).toBe('a')
    // The instance restarted: its live counter starts over, nothing new saved.
    expect(p.live(status('b'), 3, 1)).toBe('resync')
    expect(p.epoch).toBe('a')
  })
})

describe('the live part of a load', () => {
  test('applies only at the position it was read for', () => {
    const p = new ChatStreamPosition()
    p.saved(3)
    expect(p.snapshot({ afterSeq: 2, liveSeq: 5, events: [] })).toBe('skip')
    expect(p.snapshot({ afterSeq: 3, liveSeq: 5, events: [] })).toBe('apply')
    expect(p.live(delta, 3, 5)).toBe('drop')
    expect(p.live(delta, 3, 6)).toBe('apply')
  })

  test('another instance: its live counter replaces this one (not the higher of the two)', () => {
    const p = new ChatStreamPosition()
    p.saved(3)
    p.live(status('a'), 3, 40)
    expect(p.snapshot({ afterSeq: 3, liveSeq: 2, events: [status('b')] })).toBe('apply')
    expect(p.epoch).toBe('b')
    expect(p.live(delta, 3, 3)).toBe('apply')
  })

  test('the same instance never moves its live counter back', () => {
    const p = new ChatStreamPosition()
    p.saved(3)
    p.live(status('a'), 3, 40)
    expect(p.snapshot({ afterSeq: 3, liveSeq: 2, events: [status('a', 2)] })).toBe('apply')
    expect(p.live(delta, 3, 30)).toBe('drop')
  })
})

describe('a catch-up (the events after this client’s newest, read on reconnect)', () => {
  test('a server behind this client (log restarted elsewhere, or tab unknown): reload', () => {
    const p = new ChatStreamPosition()
    p.saved(9)
    expect(p.catchUpNeedsReload({ afterSeq: 4, liveSeq: 0, events: [] })).toBe(true)
    expect(p.catchUpNeedsReload({ afterSeq: -1, liveSeq: 0, events: [] })).toBe(true)
  })

  test('the same instance with a lower live counter cannot be: reload', () => {
    const p = new ChatStreamPosition()
    p.saved(9)
    p.live(status('a'), 9, 20)
    expect(p.catchUpNeedsReload({ afterSeq: 9, liveSeq: 3, events: [status('a', 2)] })).toBe(true)
  })

  test('another instance, the saved log intact: no reload (the log is durable)', () => {
    const p = new ChatStreamPosition()
    p.saved(9)
    p.live(status('a'), 9, 20)
    expect(p.catchUpNeedsReload({ afterSeq: 12, liveSeq: 1, events: [status('b')] })).toBe(false)
  })
})

test('reset: nothing applied yet', () => {
  const p = new ChatStreamPosition()
  p.saved(4)
  p.live(status('a'), 4, 2)
  p.reset()
  expect([p.seq, p.liveSeq, p.epoch]).toEqual([-1, 0, null])
})
