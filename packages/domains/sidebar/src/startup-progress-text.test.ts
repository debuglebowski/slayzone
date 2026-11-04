import { describe, expect, it } from 'vitest'
import { describeStartupProgress } from './startup-progress-text'
import type { StartupProgress } from './types'

const p = (over: Partial<StartupProgress> = {}): StartupProgress => ({
  settled: false,
  agentsReady: 0,
  agentsTotal: 0,
  agentsBooting: 0,
  agentsQueued: 0,
  pagesLoaded: 0,
  pagesTotal: 0,
  terminalsQueued: 0,
  chatsLoading: 0,
  ...over
})

describe('startup card text', () => {
  it('counts what is left per stage, in a fixed order', () => {
    const d = describeStartupProgress(
      p({
        agentsReady: 3,
        agentsTotal: 12,
        agentsBooting: 2,
        agentsQueued: 7,
        pagesLoaded: 20,
        pagesTotal: 45,
        terminalsQueued: 6,
        chatsLoading: 2
      })
    )
    expect(d.title).toBe('Starting up')
    expect(d.left).toBe('25 pages · 9 agents · 6 terminals · 2 chats left')
  })

  it('drops finished stages and uses the singular for one', () => {
    const d = describeStartupProgress(
      p({ agentsReady: 12, agentsTotal: 12, pagesLoaded: 45, pagesTotal: 45, chatsLoading: 1 })
    )
    expect(d.left).toBe('1 chat left')
    expect(describeStartupProgress(p({ pagesLoaded: 2, pagesTotal: 3 })).left).toBe('1 page left')
    expect(describeStartupProgress(p({ agentsTotal: 1 })).left).toBe('1 agent left')
    expect(describeStartupProgress(p({ terminalsQueued: 1 })).left).toBe('1 terminal left')
  })

  it('settled: Ready, nothing left', () => {
    const d = describeStartupProgress(
      p({ settled: true, agentsReady: 4, agentsTotal: 4, pagesLoaded: 9, pagesTotal: 9 })
    )
    expect(d.title).toBe('Ready')
    expect(d.left).toBe('Nothing left')
    expect(d.percent).toBe(100)
  })

  it('the bar counts every stage: never full while anything is left', () => {
    // Pages and agents done, one chat still loading: the old bar read 100%.
    const late = describeStartupProgress(
      p({ agentsReady: 12, agentsTotal: 12, pagesLoaded: 45, pagesTotal: 45, chatsLoading: 1 })
    )
    expect(late.percent).toBeLessThan(100)
    expect(late.percent).toBe(Math.floor((57 / 58) * 100))
    expect(describeStartupProgress(p({ pagesLoaded: 1, pagesTotal: 2 })).percent).toBe(50)
    // Nothing done yet, nothing known: empty, not NaN.
    expect(describeStartupProgress(p()).percent).toBe(0)
  })

  it('keeps the full per-stage detail for the tooltip', () => {
    const d = describeStartupProgress(
      p({
        agentsReady: 3,
        agentsTotal: 12,
        agentsBooting: 2,
        agentsQueued: 7,
        pagesLoaded: 20,
        pagesTotal: 45,
        terminalsQueued: 6,
        chatsLoading: 2
      })
    )
    expect(d.details).toEqual([
      'Agents 3/12 · 2 booting · 7 queued',
      'Pages 20/45',
      'Terminals 6 waiting',
      'Chats 2 loading'
    ])
    expect(describeStartupProgress(p({ pagesLoaded: 1, pagesTotal: 1 })).details).toEqual([
      'Pages 1/1'
    ])
  })
})
