import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TypedEmitter } from '@slayzone/platform/events'
import type { TasksChangedEvent } from '@slayzone/task-contracts'
import { notifyRouter } from './notify-router'
import { setNotifyEvents, type NotifyEventMap } from './notify-events'

type Obs = {
  subscribe: (o: { next: (v: TasksChangedEvent) => void }) => { unsubscribe: () => void }
}

describe('notify.onTasksChanged', () => {
  const ev = new TypedEmitter<NotifyEventMap>()
  beforeEach(() => {
    vi.useFakeTimers()
    setNotifyEvents(ev)
  })
  afterEach(() => vi.useRealTimers())

  async function listen(input?: { boardParts: true }) {
    const caller = notifyRouter.createCaller({} as never)
    const got: TasksChangedEvent[] = []
    const obs = (await caller.onTasksChanged(input)) as unknown as Obs
    const sub = obs.subscribe({ next: (v) => got.push(v) })
    return { got, stop: () => sub.unsubscribe() }
  }

  it('names the parts to a subscriber that asked for them', async () => {
    const l = await listen({ boardParts: true })
    ev.emit('tasks-changed', { taskIds: [], parts: ['tags'] })
    expect(l.got).toEqual([{ taskIds: [], parts: ['tags'] }])
    l.stop()
  })

  it('sends unknown scope for a named part to a subscriber that did not ask (older client)', async () => {
    const l = await listen()
    ev.emit('tasks-changed', { taskIds: ['a'], parts: ['projects'] })
    expect(l.got).toEqual([{ taskIds: null }])
    l.stop()
  })

  it('a rows-only change reads the same to both', async () => {
    const parts = await listen({ boardParts: true })
    const legacy = await listen()
    ev.emit('tasks-changed', { taskIds: ['a'] })
    expect(parts.got).toEqual([{ taskIds: ['a'] }])
    expect(legacy.got).toEqual([{ taskIds: ['a'] }])
    parts.stop()
    legacy.stop()
  })
})
