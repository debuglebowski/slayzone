import { describe, expect, test, vi } from 'vitest'
import {
  mergeOpenTabs,
  orderToPush,
  startOpenTabsSync,
  type OpenTabsSyncHost
} from './open-tabs-sync'
import type { TabsStateTrpcClient } from './trpc'

const merge = (
  base: string[] | undefined,
  local: string[],
  remote: string[],
  openAnywhere: string[] = local
) => mergeOpenTabs({ base, local, remote, openAnywhere: new Set(openAnywhere) })

describe('mergeOpenTabs: a hub first seen (no base) joins both sides, closes nothing', () => {
  test('union', () => {
    expect(merge(undefined, ['a', 'b'], ['b', 'c'])).toEqual({
      openLocally: ['c'],
      closeLocally: [],
      pushOpen: ['a'],
      pushClose: []
    })
  })
})

describe('mergeOpenTabs: with a base, each side keeps the other side’s changes', () => {
  test('nothing changed: nothing to do', () => {
    expect(merge(['a', 'b'], ['a', 'b'], ['a', 'b'])).toEqual({
      openLocally: [],
      closeLocally: [],
      pushOpen: [],
      pushClose: []
    })
  })

  test('opened elsewhere → opened here; closed elsewhere → closed here', () => {
    const r = merge(['a', 'b'], ['a', 'b'], ['b', 'c'])
    expect(r.openLocally).toEqual(['c'])
    expect(r.closeLocally).toEqual(['a'])
    expect(r.pushOpen).toEqual([])
    expect(r.pushClose).toEqual([])
  })

  test('opened here → pushed; closed here → pushed', () => {
    const r = merge(['a', 'b'], ['b', 'c'], ['a', 'b'])
    expect(r.pushOpen).toEqual(['c'])
    expect(r.pushClose).toEqual(['a'])
    expect(r.openLocally).toEqual([])
    expect(r.closeLocally).toEqual([])
  })

  test('both sides closed the same tab, or opened the same one: no-op', () => {
    const r = merge(['a', 'b'], ['b', 'c'], ['b', 'c'])
    expect(r).toEqual({
      openLocally: [],
      closeLocally: [],
      pushOpen: [],
      pushClose: []
    })
  })

  test('a tab still open here but not yet known to belong to this hub is never pushed closed', () => {
    // `a` is in the base, open on this client, but its hub is not resolved yet (so not
    // in `local`): absence from `local` is not a close.
    const r = merge(['a', 'b'], ['b'], ['a', 'b'], ['a', 'b'])
    expect(r.pushClose).toEqual([])
  })

  test('closed elsewhere while unresolved here: still closed here', () => {
    const r = merge(['a', 'b'], ['b'], ['b'], ['a', 'b'])
    expect(r.closeLocally).toEqual(['a'])
  })
})

