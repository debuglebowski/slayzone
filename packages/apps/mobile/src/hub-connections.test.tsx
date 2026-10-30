import type { HubConnection } from '@slayzone/transport/client'
import { act, render, waitFor } from '@testing-library/react-native'
import { type BoardData, type HubFeed, hubProblem } from './hub-board'
import { HubFeedSource } from './hub-connections'
import { hubEntryOf } from './hub-session'
import { pending, trpcTest } from './testing'

const hub = hubEntryOf('home.example')
const OPEN: HubConnection = { status: 'open', error: null }
const FAILED: HubConnection = { status: 'connecting', error: new Error('WebSocket closed') }
const FIRST_ATTEMPT: HubConnection = { status: 'connecting', error: null }

const boardOf = (...titles: string[]): BoardData =>
  ({
    tasks: titles.map((title, i) => ({ id: `t${i}`, title, parent_id: null, project_id: 'p' })),
    projects: [],
    tags: [],
    taskTags: {},
    blockedTaskIds: []
  }) as unknown as BoardData

/** A hub with no agents: what the feed's agent half asks every hub. */
const NO_AGENTS = {
  procedures: {
    'pty.sessionList': () => [],
    'taskTerminals.listHibernatedSessions': () => []
  },
  subscriptions: {
    'pty.onStateChange': () => undefined,
    'pty.onExit': () => undefined,
    'pty.onBackgroundJobs': () => undefined,
    'pty.onHibernated': () => undefined
  }
}

