import type { TerminalState } from '@slayzone/terminal-contracts'
import { EMPTY_TERMINAL_STATE, type TerminalStateData } from '@slayzone/terminal/terminal-state'
import type { BoardData, BoardTask, HubFeed } from '../hub-board'
import { hubEntryOf } from '../hub-session'
import { groupAgentRows, mergeHubAgents, tabIdOfSession, taskAgentSessions } from './hub-agents'

const home = hubEntryOf('home.example')
const work = hubEntryOf('work.example')

const task = (id: string, title: string, needsAttention = false): BoardTask =>
  ({
    id,
    title,
    status: 'todo',
    priority: 2,
    project_id: 'p1',
    parent_id: null,
    needs_attention: needsAttention,
    terminal_mode: 'claude-code'
  }) as unknown as BoardTask

const board = (...tasks: BoardTask[]): BoardData =>
  ({
    tasks,
    projects: [{ id: 'p1', name: 'Proj', color: null }],
    tags: [],
    taskTags: {},
    blockedTaskIds: []
  }) as unknown as BoardData

function sessions(
  byId: Record<string, TerminalState>,
  extra: Partial<TerminalStateData> = {}
): TerminalStateData {
  return { ...EMPTY_TERMINAL_STATE, byId, ...extra }
}

function feed(hub: typeof home, data: BoardData, state: TerminalStateData): HubFeed {
  return {
    hub,
    connection: { status: 'open', error: null },
    stalled: false,
    board: { data, pending: false, error: null, refreshing: false },
    agents: { state, loaded: true, error: null }
  }
}

describe('mergeHubAgents', () => {
  it('lists every task with an agent session, across hubs, tagged with its hub', () => {
    const rows = mergeHubAgents([
      feed(home, board(task('a', 'Spec'), task('b', 'Idle task')), sessions({ 'a:a': 'running' })),
      feed(work, board(task('a', 'Ship')), sessions({ 'a:a': 'running' }))
    ])
    expect(rows.map((r) => [r.hubId, r.task.title, r.state])).toEqual([
      [home.id, 'Spec', 'running'],
      [work.id, 'Ship', 'running']
    ])
    // Hubs may share task ids: keys stay unique.
    expect(new Set(rows.map((r) => r.key)).size).toBe(2)
  })

  it('puts what needs the user first: waiting, error, running, paused, done', () => {
    const rows = mergeHubAgents([
      feed(
        home,
        board(
          task('done', 'Done one'),
          task('run', 'Running one'),
          task('wait', 'Waiting one', true),
          task('err', 'Broken one'),
          task('hib', 'Paused one')
        ),
        sessions({
          'done:done': 'dead',
          'run:run': 'running',
          'wait:wait': 'idle',
          'err:err': 'error',
          'hib:hib': 'hibernated'
        })
      )
    ])
    expect(rows.map((r) => r.task.title)).toEqual([
      'Waiting one',
      'Broken one',
      'Running one',
      'Paused one',
      'Done one'
    ])
    expect(rows[0]).toMatchObject({ group: 'waiting', unread: true })
  })

  it("shows a task by its most active session (the main tab's on a tie)", () => {
    const rows = mergeHubAgents([
      feed(
        home,
        board(task('t', 'Two tabs')),
        sessions({ 't:t': 'idle', 't:side': 'running' }, { jobsById: { 't:t': 2, 't:side': 1 } })
      )
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'running', sessionId: 't:side', backgroundJobs: 3 })
  })

  it('skips sessions whose task is not on the board (yet)', () => {
    expect(
      mergeHubAgents([feed(home, board(task('a', 'A')), sessions({ 'gone:gone': 'running' }))])
    ).toEqual([])
  })

  it('groups rows under their titles, empty groups left out', () => {
    const rows = mergeHubAgents([
      feed(
        home,
        board(task('a', 'A', true), task('b', 'B')),
        sessions({ 'a:a': 'idle', 'b:b': 'running' })
      )
    ])
    expect(groupAgentRows(rows).map((g) => [g.title, g.rows.length])).toEqual([
      ['Waiting for you', 1],
      ['Running', 1]
    ])
  })
})

describe('sessions of one task', () => {
  it('lists the known sessions of a task with their state and jobs', () => {
    const state = sessions(
      { 't:t': 'running', 't:x': 'dead', 'u:u': 'idle' },
      { jobsById: { 't:t': 1 } }
    )
    expect(taskAgentSessions(state, 't')).toEqual([
      { sessionId: 't:t', tabId: 't', state: 'running', backgroundJobs: 1 },
      { sessionId: 't:x', tabId: 'x', state: 'dead', backgroundJobs: 0 }
    ])
    expect(tabIdOfSession('t:x')).toBe('x')
  })
})
