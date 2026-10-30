import type { HubConnection } from '@slayzone/transport/client'
import { hubEntryOf } from './hub-session'
import {
  type BoardData,
  type BoardTask,
  findTaskRow,
  type HubFeed,
  hubProblem,
  mergeHubTasks,
  ownerClient
} from './hub-board'

const home = hubEntryOf('home.example')
const work = hubEntryOf('work.example')

const OPEN: HubConnection = { status: 'open', error: null }
const FIRST_ATTEMPT: HubConnection = { status: 'connecting', error: null }
const FAILED: HubConnection = { status: 'connecting', error: new Error('WebSocket closed') }

function task(id: string, fields: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    title: id,
    project_id: 'p1',
    parent_id: null,
    status: 'todo',
    ...fields
  } as BoardTask
}

function board(tasks: BoardTask[], projectName = 'Project'): BoardData {
  return {
    tasks,
    projects: [{ id: 'p1', name: projectName, color: null }],
    tags: [],
    taskTags: {},
    blockedTaskIds: []
  } as unknown as BoardData
}

function feed(hub: typeof home, fields: Partial<HubFeed> = {}): HubFeed {
  return {
    hub,
    connection: OPEN,
    stalled: false,
    board: { data: undefined, pending: true, error: null, refreshing: false },
    ...fields
  }
}

const loaded = (data: BoardData): HubFeed['board'] => ({
  data,
  pending: false,
  error: null,
  refreshing: false
})

describe('mergeHubTasks', () => {
  it('lists every hub’s top-level tasks in one list, each tagged with its hub', () => {
    const rows = mergeHubTasks([
      feed(home, { board: loaded(board([task('a'), task('a1', { parent_id: 'a' })], 'Home')) }),
      feed(work, { board: loaded(board([task('b')], 'Work')) })
    ])
    expect(rows.map((r) => [r.hubId, r.task.id, r.project?.name])).toEqual([
      [home.id, 'a', 'Home'],
      [work.id, 'b', 'Work']
    ])
    expect(rows[1].hubLabel).toBe('work.example')
  })

  it('keeps the same task id from two hubs apart (dev and prod hubs share ids)', () => {
    const rows = mergeHubTasks([
      feed(home, { board: loaded(board([task('same')])) }),
      feed(work, { board: loaded(board([task('same')])) })
    ])
    expect(rows.map((r) => r.hubId)).toEqual([home.id, work.id])
    expect(new Set(rows.map((r) => r.key)).size).toBe(2)
  })

  it('leaves out a hub with no board yet', () => {
    expect(
      mergeHubTasks([feed(home), feed(work, { board: loaded(board([task('b')])) })])
    ).toHaveLength(1)
  })
})

describe('findTaskRow', () => {
  it('finds any task of a hub by id, subtasks too (a deep link may name one)', () => {
    const f = feed(work, {
      board: loaded(board([task('a'), task('a1', { parent_id: 'a' })], 'Work'))
    })
    expect(findTaskRow(f, 'a1')).toMatchObject({
      hubId: work.id,
      task: { id: 'a1' },
      project: { name: 'Work' }
    })
    expect(findTaskRow(f, 'missing')).toBeNull()
    expect(findTaskRow(feed(work), 'a')).toBeNull()
  })
})

describe('hubProblem', () => {
  it('is nothing for a connected hub, loading or loaded', () => {
    expect(hubProblem(feed(home))).toBeNull()
    expect(hubProblem(feed(home, { board: loaded(board([])) }))).toBeNull()
  })

  it('is nothing for a reconnect still within its grace period', () => {
    expect(hubProblem(feed(home, { connection: FAILED, board: loaded(board([])) }))).toBeNull()
  })

  it("says a hub can't be reached once a failed connection outlasts the grace period", () => {
    expect(hubProblem(feed(home, { connection: FAILED, stalled: true }))).toEqual({
      kind: 'unreachable',
      hub: home,
      detail: 'WebSocket closed'
    })
  })

  it("says a hub can't be reached when its board failed while not connected", () => {
    const problem = hubProblem(
      feed(home, {
        connection: FIRST_ATTEMPT,
        board: { data: undefined, pending: false, error: 'Hub unreachable', refreshing: false }
      })
    )
    expect(problem).toEqual({ kind: 'unreachable', hub: home, detail: 'Hub unreachable' })
  })

  it('says a first connection is still under way once it outlasts the grace period', () => {
    expect(hubProblem(feed(home, { connection: FIRST_ATTEMPT, stalled: true }))).toEqual({
      kind: 'connecting',
      hub: home
    })
  })

  it('reports what a connected hub refused', () => {
    const problem = hubProblem(
      feed(home, {
        board: {
          data: undefined,
          pending: false,
          error: 'hub requires authentication',
          refreshing: false
        }
      })
    )
    expect(problem).toEqual({ kind: 'failed', hub: home, message: 'hub requires authentication' })
  })
})

describe('ownerClient', () => {
  it('returns the client of the hub that owns the row', () => {
    const clients = { [home.id]: 'home-client', [work.id]: 'work-client' }
    const resolve = (hubId: string) =>
      hubId in clients ? { ws: { client: clients[hubId] } } : null
    expect(ownerClient(resolve as never, work.id)).toBe('work-client')
  })

  it('refuses a hub that is not signed in, instead of writing elsewhere', () => {
    expect(() => ownerClient((() => null) as never, home.id)).toThrow(/not signed in/)
  })
})
