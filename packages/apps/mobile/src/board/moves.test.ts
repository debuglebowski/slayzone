import { boardOf, taskOf } from '../hubs/testing'
import { applyMovePlan, dragAllowed, planDrop, planStatusChange, reorderAllowed } from './moves'

/**
 * Project `p`, board order = the hub's (`order` ASC): the array order below. `todo` holds
 * visible roots a, b, c, a subtask `a1` of a, an archived `z` and a task of another
 * project `x` (same status) — rows the board hides that the hub's order still counts.
 */
const board = () =>
  boardOf({
    tasks: [
      taskOf('a', { status: 'todo', order: 0 }),
      taskOf('a1', { status: 'todo', order: 1, parent_id: 'a' }),
      taskOf('x', { status: 'todo', order: 1, project_id: 'other' }),
      taskOf('b', { status: 'todo', order: 2 }),
      taskOf('z', { status: 'todo', order: 3, archived_at: '2026-10-01' }),
      taskOf('c', { status: 'todo', order: 4 }),
      taskOf('d', { status: 'in_progress', order: 0 }),
      taskOf('e', { status: 'in_progress', order: 1 })
    ]
  })

describe('planDrop', () => {
  it('reorders within a column: the full ordered list of the project status, hidden rows kept in place', () => {
    // Drag c above b.
    const plan = planDrop(board(), 'p', {
      taskId: 'c',
      fromColumn: 'todo',
      toColumn: 'todo',
      beforeTaskId: 'b'
    })
    expect(plan).toEqual({
      taskId: 'c',
      update: null,
      reorder: ['a', 'a1', 'c', 'b', 'z'],
      clearBlockers: false
    })
  })

  it('moves to another column before the row it was dropped on', () => {
    const plan = planDrop(board(), 'p', {
      taskId: 'b',
      fromColumn: 'todo',
      toColumn: 'in_progress',
      beforeTaskId: 'e'
    })
    expect(plan).toEqual({
      taskId: 'b',
      update: { id: 'b', status: 'in_progress' },
      reorder: ['d', 'b', 'e'],
      clearBlockers: false
    })
  })

  it('drops at the end of a column after its last VISIBLE row, not after hidden ones', () => {
    // in todo, visible = a, b, c; the archived z sits before c in board order.
    const plan = planDrop(
      board(),
      'p',
      { taskId: 'd', fromColumn: 'in_progress', toColumn: 'todo', beforeTaskId: null },
      ['a', 'b']
    )
    // Visible column ends at b → d goes right after b (z, c are not shown in this view).
    expect(plan?.reorder).toEqual(['a', 'a1', 'b', 'd', 'z', 'c'])
    expect(plan?.update).toEqual({ id: 'd', status: 'todo' })
  })

  it('drops at the end of an empty column', () => {
    const plan = planDrop(
      board(),
      'p',
      { taskId: 'a', fromColumn: 'todo', toColumn: 'done', beforeTaskId: null },
      []
    )
    expect(plan?.reorder).toEqual(['a'])
    expect(plan?.update).toEqual({ id: 'a', status: 'done' })
  })

  it('returns null for a drop that changes nothing', () => {
    expect(
      planDrop(board(), 'p', {
        taskId: 'b',
        fromColumn: 'todo',
        toColumn: 'todo',
        beforeTaskId: 'z'
      })
    ).toBeNull()
    expect(
      planDrop(board(), 'p', {
        taskId: 'a',
        fromColumn: 'todo',
        toColumn: 'todo',
        beforeTaskId: 'a'
      })
    ).toBeNull()
  })

  it('blocks on a drop into the Blocked column, unblocks (and clears blockers) out of it', () => {
    expect(
      planDrop(board(), 'p', {
        taskId: 'a',
        fromColumn: 'todo',
        toColumn: '__blocked__',
        beforeTaskId: null
      })
    ).toEqual({
      taskId: 'a',
      update: { id: 'a', isBlocked: true },
      reorder: null,
      clearBlockers: false
    })

    const out = planDrop(board(), 'p', {
      taskId: 'a',
      fromColumn: '__blocked__',
      toColumn: 'in_progress',
      beforeTaskId: null
    })
    expect(out).toEqual({
      taskId: 'a',
      update: { id: 'a', status: 'in_progress', isBlocked: false, blockedComment: null },
      reorder: ['d', 'e', 'a'],
      clearBlockers: true
    })
  })

  it('ignores drops into other virtual columns', () => {
    expect(
      planDrop(board(), 'p', {
        taskId: 'a',
        fromColumn: 'todo',
        toColumn: '__unknown__',
        beforeTaskId: null
      })
    ).toBeNull()
  })
})

