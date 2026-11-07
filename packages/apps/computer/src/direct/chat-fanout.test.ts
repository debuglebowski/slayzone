/**
 * The computer's chat events to direct-link clients (docs/direct-link.md): per tab,
 * pinned to the ownership epoch the hub granted — a stream ends as soon as this
 * computer's epoch for the tab moves on (the conversation moved or was deleted).
 */
import { describe, expect, it } from 'vitest'
import { createDirectChatFanout } from './chat-fanout'

const owner = (epoch: number) => ({ tabId: 'tab', epoch })

describe('direct chat fan-out', () => {
  it('streams the tab’s events, in the hub’s onEvent shape', () => {
    const f = createDirectChatFanout()
    const got: unknown[] = []
    f.watch(
      'tab',
      2,
      (e) => got.push(e),
      () => undefined
    )
    f.publish(owner(2), { event: { kind: 'a' }, seq: 4, at: 10 })
    f.publish(owner(2), { event: { kind: 'b' }, seq: 4, live: 1 })
    f.publish({ tabId: 'other', epoch: 2 }, { event: { kind: 'x' }, seq: 1 })
    expect(got).toEqual([
      { tabId: 'tab', event: { kind: 'a' }, seq: 4, at: 10 },
      { tabId: 'tab', event: { kind: 'b' }, seq: 4, live: 1 }
    ])
  })

  it('ends the stream when the computer’s epoch for the tab differs from the grant’s', () => {
    const f = createDirectChatFanout()
    const got: unknown[] = []
    const ended: string[] = []
    f.watch(
      'tab',
      2,
      (e) => got.push(e),
      (why) => ended.push(why)
    )
    f.publish(owner(3), { event: { kind: 'a' }, seq: 1 })
    expect(got).toEqual([])
    expect(ended).toEqual(['epoch'])
    f.publish(owner(3), { event: { kind: 'b' }, seq: 2 })
    expect(ended).toEqual(['epoch'])
  })

  it('ends every stream of a tab whose conversation is gone', () => {
    const f = createDirectChatFanout()
    const ended: string[] = []
    f.watch(
      'tab',
      2,
      () => undefined,
      (why) => ended.push(why)
    )
    f.end('tab', 'deleted')
    expect(ended).toEqual(['deleted'])
  })

  it('unsubscribe stops delivery', () => {
    const f = createDirectChatFanout()
    const got: unknown[] = []
    const off = f.watch(
      'tab',
      2,
      (e) => got.push(e),
      () => undefined
    )
    off()
    f.publish(owner(2), { event: {}, seq: 1 })
    expect(got).toEqual([])
  })
})
