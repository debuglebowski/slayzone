import { boardOf, taskOf } from '../hubs/testing'
import { applyMovePlan, planDrop, planStatusChange } from './moves'

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
