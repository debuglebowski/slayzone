import { describe, expect, it, vi } from 'vitest'
import {
  CHAT_OPEN_TIMING_EVENT,
  createChatOpenTimer,
  reportChatOpenTiming
} from './chat-open-timing'

describe('createChatOpenTimer', () => {
  it('marks whole ms since it started; the first mark of a name wins', () => {
    let now = 100
    const timer = createChatOpenTimer(() => now)
    now = 112.4
    timer.mark('hydrateMs')
    now = 150
    timer.mark('hydrateMs')
    timer.mark('openMs')
    expect(timer.payload()).toEqual({ hydrateMs: 12, openMs: 50 })
  })

  it('carries counts and flags; drops values that are not finite', () => {
    const timer = createChatOpenTimer(() => 0)
    timer.set('paged', true)
    timer.set('stateChars', 4_500_000)
    timer.set('bad', Number.NaN)
    expect(timer.payload()).toEqual({ paged: true, stateChars: 4_500_000 })
  })

  it('times one step on its own', () => {
    let now = 0
    const timer = createChatOpenTimer(() => now)
    const out = timer.time('decodeMs', () => {
      now = 7.6
      return 'x'
    })
    expect(out).toBe('x')
    expect(timer.payload()).toEqual({ decodeMs: 8 })
  })
})

describe('reportChatOpenTiming', () => {
  it('records numbers only, under the open-timing event', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    const timer = createChatOpenTimer(() => 0)
    timer.set('paged', false)
    reportChatOpenTiming(
      { diagnostics: { recordClientEvent: { mutate } } },
      { taskId: 't1', tabId: 'tab1', mode: 'claude-chat', client: 'desktop' },
      timer
    )
    expect(mutate).toHaveBeenCalledWith({
      event: CHAT_OPEN_TIMING_EVENT,
      level: 'info',
      message: 'chat open timing',
      taskId: 't1',
      payload: { tabId: 'tab1', mode: 'claude-chat', mobile: false, paged: false }
    })
  })

  it('never throws: a failed or missing diagnostics call is dropped', async () => {
    const timer = createChatOpenTimer(() => 0)
    const mutate = vi.fn().mockRejectedValue(new Error('offline'))
    expect(() =>
      reportChatOpenTiming(
        { diagnostics: { recordClientEvent: { mutate } } },
        { taskId: 't', tabId: 'x', mode: 'm', client: 'mobile' },
        timer
      )
    ).not.toThrow()
    await Promise.resolve()
    expect(() =>
      reportChatOpenTiming(
        {} as never,
        { taskId: 't', tabId: 'x', mode: 'm', client: 'mobile' },
        timer
      )
    ).not.toThrow()
  })
})
