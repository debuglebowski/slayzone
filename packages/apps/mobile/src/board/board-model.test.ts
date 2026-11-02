import { addDaysISO, todayISO } from '@slayzone/tasks/board'
import { boardOf, projectOf, taskOf } from '../hubs/testing'
import {
  boardColumns,
  DEFAULT_BOARD_FILTER,
  clearNarrowing,
  filterIsActive,
  filterNarrows,
  displayGroup,
  neighbourStatuses,
  projectStatuses,
  resetDisplay,
  treeColumns
} from './board-model'

/** A workflow column (its tone is a workflow token, not a colour the app paints). */
const TONE = 'slate'
const statusColumn = (id: string, label: string, position: number, category: string) => ({
  id,
  label,
  color: TONE,
  position,
  category
})

const columns = [
  statusColumn('queued', 'Queued', 0, 'unstarted'),
  statusColumn('doing', 'Doing', 1, 'started'),
  statusColumn('shipped', 'Shipped', 2, 'completed')
]
const project = projectOf('p', { columns_config: columns } as never)

const data = () =>
  boardOf({
    projects: [project],
    tasks: [
      taskOf('a', { status: 'queued', order: 0, priority: 1, due_date: todayISO() }),
      taskOf('b', { status: 'doing', order: 0, priority: 3 }),
      taskOf('c', { status: 'shipped', order: 0 }),
      taskOf('a1', { status: 'doing', order: 1, parent_id: 'a' }),
      taskOf('tmp', { status: 'queued', order: 2, is_temporary: true }),
      taskOf('other', { status: 'queued', project_id: 'q' })
    ]
  })

const ids = (cols: { id: string; tasks: { id: string }[] }[]) =>
  cols.map((c) => `${c.id}:${c.tasks.map((t) => t.id).join(',')}`)

describe('boardColumns', () => {
  it("is the project's own columns, its top-level tasks in board order (desktop's board)", () => {
    expect(ids(boardColumns(data(), project, DEFAULT_BOARD_FILTER))).toEqual([
      'queued:a',
      'doing:b',
      'shipped:c'
    ])
    expect(projectStatuses(project).map((c) => c.label)).toEqual(['Queued', 'Doing', 'Shipped'])
  })

  it('filters by priority, due date, tags and done like desktop', () => {
    const d = data()
    d.taskTags = { b: ['tag1'] }
    expect(ids(boardColumns(d, project, { ...DEFAULT_BOARD_FILTER, priority: 1 }))).toEqual([
      'queued:a',
      'doing:',
      'shipped:'
    ])
    expect(
      ids(boardColumns(d, project, { ...DEFAULT_BOARD_FILTER, dueDateRange: 'today' }))
    ).toEqual(['queued:a', 'doing:', 'shipped:'])
    expect(ids(boardColumns(d, project, { ...DEFAULT_BOARD_FILTER, tagIds: ['tag1'] }))).toEqual([
      'queued:',
      'doing:b',
      'shipped:'
    ])
    expect(ids(boardColumns(d, project, { ...DEFAULT_BOARD_FILTER, showDone: false }))).toEqual([
      'queued:a',
      'doing:b',
      'shipped:'
    ])
  })

  it('shows blocked tasks in a Blocked column after the last started column', () => {
    const d = data()
    d.blockedTaskIds = ['a']
    expect(ids(boardColumns(d, project, { ...DEFAULT_BOARD_FILTER, showBlocked: true }))).toEqual([
      'queued:',
      'doing:b',
      '__blocked__:a',
      'shipped:c'
    ])
  })

  it('hides empty columns when "show empty columns" is off (desktop: on by default)', () => {
    expect(DEFAULT_BOARD_FILTER.showEmpty).toBe(true)
    const urgent = { ...DEFAULT_BOARD_FILTER, priority: 1 }
    expect(ids(boardColumns(data(), project, urgent))).toEqual(['queued:a', 'doing:', 'shipped:'])
    expect(ids(boardColumns(data(), project, { ...urgent, showEmpty: false }))).toEqual([
      'queued:a'
    ])
  })

  it('narrowing = priority, due date or tags; clearing them keeps the Display options', () => {
    const shown = { ...DEFAULT_BOARD_FILTER, showDone: false, showEmpty: false }
    expect(filterNarrows(shown)).toBe(false)
    const narrow = { ...shown, priority: 1, dueDateRange: 'today' as const, tagIds: ['g'] }
    expect(filterNarrows(narrow)).toBe(true)
    expect(filterNarrows({ ...shown, tagIds: ['g'] })).toBe(true)
    expect(clearNarrowing(narrow)).toEqual(shown)
  })

  it('knows when a filter is on', () => {
    expect(filterIsActive(DEFAULT_BOARD_FILTER)).toBe(false)
    expect(filterIsActive({ ...DEFAULT_BOARD_FILTER, dueDateRange: 'overdue' })).toBe(true)
    expect(addDaysISO(todayISO(), 0)).toBe(todayISO())
  })
})

