import { addDaysISO, todayISO } from '@slayzone/tasks/board'
import type { TerminalState } from '@slayzone/terminal-contracts'
import { EMPTY_TERMINAL_STATE } from '@slayzone/terminal/terminal-state'
import { boardOf, feedOf, homeHub, projectOf, taskOf, workHub } from '../hubs/testing'
import {
  agentDotOf,
  aliveTaskIds,
  cardModel,
  projectWaitingCounts,
  statusCategoryOf,
  taskAgentDot,
  waitingAgentCount
} from './card-model'

const agents = (byId: Record<string, TerminalState>) => ({
  state: { ...EMPTY_TERMINAL_STATE, byId },
  loaded: true,
  error: null
})

const project = projectOf('p')

describe('agentDotOf', () => {
  it("is desktop's dot: amber when the agent waits for the user, else its state", () => {
    expect(agentDotOf('idle', true)).toBe('attention')
    expect(agentDotOf('idle', false)).toBe('idle')
    expect(agentDotOf('running', true)).toBe('running')
    expect(agentDotOf('starting', false)).toBe('running')
    expect(agentDotOf('background', false)).toBe('background')
    expect(agentDotOf('error', false)).toBe('error')
    expect(agentDotOf('hibernated', false)).toBe('hibernated')
    expect(agentDotOf('dead', false)).toBeNull()
    expect(agentDotOf(undefined, true)).toBeNull()
  })
})

describe('taskAgentDot', () => {
  it("shows the task's most active session", () => {
    const task = taskOf('a', { needs_attention: false } as never)
    const feed = feedOf(homeHub, boardOf({ projects: [project], tasks: [task] }), {
      agents: agents({ 'a:a': 'idle', 'a:t2': 'running', 'b:b': 'error' })
    })
    expect(taskAgentDot(feed, task)).toBe('running')
    expect(taskAgentDot(feed, taskOf('c'))).toBeNull()
  })
})

describe('aliveTaskIds', () => {
  it("is desktop's Activity set: tasks with a running, background or idle session", () => {
    const feed = feedOf(homeHub, boardOf({ projects: [project] }), {
      agents: agents({
        'a:t2': 'idle',
        'b:b': 'running',
        'c:c': 'background',
        'd:d': 'error',
        'e:e': 'hibernated'
      })
    })
    expect([...aliveTaskIds(feed)].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('cardModel', () => {
  it('counts subtasks (done = completed column), resolves tags, blocked and overdue', () => {
    const yesterday = addDaysISO(todayISO(), -1)
    const data = boardOf({
      projects: [project],
      tasks: [
        taskOf('a', { due_date: yesterday }),
        taskOf('a1', { parent_id: 'a', status: 'done' }),
        taskOf('a2', { parent_id: 'a', status: 'todo' }),
        taskOf('b', { status: 'done', due_date: yesterday })
      ]
    })
    data.tags = [
      { id: 't1', name: 'design', color: 'c1', text_color: 'c2' },
      { id: 't2', name: 'web', color: 'c3', text_color: 'c4' }
    ] as never
    data.taskTags = { a: ['t2', 't1', 'gone'] }
    data.blockedTaskIds = ['a']
    const feed = feedOf(homeHub, data)
    const a = cardModel(feed, data.tasks[0], project)
    expect(a.subtasks).toEqual({ done: 1, total: 2 })
    expect(a.tags.map((t) => t.name)).toEqual(['web', 'design'])
    expect(a.tags[0]).toMatchObject({ color: 'c3', textColor: 'c4' })
    expect(a.blocked).toBe(true)
    expect(a.overdue).toBe(true)
    const b = cardModel(feed, data.tasks[3], project)
    // A finished task is never overdue.
    expect(b).toMatchObject({ subtasks: null, tags: [], blocked: false, overdue: false })
  })
})

describe('waiting counts', () => {
  const feeds = () => [
    feedOf(
      homeHub,
      boardOf({
        projects: [project, projectOf('q')],
        tasks: [
          taskOf('a', { needs_attention: true } as never),
          taskOf('b', { needs_attention: true, project_id: 'q' } as never),
          taskOf('c', { needs_attention: false } as never)
        ]
      }),
      { agents: agents({ 'a:a': 'idle', 'b:b': 'idle', 'c:c': 'idle' }) }
    ),
    feedOf(
      workHub,
      boardOf({ projects: [project], tasks: [taskOf('a', { needs_attention: true } as never)] }),
      { agents: agents({ 'a:a': 'running' }) }
    )
  ]

  it('counts agents waiting for the user, per project (keyed by hub + project)', () => {
    const counts = projectWaitingCounts(feeds())
    expect(counts.get(`${homeHub.id}\np`)).toBe(1)
    expect(counts.get(`${homeHub.id}\nq`)).toBe(1)
    expect(counts.get(`${workHub.id}\np`)).toBeUndefined()
    expect(waitingAgentCount(feeds())).toBe(2)
  })
})

describe('statusCategoryOf', () => {
  it("is the project's column category and tone, else the default workflow's", () => {
    expect(statusCategoryOf('in_progress', project)).toEqual({
      label: 'In Progress',
      category: 'started',
      tone: 'yellow'
    })
    expect(statusCategoryOf('nope', project)).toEqual({
      label: 'nope',
      category: 'unstarted',
      tone: 'gray'
    })
  })
})
