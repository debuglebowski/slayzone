import { addDaysISO, todayISO } from '@slayzone/tasks/board'
import { boardOf, projectOf, taskOf } from '../hubs/testing'
import {
  boardColumns,
  DEFAULT_BOARD_FILTER,
  filterIsActive,
  neighbourStatuses,
  projectStatuses,
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

  it('knows when a filter is on', () => {
    expect(filterIsActive(DEFAULT_BOARD_FILTER)).toBe(false)
    expect(filterIsActive({ ...DEFAULT_BOARD_FILTER, dueDateRange: 'overdue' })).toBe(true)
    expect(addDaysISO(todayISO(), 0)).toBe(todayISO())
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
