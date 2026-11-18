import type { TerminalState } from '@slayzone/terminal-contracts'
import { EMPTY_TERMINAL_STATE } from '@slayzone/terminal/terminal-state'
import { boardOf, feedOf, homeHub, projectOf, taskOf, workHub } from '../hubs/testing'
import { attentionLoad, attentionRows, attentionSections, attentionSubtitle } from './attention'

const agents = (byId: Record<string, TerminalState>) => ({
  state: { ...EMPTY_TERMINAL_STATE, byId },
  loaded: true,
  error: null
})

const feeds = () => [
  feedOf(
    homeHub,
    boardOf({
      projects: [projectOf('p', { name: 'Website' }), projectOf('q', { name: 'Backend' })],
      tasks: [
        taskOf('run', { title: 'Cookie banner' }),
        taskOf('wait', { title: 'Landing', needs_attention: true } as never),
        taskOf('other', { title: 'Migrate', project_id: 'q', needs_attention: true } as never)
      ]
    }),
    { agents: agents({ 'run:run': 'running', 'wait:wait': 'idle', 'other:other': 'idle' }) }
  ),
  feedOf(workHub, boardOf({ projects: [projectOf('p')], tasks: [taskOf('x')] }), {
    agents: agents({ 'x:x': 'idle' })
  })
]

describe('attentionRows', () => {
  it('lists every hub’s agents, the ones waiting for you first', () => {
    expect(attentionRows(feeds(), null).map((r) => r.task.title)).toEqual([
      'Landing',
      'Migrate',
      'Cookie banner',
      'x'
    ])
  })

  it('narrows to one project of one hub', () => {
    expect(
      attentionRows(feeds(), { hubId: homeHub.id, projectId: 'p' }).map((r) => r.task.title)
    ).toEqual(['Landing', 'Cookie banner'])
  })

  it('says project and state', () => {
    const [landing] = attentionRows(feeds(), null)
    expect(attentionSubtitle(landing, false)).toBe('Website · Ready for review')
    expect(attentionSubtitle(landing, true)).toBe(`Website · ${homeHub.label} · Ready for review`)
  })
})

describe('attentionSections', () => {
  it('groups the rows under a header per group, in the rows’ order', () => {
    const sections = attentionSections(attentionRows(feeds(), null))
    expect(sections.map((s) => [s.title, s.rows.map((r) => r.task.title)])).toEqual([
      ['Ready for review', ['Landing', 'Migrate']],
      ['Running', ['Cookie banner']],
      ['Done', ['x']]
    ])
  })
})

describe('attentionLoad', () => {
  it('loading until every hub’s board and agents are in', () => {
    const board = boardOf({ tasks: [taskOf('a')] })
    expect(attentionLoad([feedOf(homeHub, board)])).toEqual({ kind: 'loading' })
    expect(attentionLoad([feedOf(homeHub, undefined, { agents: agents({}) })])).toEqual({
      kind: 'loading'
    })
    expect(attentionLoad([feedOf(homeHub, board, { agents: agents({}) })])).toEqual({
      kind: 'ready'
    })
  })

  it('says which hub failed and why', () => {
    const failed = feedOf(homeHub, boardOf({}), {
      agents: { state: EMPTY_TERMINAL_STATE, loaded: false, error: 'socket closed' }
    })
    expect(attentionLoad([failed])).toEqual({
      kind: 'error',
      message: `${homeHub.label}: socket closed`
    })
  })
})