/** `trpcTest` over the board half's handlers plus `NO_AGENTS`. */
function hubBackend(backend: {
  procedures?: Record<string, (input: unknown) => unknown>
  subscriptions?: Record<string, (input: unknown, emit: (data: unknown) => void) => unknown>
}) {
  return trpcTest({
    procedures: { ...NO_AGENTS.procedures, ...backend.procedures },
    subscriptions: {
      ...NO_AGENTS.subscriptions,
      ...backend.subscriptions
    } as Parameters<typeof trpcTest>[0]['subscriptions']
  })
}

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
    const { wrapper } = hubBackend({
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
    const { wrapper } = hubBackend({
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
    const { wrapper } = hubBackend({
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
      const { wrapper } = hubBackend({
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

  it("reports the hub's agent sessions beside its board", async () => {
    const { onFeed, last } = recorder()
    const { wrapper } = hubBackend({
      procedures: {
        'task.loadBoardData': () => boardOf('Write spec'),
        'pty.sessionList': () => [{ sessionId: 't0:t0', state: 'running', kind: 'pty' }]
      },
      subscriptions: { 'notify.onTasksChanged': () => undefined }
    })
    await render(<HubFeedSource hub={hub} connection={OPEN} onFeed={onFeed} />, { wrapper })
    await waitFor(() => expect(last()?.agents.state.byId).toEqual({ 't0:t0': 'running' }))
    expect(last()?.agents.loaded).toBe(true)
  })

  it('withdraws its feed when the hub is signed out of', async () => {
    const { onFeed, reports } = recorder()
    const { wrapper } = hubBackend({
      procedures: { 'task.loadBoardData': pending },
      subscriptions: { 'notify.onTasksChanged': () => undefined }
    })
    const view = await render(<HubFeedSource hub={hub} connection={OPEN} onFeed={onFeed} />, {
      wrapper
    })
    await view.unmount()
    expect(reports.at(-1)).toBeNull()
  })

  describe('when the socket comes back', () => {
    it('reloads a board that failed while the hub was unreachable, so the banner clears without Retry', async () => {
      const { onFeed, last } = recorder()
      let reachable = false
      const { wrapper } = hubBackend({
        procedures: {
          'task.loadBoardData': () => {
            if (!reachable) throw new Error('Hub home.example did not connect within 15000ms')
            return boardOf('Back again')
          }
        },
        subscriptions: { 'notify.onTasksChanged': () => undefined }
      })
      const view = await render(<HubFeedSource hub={hub} connection={FAILED} onFeed={onFeed} />, {
        wrapper
      })
      await waitFor(() => expect(last()?.board.error).toMatch(/did not connect/))

      reachable = true
      await view.rerender(<HubFeedSource hub={hub} connection={OPEN} onFeed={onFeed} />)
      await waitFor(() => expect(last()?.board.data?.tasks[0].title).toBe('Back again'))
      expect(last()?.board.error).toBeNull()
      expect(hubProblem(last() as HubFeed)).toBeNull()
    })

    it('reloads the board and the agent sessions after a dropped socket (pushes were missed)', async () => {
      const { onFeed, last } = recorder()
      let titles = ['Before']
      let sessions: unknown[] = [{ sessionId: 't0:t0', state: 'running', kind: 'pty' }]
      const { wrapper } = hubBackend({
        procedures: {
          'task.loadBoardData': () => boardOf(...titles),
          'pty.sessionList': () => sessions
        },
        subscriptions: { 'notify.onTasksChanged': () => undefined }
      })
      const view = await render(<HubFeedSource hub={hub} connection={OPEN} onFeed={onFeed} />, {
        wrapper
      })
      await waitFor(() => expect(last()?.agents.state.byId).toEqual({ 't0:t0': 'running' }))
      await waitFor(() => expect(last()?.board.data?.tasks[0].title).toBe('Before'))

      await view.rerender(<HubFeedSource hub={hub} connection={FAILED} onFeed={onFeed} />)
      // While it was away a task was renamed, and the agent finished and exited.
      titles = ['After']
      sessions = []
      await view.rerender(<HubFeedSource hub={hub} connection={OPEN} onFeed={onFeed} />)
      await waitFor(() => expect(last()?.board.data?.tasks[0].title).toBe('After'))
      await waitFor(() => expect(last()?.agents.state.byId).toEqual({ 't0:t0': 'dead' }))
    })

    it('reloads a board that hit the connect deadline while a first attempt still hung', async () => {
      const { onFeed, last } = recorder()
      let reachable = false
      const { wrapper } = hubBackend({
        procedures: {
          'task.loadBoardData': () => {
            if (!reachable) throw new Error('Hub home.example did not connect within 15000ms')
            return boardOf('Late but there')
          }
        },
        subscriptions: { 'notify.onTasksChanged': () => undefined }
      })
      const view = await render(
        <HubFeedSource hub={hub} connection={FIRST_ATTEMPT} onFeed={onFeed} />,
        { wrapper }
      )
      await waitFor(() => expect(last()?.board.error).toMatch(/did not connect/))

      reachable = true
      await view.rerender(<HubFeedSource hub={hub} connection={OPEN} onFeed={onFeed} />)
      await waitFor(() => expect(last()?.board.data?.tasks[0].title).toBe('Late but there'))
      expect(hubProblem(last() as HubFeed)).toBeNull()
    })

    it('loads nothing twice on a first connect that never failed', async () => {
      const { onFeed, last } = recorder()
      const calls = { board: 0, sessions: 0 }
      const { wrapper } = hubBackend({
        procedures: {
          'task.loadBoardData': () => {
            calls.board++
            return boardOf('Once')
          },
          'pty.sessionList': () => {
            calls.sessions++
            return []
          }
        },
        subscriptions: { 'notify.onTasksChanged': () => undefined }
      })
      const view = await render(
        <HubFeedSource hub={hub} connection={FIRST_ATTEMPT} onFeed={onFeed} />,
        { wrapper }
      )
      await view.rerender(<HubFeedSource hub={hub} connection={OPEN} onFeed={onFeed} />)
      await waitFor(() => expect(last()?.board.data?.tasks[0].title).toBe('Once'))
      await waitFor(() => expect(last()?.agents.loaded).toBe(true))
      expect(calls).toEqual({ board: 1, sessions: 1 })
    })
  })
})