describe('planDrop under Display options (desktop KanbanBoard / KanbanListView / moveTask)', () => {
  /** Board order = array order. Priorities: a 1, b 3, c 3, d 1, e 2; f (other project) 3. */
  const ranked = () =>
    boardOf({
      tasks: [
        taskOf('a', { status: 'todo', order: 0, priority: 1 }),
        taskOf('b', { status: 'todo', order: 1, priority: 3 }),
        taskOf('f', { status: 'todo', order: 1, priority: 3, project_id: 'other' }),
        taskOf('c', { status: 'todo', order: 2, priority: 3 }),
        taskOf('d', { status: 'in_progress', order: 0, priority: 1 }),
        taskOf('e', { status: 'in_progress', order: 1, priority: 2 })
      ]
    })
  const drop = (
    taskId: string,
    fromColumn: string,
    toColumn: string,
    beforeTaskId: string | null
  ) => ({
    taskId,
    fromColumn,
    toColumn,
    beforeTaskId
  })

  it('due-date groups: no drag at all (desktop disables it)', () => {
    expect(dragAllowed('due_date')).toBe(false)
    expect(dragAllowed('status')).toBe(true)
    expect(dragAllowed('priority')).toBe(true)
    expect(
      planDrop(ranked(), 'p', drop('a', 'overdue', 'today', null), [], {
        groupBy: 'due_date',
        sortBy: 'manual'
      })
    ).toBeNull()
  })

  it('reorders in a column only with manual or priority sort', () => {
    expect(reorderAllowed('manual')).toBe(true)
    expect(reorderAllowed('priority')).toBe(true)
    expect(reorderAllowed('title')).toBe(false)
    for (const sortBy of ['title', 'due_date', 'created'] as const) {
      expect(
        planDrop(ranked(), 'p', drop('c', 'todo', 'todo', 'b'), undefined, {
          groupBy: 'status',
          sortBy
        })
      ).toBeNull()
    }
  })

  it('priority sort: reorders only onto a task of the same priority', () => {
    const grouping = { groupBy: 'status', sortBy: 'priority' } as const
    expect(planDrop(ranked(), 'p', drop('c', 'todo', 'todo', 'b'), undefined, grouping)).toEqual({
      taskId: 'c',
      update: null,
      reorder: ['a', 'c', 'b'],
      clearBlockers: false
    })
    expect(planDrop(ranked(), 'p', drop('c', 'todo', 'todo', 'a'), undefined, grouping)).toBeNull()
    expect(planDrop(ranked(), 'p', drop('a', 'todo', 'todo', null), undefined, grouping)).toBeNull()
  })

  it('any sort: a move to another status column still changes the status', () => {
    const plan = planDrop(ranked(), 'p', drop('b', 'todo', 'in_progress', 'e'), undefined, {
      groupBy: 'status',
      sortBy: 'title'
    })
    expect(plan?.update).toEqual({ id: 'b', status: 'in_progress' })
    expect(plan?.reorder).toEqual(['d', 'b', 'e'])
  })

  it('priority groups: a move to another group sets the priority; the order is that priority', () => {
    const grouping = { groupBy: 'priority', sortBy: 'manual' } as const
    expect(planDrop(ranked(), 'p', drop('b', 'p3', 'p1', 'd'), ['a', 'd'], grouping)).toEqual({
      taskId: 'b',
      update: { id: 'b', priority: 1 },
      reorder: ['a', 'b', 'd'],
      clearBlockers: false
    })
    // Within a priority group: reorder the project's tasks of that priority.
    expect(planDrop(ranked(), 'p', drop('c', 'p3', 'p3', 'b'), ['b', 'c'], grouping)).toEqual({
      taskId: 'c',
      update: null,
      reorder: ['c', 'b'],
      clearBlockers: false
    })
  })

  it('No groups reorders the whole project; Activity reorders within its group, no move between', () => {
    expect(
      planDrop(ranked(), 'p', drop('e', 'all', 'all', 'a'), undefined, {
        groupBy: 'none',
        sortBy: 'manual'
      })?.reorder
    ).toEqual(['e', 'a', 'b', 'c', 'd'])
    const activity = {
      groupBy: 'active',
      sortBy: 'manual',
      activeTaskIds: new Set(['b', 'd'])
    } as const
    expect(
      planDrop(ranked(), 'p', drop('d', 'active', 'active', 'b'), undefined, activity)?.reorder
    ).toEqual(['d', 'b'])
    expect(
      planDrop(ranked(), 'p', drop('a', 'inactive', 'active', null), undefined, activity)
    ).toBeNull()
  })

  it('applies a priority change to the board', () => {
    const data = ranked()
    const plan = planDrop(data, 'p', drop('b', 'p3', 'p1', null), ['a', 'd'], {
      groupBy: 'priority',
      sortBy: 'manual'
    })
    expect(applyMovePlan(data, plan!).tasks.find((t) => t.id === 'b')?.priority).toBe(1)
  })
})

describe('planStatusChange', () => {
  it('changes the status only (desktop status change keeps the order)', () => {
    expect(planStatusChange('a', 'done')).toEqual({
      taskId: 'a',
      update: { id: 'a', status: 'done' },
      reorder: null,
      clearBlockers: false
    })
  })
})

describe('applyMovePlan', () => {
  it('patches status, order and the board order like the hub will', () => {
    const data = board()
    const plan = planDrop(data, 'p', {
      taskId: 'b',
      fromColumn: 'todo',
      toColumn: 'in_progress',
      beforeTaskId: 'e'
    })
    const next = applyMovePlan(data, plan!)
    const inProgress = next.tasks.filter((t) => t.status === 'in_progress' && t.project_id === 'p')
    expect(inProgress.map((t) => [t.id, t.order])).toEqual([
      ['d', 0],
      ['b', 1],
      ['e', 2]
    ])
    // The input is untouched (the snapshot a failed write restores).
    expect(data.tasks.find((t) => t.id === 'b')?.status).toBe('todo')
  })

  it('patches the blocked flag and the blocked id set', () => {
    const data = board()
    const blocked = applyMovePlan(
      data,
      planDrop(data, 'p', {
        taskId: 'a',
        fromColumn: 'todo',
        toColumn: '__blocked__',
        beforeTaskId: null
      })!
    )
    expect(blocked.blockedTaskIds).toContain('a')
    const back = applyMovePlan(
      blocked,
      planDrop(blocked, 'p', {
        taskId: 'a',
        fromColumn: '__blocked__',
        toColumn: 'todo',
        beforeTaskId: null
      })!
    )
    expect(back.blockedTaskIds).not.toContain('a')
    expect(back.tasks.find((t) => t.id === 'a')?.is_blocked).toBe(false)
  })
})
