import { describe, expect, it } from 'vitest'
import {
  createStartupWatch,
  STARTUP_QUIET_MS,
  STARTUP_SHOW_AFTER_MS,
  type StartupInputs
} from './startup-progress'

const T0 = 1_000_000
const idle: StartupInputs = {
  agents: [],
  panes: { hydrated: 1, queued: 0 },
  terminalsQueued: 0,
  chatsLoading: 0
}
const q = (sessionId: string) => ({ sessionId, phase: 'queued' as const })
const b = (sessionId: string) => ({ sessionId, phase: 'booting' as const })

describe('startup watch', () => {
  it('a fast boot never shows the card', () => {
    const w = createStartupWatch(T0)
    expect(w.update({ ...idle, agents: [q('a')] }, T0 + 10).visible).toBe(false)
    expect(w.update(idle, T0 + 200).visible).toBe(false)
    // The show-delay recheck lands in the quiet spell: still nothing (no "Ready" flash).
    expect(w.update(idle, T0 + STARTUP_SHOW_AFTER_MS).visible).toBe(false)
    const end = w.update(idle, T0 + 200 + STARTUP_QUIET_MS)
    expect(end.visible).toBe(false)
    expect(end.recheckAt).toBe(null)
    expect(end.ended).toBe(true)
    // Latched: later agent starts are not "startup".
    expect(w.update({ ...idle, agents: [q('z')] }, T0 + 60_000).visible).toBe(false)
  })

  it('counts agents and tabs while the boot is slow, then hides after a quiet spell', () => {
    const w = createStartupWatch(T0)
    const first = w.update(
      {
        agents: [b('a'), q('b'), q('c')],
        panes: { hydrated: 1, queued: 3 },
        terminalsQueued: 0,
        chatsLoading: 0
      },
      T0 + 100
    )
    expect(first.visible).toBe(false)
    expect(first.recheckAt).toBe(T0 + STARTUP_SHOW_AFTER_MS)

    const slow = w.update(
      {
        agents: [b('b'), q('c'), q('d')],
        panes: { hydrated: 3, queued: 1 },
        terminalsQueued: 0,
        chatsLoading: 0
      },
      T0 + STARTUP_SHOW_AFTER_MS
    )
    expect(slow.visible).toBe(true)
    expect(slow.progress).toEqual({
      settled: false,
      agentsReady: 1,
      agentsTotal: 4,
      agentsBooting: 1,
      agentsQueued: 2,
      pagesLoaded: 3,
      pagesTotal: 4,
      terminalsQueued: 0,
      chatsLoading: 0
    })

    // Everything up: shown as settled through the quiet spell, then gone for good.
    const t1 = T0 + 5_000
    const settled = w.update(
      { agents: [], panes: { hydrated: 4, queued: 0 }, terminalsQueued: 0, chatsLoading: 0 },
      t1
    )
    expect(settled.visible).toBe(true)
    expect(settled.progress?.settled).toBe(true)
    expect(settled.progress?.agentsReady).toBe(4)
    expect(settled.recheckAt).toBe(t1 + STARTUP_QUIET_MS)
    expect(
      w.update({ ...idle, panes: { hydrated: 4, queued: 0 } }, t1 + STARTUP_QUIET_MS).visible
    ).toBe(false)
  })

  it('work arriving during the quiet spell (a terminal still waiting for its turn) keeps startup open', () => {
    const w = createStartupWatch(T0)
    w.update({ ...idle, panes: { hydrated: 1, queued: 2 } }, T0 + 2_000)
    w.update(idle, T0 + 3_000)
    const waiting = w.update({ ...idle, terminalsQueued: 1 }, T0 + 3_000 + STARTUP_QUIET_MS)
    expect(waiting.visible).toBe(true)
    expect(waiting.progress?.settled).toBe(false)
    // Shown on the card, not only waited on.
    expect(waiting.progress?.terminalsQueued).toBe(1)
    const agent = w.update({ ...idle, agents: [q('x')] }, T0 + 9_000)
    expect(agent.progress?.agentsTotal).toBe(1)
    expect(agent.progress?.agentsQueued).toBe(1)
  })

  it('a chat still loading its history keeps startup open, and is shown', () => {
    const w = createStartupWatch(T0)
    w.update({ ...idle, panes: { hydrated: 1, queued: 2 } }, T0 + 2_000)
    w.update({ ...idle, chatsLoading: 2 }, T0 + 3_000)
    const loading = w.update({ ...idle, chatsLoading: 2 }, T0 + 3_000 + STARTUP_QUIET_MS)
    expect(loading.ended).toBe(false)
    expect(loading.visible).toBe(true)
    expect(loading.progress?.settled).toBe(false)
    expect(loading.progress?.chatsLoading).toBe(2)
    // Its agent asked to start: the hub reports it from here.
    const agent = w.update({ ...idle, agents: [q('chat')] }, T0 + 7_000)
    expect(agent.progress?.chatsLoading).toBe(0)
    expect(agent.progress?.agentsQueued).toBe(1)
  })

  it('startup does not end before the hub has reported its agents', () => {
    const w = createStartupWatch(T0)
    const before = w.update({ ...idle, agents: null }, T0 + 5_000 + STARTUP_QUIET_MS)
    expect(before.recheckAt).toBe(null)
    const r = w.update({ ...idle, agents: [b('a')] }, T0 + 6_000 + STARTUP_QUIET_MS)
    expect(r.visible).toBe(true)
    expect(r.progress?.agentsBooting).toBe(1)
  })

  it('nothing to report (no tabs, no agents) shows nothing', () => {
    const w = createStartupWatch(T0)
    const r = w.update(
      { agents: [], panes: { hydrated: 0, queued: 0 }, terminalsQueued: 0, chatsLoading: 0 },
      T0 + 5_000
    )
    expect(r.visible).toBe(false)
  })
})