describe('orderToPush: this client’s order of the hub’s tabs, after the merge', () => {
  test('a reorder here is pushed', () => {
    expect(orderToPush(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b'])
  })

  test('unchanged since the last sync: nothing (an order changed only elsewhere is not pushed back, so two clients never ping-pong)', () => {
    expect(orderToPush(['a', 'b', 'c'], ['a', 'b', 'c'])).toBeNull()
  })

  test('tabs opened or closed since: the new order is pushed', () => {
    expect(orderToPush(['a'], ['b', 'a'])).toEqual(['b', 'a'])
    expect(orderToPush(['a', 'b'], ['b'])).toEqual(['b'])
  })

  test('a hub first seen: its order is pushed', () => {
    expect(orderToPush(undefined, ['a', 'b'])).toEqual(['a', 'b'])
  })
})

// ── the running sync, against a fake hub and a fake tab bar ──────────────────

function fakeHub(initial: string[] = []) {
  let list = [...initial]
  const subs: { onStarted?: () => void; onData?: () => void }[] = []
  const calls: string[] = []
  const client = {
    openTabs: {
      list: { query: async () => [...list] },
      open: {
        mutate: async ({ taskId }: { taskId: string }) => {
          calls.push(`open ${taskId}`)
          if (!list.includes(taskId)) list.push(taskId)
        }
      },
      close: {
        mutate: async ({ taskId }: { taskId: string }) => {
          calls.push(`close ${taskId}`)
          list = list.filter((id) => id !== taskId)
        }
      },
      reorder: {
        mutate: async ({ taskIds }: { taskIds: string[] }) => {
          calls.push(`reorder ${taskIds.join(',')}`)
          const named = list.filter((id) => taskIds.includes(id))
          const order = taskIds.filter((id) => named.includes(id))
          let i = 0
          list = list.map((id) => (named.includes(id) ? (order[i++] as string) : id))
        }
      },
      onChanged: {
        subscribe: (_: unknown, handlers: { onStarted?: () => void; onData?: () => void }) => {
          subs.push(handlers)
          return { unsubscribe: () => {} }
        }
      }
    }
  }
  return {
    client: client as unknown as TabsStateTrpcClient,
    get list() {
      return list
    },
    calls,
    /** Another client of the same user changed the list. */
    elsewhere(next: string[]) {
      list = [...next]
      for (const s of subs) s.onData?.()
    },
    connect() {
      for (const s of subs) s.onStarted?.()
    }
  }
}

function fakeDesktop(tabs: { taskId: string; hubId?: string }[], base: Record<string, string[]>) {
  const listeners = new Set<() => void>()
  const host: OpenTabsSyncHost = {
    taskTabs: () => tabs.map((t) => ({ ...t })),
    openInBackground: (taskId) => {
      if (!tabs.some((t) => t.taskId === taskId)) tabs.push({ taskId })
    },
    close: (taskId) => {
      const i = tabs.findIndex((t) => t.taskId === taskId)
      if (i >= 0) tabs.splice(i, 1)
    },
    base: (hubId) => base[hubId],
    setBase: (hubId, ids) => {
      base[hubId] = ids
    },
    onTabsChanged: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
  return { host, tabs, base }
}

const settle = () => new Promise((r) => setTimeout(r, 0))
const flush = async () => {
  for (let i = 0; i < 10; i++) await settle()
}

describe('startOpenTabsSync', () => {
  test('first sync with a hub: joins both lists, pushes the desktop order', async () => {
    const hub = fakeHub(['ipad-1'])
    const desk = fakeDesktop([{ taskId: 'd-1', hubId: 'h' }], {})
    const stop = startOpenTabsSync(desk.host, { hubIds: () => ['h'], clientOf: () => hub.client })
    hub.connect()
    await flush()
    expect(desk.tabs.map((t) => t.taskId)).toEqual(['d-1', 'ipad-1'])
    expect(hub.list).toEqual(['d-1', 'ipad-1'])
    expect(desk.base.h).toEqual(['d-1', 'ipad-1'])
    stop()
  })

  test('closed on the iPad → closed on the desktop; opened on the iPad → opened here', async () => {
    const hub = fakeHub(['a', 'b'])
    const desk = fakeDesktop(
      [
        { taskId: 'a', hubId: 'h' },
        { taskId: 'b', hubId: 'h' }
      ],
      { h: ['a', 'b'] }
    )
    const stop = startOpenTabsSync(desk.host, { hubIds: () => ['h'], clientOf: () => hub.client })
    hub.connect()
    await flush()
    expect(hub.calls).toEqual([])
    hub.elsewhere(['b', 'c'])
    await flush()
    expect(desk.tabs.map((t) => t.taskId)).toEqual(['b', 'c'])
    expect(desk.base.h).toEqual(['b', 'c'])
    stop()
  })

  test('changed on the desktop while the hub was away: reaches the hub on reconnect', async () => {
    const hub = fakeHub(['a', 'b'])
    const desk = fakeDesktop(
      [
        { taskId: 'b', hubId: 'h' },
        { taskId: 'c', hubId: 'h' }
      ],
      { h: ['a', 'b'] }
    )
    const stop = startOpenTabsSync(desk.host, { hubIds: () => ['h'], clientOf: () => hub.client })
    hub.connect()
    await flush()
    expect(hub.list).toEqual(['b', 'c'])
    expect(hub.calls).toContain('open c')
    expect(hub.calls).toContain('close a')
    stop()
  })

  test("another hub's tabs are left alone", async () => {
    const hub = fakeHub([])
    const desk = fakeDesktop([{ taskId: 'x', hubId: 'other' }], {})
    const stop = startOpenTabsSync(desk.host, { hubIds: () => ['h'], clientOf: () => hub.client })
    hub.connect()
    await flush()
    expect(hub.list).toEqual([])
    expect(desk.tabs).toEqual([{ taskId: 'x', hubId: 'other' }])
    stop()
  })

  test('one push the hub refuses does not stop the others, and is tried again, never undone', async () => {
    const hub = fakeHub(['gone-here', 'c'])
    const refuse = new Set(['b', 'gone-here'])
    const real = hub.client.openTabs
    const flaky = {
      ...real,
      open: {
        mutate: async (i: { taskId: string }) =>
          refuse.has(i.taskId) ? Promise.reject(new Error('refused')) : real.open.mutate(i)
      },
      close: {
        mutate: async (i: { taskId: string }) =>
          refuse.has(i.taskId) ? Promise.reject(new Error('refused')) : real.close.mutate(i)
      }
    }
    const client = { openTabs: flaky } as unknown as TabsStateTrpcClient
    // `gone-here` and `c` were closed on this desktop; `a` and `b` opened here.
    const desk = fakeDesktop(
      [
        { taskId: 'a', hubId: 'h' },
        { taskId: 'b', hubId: 'h' }
      ],
      { h: ['gone-here', 'c'] }
    )
    const stop = startOpenTabsSync(desk.host, { hubIds: () => ['h'], clientOf: () => client })
    hub.connect()
    await flush()
    expect(hub.list).toEqual(['gone-here', 'a'])
    // The refused close is not undone here (no reopen), the refused open stays open.
    expect(desk.tabs.map((t) => t.taskId)).toEqual(['a', 'b'])
    // The hub accepts now: the next sync sends both again.
    refuse.clear()
    hub.connect()
    await flush()
    expect(hub.list.sort()).toEqual(['a', 'b'])
    expect(desk.tabs.map((t) => t.taskId)).toEqual(['a', 'b'])
    stop()
  })

  test('a tab opened here while a sync is in flight is pushed next, never closed', async () => {
    const hub = fakeHub([])
    const desk = fakeDesktop([{ taskId: 'a', hubId: 'h' }], {})
    const real = hub.client.openTabs
    let opened = false
    const slow = {
      ...real,
      open: {
        mutate: async (i: { taskId: string }) => {
          await real.open.mutate(i)
          // The user opens another tab while this sync still awaits the hub.
          if (!opened) {
            opened = true
            desk.tabs.push({ taskId: 'b', hubId: 'h' })
          }
        }
      }
    }
    const client = { openTabs: slow } as unknown as TabsStateTrpcClient
    const stop = startOpenTabsSync(desk.host, { hubIds: () => ['h'], clientOf: () => client })
    hub.connect()
    await flush()
    // `b` never reached the hub, so it is not agreed yet.
    expect(desk.base.h).toEqual(['a'])
    // The next sync (its tab change, or any hub ping) pushes it instead of closing it.
    hub.connect()
    await flush()
    expect(desk.tabs.map((t) => t.taskId)).toEqual(['a', 'b'])
    expect(hub.list).toEqual(['a', 'b'])
    expect(desk.base.h).toEqual(['a', 'b'])
    stop()
  })

  test('a tab closed here while a sync is in flight is pushed closed next, never reopened', async () => {
    const hub = fakeHub(['a', 'b'])
    const desk = fakeDesktop(
      [
        { taskId: 'a', hubId: 'h' },
        { taskId: 'b', hubId: 'h' },
        { taskId: 'c', hubId: 'h' }
      ],
      { h: ['a', 'b'] }
    )
    const real = hub.client.openTabs
    let closed = false
    const slow = {
      ...real,
      open: {
        mutate: async (i: { taskId: string }) => {
          await real.open.mutate(i)
          // The user closes `b` while this sync still pushes `c`.
          if (!closed) {
            closed = true
            desk.tabs.splice(
              desk.tabs.findIndex((t) => t.taskId === 'b'),
              1
            )
          }
        }
      }
    }
    const client = { openTabs: slow } as unknown as TabsStateTrpcClient
    const stop = startOpenTabsSync(desk.host, { hubIds: () => ['h'], clientOf: () => client })
    hub.connect()
    await flush()
    hub.connect()
    await flush()
    expect(desk.tabs.map((t) => t.taskId)).toEqual(['a', 'c'])
    expect(hub.list).toEqual(['a', 'c'])
    expect(desk.base.h).toEqual(['a', 'c'])
    stop()
  })

  test('a hub that cannot answer changes nothing', async () => {
    const desk = fakeDesktop([{ taskId: 'a', hubId: 'h' }], { h: ['a'] })
    const broken = {
      openTabs: {
        list: { query: async () => Promise.reject(new Error('NOT_FOUND')) },
        onChanged: {
          subscribe: (_: unknown, h: { onStarted?: () => void }) => {
            h.onStarted?.()
            return { unsubscribe: () => {} }
          }
        }
      }
    } as unknown as TabsStateTrpcClient
    const stop = startOpenTabsSync(desk.host, { hubIds: () => ['h'], clientOf: () => broken })
    await flush()
    expect(desk.tabs).toEqual([{ taskId: 'a', hubId: 'h' }])
    expect(desk.base.h).toEqual(['a'])
    stop()
  })
})

describe('startOpenTabsSync: hubs that appear later', () => {
  test('a hub whose client appears after the start is watched without any tab change', async () => {
    vi.useFakeTimers()
    try {
      const hub = fakeHub(['ipad-1'])
      const desk = fakeDesktop([], {})
      let ready = false
      const stop = startOpenTabsSync(desk.host, {
        hubIds: () => (ready ? ['h'] : []),
        clientOf: () => hub.client
      })
      ready = true
      await vi.advanceTimersByTimeAsync(1_500)
      hub.connect()
      await vi.advanceTimersByTimeAsync(10)
      expect(desk.tabs.map((t) => t.taskId)).toEqual(['ipad-1'])
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
