import type { HubConnection } from '@slayzone/transport/client'
import { act, render, waitFor } from '@testing-library/react-native'
import type { BoardData, HubFeed } from './hub-board'
import { HubFeedSource } from './hub-connections'
import { hubEntryOf } from './hub-session'
import { pending, trpcTest } from './testing'

const hub = hubEntryOf('home.example')
const OPEN: HubConnection = { status: 'open', error: null }
const FAILED: HubConnection = { status: 'connecting', error: new Error('WebSocket closed') }

const boardOf = (...titles: string[]): BoardData =>
  ({
    tasks: titles.map((title, i) => ({ id: `t${i}`, title, parent_id: null, project_id: 'p' })),
    projects: [],
    tags: [],
    taskTags: {},
    blockedTaskIds: []
  }) as unknown as BoardData

/** The feeds a source reported, in order (null = withdrawn). */
function recorder() {
  const reports: Array<HubFeed | null> = []
  const onFeed = jest.fn((_hubId: string, feed: HubFeed | null) => {
    reports.push(feed)
  })
  const last = () => reports.at(-1)
  return { onFeed, reports, last }
}

describe('HubFeedSource', () => {
  it("reports the hub's board once it loads", async () => {
    const { onFeed, last } = recorder()
    const { wrapper } = trpcTest({
      procedures: { 'task.loadBoardData': () => boardOf('Write spec') },
      subscriptions: { 'notify.onTasksChanged': () => undefined }
    })
    await render(<HubFeedSource hub={hub} connection={OPEN} onFeed={onFeed} />, { wrapper })

    await waitFor(() => expect(last()?.board.data?.tasks[0].title).toBe('Write spec'))
    expect(last()).toMatchObject({ hub, connection: OPEN, stalled: false })
    expect(onFeed.mock.calls.every(([hubId]) => hubId === hub.id)).toBe(true)
  })

  it('loads the board again when the hub says its tasks changed', async () => {
    const { onFeed, last } = recorder()
    let titles = ['Before']
    let emit: (data: unknown) => void = () => undefined
    const { wrapper } = trpcTest({
      procedures: { 'task.loadBoardData': () => boardOf(...titles) },
      subscriptions: {
        'notify.onTasksChanged': (_input, push) => {
          emit = push
        }
      }
    })
    await render(<HubFeedSource hub={hub} connection={OPEN} onFeed={onFeed} />, { wrapper })
    await waitFor(() => expect(last()?.board.data?.tasks[0].title).toBe('Before'))

    titles = ['After']
    await act(async () => emit({ taskIds: ['t0'] }))
    await waitFor(() => expect(last()?.board.data?.tasks[0].title).toBe('After'))
  })

  it('reports why the board failed to load', async () => {
    const { onFeed, last } = recorder()
    const { wrapper } = trpcTest({
      procedures: {
        'task.loadBoardData': () => {
          throw new Error('hub requires authentication')
        }
      },
      subscriptions: { 'notify.onTasksChanged': () => undefined }
    })
    await render(<HubFeedSource hub={hub} connection={OPEN} onFeed={onFeed} />, { wrapper })
    await waitFor(() => expect(last()?.board.error).toBe('hub requires authentication'))
  })

  it('reports a hub as stalled only once it has been disconnected for the grace period', async () => {
    jest.useFakeTimers()
    try {
      const { onFeed, last } = recorder()
      const { wrapper } = trpcTest({
        procedures: { 'task.loadBoardData': pending },
        subscriptions: { 'notify.onTasksChanged': () => undefined }
      })
      await render(<HubFeedSource hub={hub} connection={FAILED} onFeed={onFeed} />, { wrapper })
      expect(last()?.stalled).toBe(false)

      await act(async () => jest.advanceTimersByTime(1_999))
      expect(last()?.stalled).toBe(false)
      await act(async () => jest.advanceTimersByTime(1))
      expect(last()?.stalled).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it('withdraws its feed when the hub is signed out of', async () => {
    const { onFeed, reports } = recorder()
    const { wrapper } = trpcTest({
      procedures: { 'task.loadBoardData': pending },
      subscriptions: { 'notify.onTasksChanged': () => undefined }
    })
    const view = await render(<HubFeedSource hub={hub} connection={OPEN} onFeed={onFeed} />, {
      wrapper
    })
    await view.unmount()
    expect(reports.at(-1)).toBeNull()
  })
})