describe('Display: group by, sort, archived, sub-tasks (desktop FilterBarB)', () => {
  const rich = () =>
    boardOf({
      projects: [project],
      tasks: [
        taskOf('a', {
          status: 'queued',
          order: 0,
          priority: 1,
          title: 'Zed',
          due_date: '2020-01-01',
          created_at: '2026-01-01'
        }),
        taskOf('b', {
          status: 'doing',
          order: 0,
          priority: 3,
          title: 'Alpha',
          created_at: '2026-03-01'
        }),
        taskOf('c', {
          status: 'queued',
          order: 1,
          priority: 3,
          title: 'Mid',
          due_date: addDaysISO(todayISO(), 400),
          created_at: '2026-02-01'
        }),
        taskOf('a1', { status: 'doing', order: 1, parent_id: 'a', priority: 1 }),
        taskOf('old', { status: 'queued', order: 2, archived_at: '2026-10-01' })
      ]
    })

  it('defaults to desktop: status, manual, no archived, no sub-tasks', () => {
    expect(DEFAULT_BOARD_FILTER).toMatchObject({
      groupBy: 'status',
      sortBy: 'manual',
      showArchived: false,
      showSubTasks: false
    })
  })

  it('groups by priority / due date into desktop groups', () => {
    const byPriority = boardColumns(rich(), project, {
      ...DEFAULT_BOARD_FILTER,
      groupBy: 'priority'
    })
    expect(ids(byPriority)).toEqual(['p1:a', 'p2:', 'p3:b,c', 'p4:', 'p5:'])
    expect(byPriority[0].title).toBe('Urgent')
    const byDue = boardColumns(rich(), project, { ...DEFAULT_BOARD_FILTER, groupBy: 'due_date' })
    expect(ids(byDue)).toEqual(['overdue:a', 'today:', 'this_week:', 'later:c', 'no_date:b'])
  })

  it('sorts within each group (priority, due date, title, newest)', () => {
    const queued = (sortBy: string) =>
      ids(boardColumns(rich(), project, { ...DEFAULT_BOARD_FILTER, sortBy } as never))[0]
    expect(queued('manual')).toBe('queued:a,c')
    expect(queued('priority')).toBe('queued:a,c')
    expect(queued('due_date')).toBe('queued:a,c')
    expect(queued('title')).toBe('queued:c,a')
    expect(queued('created')).toBe('queued:c,a')
  })

  it('shows archived tasks and sub-tasks (as their own cards) when on', () => {
    expect(
      ids(boardColumns(rich(), project, { ...DEFAULT_BOARD_FILTER, showArchived: true }))
    ).toEqual(['queued:a,c,old', 'doing:b', 'shipped:'])
    expect(
      ids(boardColumns(rich(), project, { ...DEFAULT_BOARD_FILTER, showSubTasks: true }))
    ).toEqual(['queued:a,c', 'doing:b,a1', 'shipped:'])
  })

  it('the list also has No groups and Activity; the board falls back to status for them', () => {
    const none = { ...DEFAULT_BOARD_FILTER, groupBy: 'none' as const }
    expect(ids(boardColumns(rich(), project, none, { view: 'list' }))).toEqual(['all:a,b,c'])
    expect(ids(boardColumns(rich(), project, none, { view: 'kanban' }))).toEqual([
      'queued:a,c',
      'doing:b',
      'shipped:'
    ])
    const activity = { ...DEFAULT_BOARD_FILTER, groupBy: 'active' as const }
    expect(
      ids(boardColumns(rich(), project, activity, { view: 'list', activeTaskIds: new Set(['c']) }))
    ).toEqual(['active:c', 'inactive:a,b'])
    expect(
      ids(
        boardColumns(
          rich(),
          project,
          { ...activity, showEmpty: false },
          {
            view: 'list',
            activeTaskIds: new Set()
          }
        )
      )
    ).toEqual(['inactive:a,b,c'])
    expect(displayGroup('kanban', 'active')).toBe('status')
    expect(displayGroup('list', 'active')).toBe('active')
    expect(displayGroup('tree', 'priority')).toBe('priority')
  })

  it('Display reset and "filter on" cover the new options', () => {
    const changed = {
      ...DEFAULT_BOARD_FILTER,
      groupBy: 'priority' as const,
      sortBy: 'title' as const,
      showArchived: true,
      showSubTasks: true
    }
    expect(filterIsActive(changed)).toBe(true)
    expect(filterNarrows(changed)).toBe(false)
    expect(resetDisplay(changed)).toEqual(DEFAULT_BOARD_FILTER)
  })
})

describe('treeColumns', () => {
  it('nests subtasks under their parent, whatever their status', () => {
    const tree = treeColumns(data(), project, DEFAULT_BOARD_FILTER)
    expect(tree.map((c) => c.id)).toEqual(['queued', 'doing', 'shipped'])
    expect(tree[0].nodes.map((n) => [n.task.id, n.depth])).toEqual([
      ['a', 0],
      ['a1', 1]
    ])
    expect(tree[1].nodes.map((n) => n.task.id)).toEqual(['b'])
  })
})

describe('neighbourStatuses', () => {
  it("is the previous and next of the project's statuses", () => {
    expect(neighbourStatuses(project, 'queued')).toEqual({ prev: null, next: columns[1] })
    expect(neighbourStatuses(project, 'doing')).toEqual({ prev: columns[0], next: columns[2] })
    expect(neighbourStatuses(project, 'gone')).toEqual({ prev: null, next: null })
  })
})
