import { describe, expect, it } from 'vitest'
import type { Task } from '@slayzone/task-contracts'
import {
  mergeRow,
  parentIdsOf,
  patchBoardRows,
  patchMirrorBlocked,
  patchMirrorTaskTags,
  patchMirrorTasks,
  type BoardData
} from './board-patch'

const t = (id: string, extra: Partial<Task> = {}): Task =>
  ({
    id,
    title: id,
    status: 'todo',
    order: 0,
    created_at: '2026-01-01 00:00:00',
    parent_id: null,
    ...extra
  }) as Task

const board = (tasks: Task[], extra: Partial<BoardData> = {}): BoardData => ({
  tasks,
  projects: [],
  tags: [],
  taskTags: {},
  blockedTaskIds: [],
  ...extra
})

describe('patchBoardRows', () => {
  it('replaces changed rows in place and keeps every other row identical', () => {
    const a = t('a')
    const b = t('b', { order: 1 })
    const c = t('c', { order: 2 })
    const prev = board([a, b, c])
    const b2 = t('b', { order: 1, status: 'in_progress' })
    const next = patchBoardRows(prev, ['b'], { tasks: [b2], taskTags: {}, blockedTaskIds: [] })
    expect(next).not.toBeNull()
    expect(next!.tasks).toEqual([a, b2, c])
    expect(next!.tasks[0]).toBe(a)
    expect(next!.tasks[2]).toBe(c)
    expect(next!.projects).toBe(prev.projects)
    expect(next!.tags).toBe(prev.tags)
  })

  it('drops a requested row that no longer exists (deleted)', () => {
    const prev = board([t('a'), t('b')], { taskTags: { b: ['x'] }, blockedTaskIds: ['b'] })
    const next = patchBoardRows(prev, ['b'], { tasks: [], taskTags: {}, blockedTaskIds: [] })
    expect(next!.tasks.map((x) => x.id)).toEqual(['a'])
    expect(next!.taskTags).toEqual({})
    expect(next!.blockedTaskIds).toEqual([])
  })

  it('updates tags and blocked membership of the requested rows only', () => {
    const prev = board([t('a'), t('b')], {
      taskTags: { a: ['x'], b: ['y'] },
      blockedTaskIds: ['a']
    })
    const next = patchBoardRows(prev, ['b'], {
      tasks: [t('b')],
      taskTags: { b: ['y', 'z'] },
      blockedTaskIds: ['b']
    })
    expect(next!.taskTags).toEqual({ a: ['x'], b: ['y', 'z'] })
    expect([...next!.blockedTaskIds].sort()).toEqual(['a', 'b'])
  })

  it('refuses (null → full reload) when a row is new and the server gave no position', () => {
    const prev = board([t('a')])
    expect(
      patchBoardRows(prev, ['n'], { tasks: [t('n')], taskTags: {}, blockedTaskIds: [] })
    ).toBeNull()
  })

  it('refuses when a row would move and the server gave no position', () => {
    const prev = board([t('a'), t('b', { order: 1 })])
    expect(
      patchBoardRows(prev, ['b'], {
        tasks: [t('b', { order: 5 })],
        taskTags: {},
        blockedTaskIds: []
      })
    ).toBeNull()
    expect(
      patchBoardRows(prev, ['b'], {
        tasks: [t('b', { order: 1, created_at: '2027-01-01 00:00:00' })],
        taskTags: {},
        blockedTaskIds: []
      })
    ).toBeNull()
  })

  it('inserts a new row before its server-given successor, others keep identity', () => {
    const a = t('a')
    const b = t('b', { order: 1 })
    const prev = board([a, b])
    const n = t('n', { order: 1 })
    const next = patchBoardRows(prev, ['n'], {
      tasks: [n],
      taskTags: { n: ['x'] },
      blockedTaskIds: [],
      nextTaskIds: { n: 'b' }
    })
    expect(next!.tasks.map((x) => x.id)).toEqual(['a', 'n', 'b'])
    expect(next!.tasks[0]).toBe(a)
    expect(next!.tasks[2]).toBe(b)
    expect(next!.taskTags).toEqual({ n: ['x'] })
  })

  it('appends a new row whose successor is null (last on the board)', () => {
    const prev = board([t('a')])
    const next = patchBoardRows(prev, ['n'], {
      tasks: [t('n', { order: 9 })],
      taskTags: {},
      blockedTaskIds: [],
      nextTaskIds: { n: null }
    })
    expect(next!.tasks.map((x) => x.id)).toEqual(['a', 'n'])
  })

  it('moves a row to its server-given successor', () => {
    const prev = board([t('a'), t('b', { order: 1 }), t('c', { order: 2 })])
    const next = patchBoardRows(prev, ['a'], {
      tasks: [t('a', { order: 3 })],
      taskTags: {},
      blockedTaskIds: [],
      nextTaskIds: { a: null }
    })
    expect(next!.tasks.map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })

  it('chains several placed rows whose successor is another placed row', () => {
    const prev = board([t('a'), t('z', { order: 9 })])
    const next = patchBoardRows(prev, ['m', 'n'], {
      tasks: [t('m', { order: 1 }), t('n', { order: 2 })],
      taskTags: {},
      blockedTaskIds: [],
      nextTaskIds: { m: 'n', n: 'z' }
    })
    expect(next!.tasks.map((x) => x.id)).toEqual(['a', 'm', 'n', 'z'])
  })

  it('refuses when the successor is not on this board (board out of date)', () => {
    const prev = board([t('a')])
    expect(
      patchBoardRows(prev, ['n'], {
        tasks: [t('n')],
        taskTags: {},
        blockedTaskIds: [],
        nextTaskIds: { n: 'unknown' }
      })
    ).toBeNull()
  })
})

describe('parentIdsOf', () => {
  it('collects old and new parents of the changed rows (reparent touches both lists)', () => {
    const before = [t('a', { parent_id: 'p1' }), t('b', { parent_id: 'p9' })]
    const after = [t('a', { parent_id: 'p2' })]
    expect(parentIdsOf(['a'], before, after).sort()).toEqual(['p1', 'p2'])
  })
})

describe('patchMirrorTasks (three-way: keep pending optimistic edits)', () => {
  it('adds a row the mirror does not hold yet, at its board position', () => {
    const a = t('a')
    const b = t('b', { order: 1 })
    const prev = board([a, b])
    const n = t('n', { order: 1 })
    const next = patchBoardRows(prev, ['n'], {
      tasks: [n],
      taskTags: {},
      blockedTaskIds: [],
      nextTaskIds: { n: 'b' }
    })!
    const out = patchMirrorTasks([a, b], ['n'], prev, next)
    expect(out.map((x) => x.id)).toEqual(['a', 'n', 'b'])
    expect(out[1]).toBe(n)
  })

  it('an optimistically added row is merged in place, not duplicated', () => {
    const a = t('a')
    const prev = board([a])
    const n = t('n', { order: 1 })
    const next = patchBoardRows(prev, ['n'], {
      tasks: [n],
      taskTags: {},
      blockedTaskIds: [],
      nextTaskIds: { n: null }
    })!
    const optimistic = { ...n } as Task
    const out = patchMirrorTasks([optimistic, a], ['n'], prev, next)
    expect(out.map((x) => x.id)).toEqual(['n', 'a'])
    expect(out[0]).toBe(n)
  })

  it('a remote move of a row without local edits follows the board', () => {
    const a = t('a')
    const b = t('b', { order: 1 })
    const prev = board([a, b])
    const next = patchBoardRows(prev, ['a'], {
      tasks: [t('a', { order: 2 })],
      taskTags: {},
      blockedTaskIds: [],
      nextTaskIds: { a: null }
    })!
    expect(patchMirrorTasks([a, b], ['a'], prev, next).map((x) => x.id)).toEqual(['b', 'a'])
  })

  it('a drag across columns: the status patch lands without undoing the optimistic order', () => {
    // Board (server) before: b in todo at order 1. The drag optimistically moved b to
    // in_progress at order 0 and wrote status + order as two mutations. The status
    // write's event arrives first; the order write has not landed yet.
    const a = t('a', { order: 0 })
    const b = t('b', { order: 1 })
    const prev = board([a, b])
    const mirror = [a, { ...b, status: 'in_progress', order: 0 } as Task]
    const next = patchBoardRows(prev, ['b'], {
      tasks: [t('b', { order: 1, status: 'in_progress', updated_at: 'later' } as Partial<Task>)],
      taskTags: {},
      blockedTaskIds: []
    })!
    const out = patchMirrorTasks(mirror, ['b'], prev, next)
    expect(out[1]).toMatchObject({ status: 'in_progress', order: 0, updated_at: 'later' })
    expect(out[0]).toBe(a)
  })

  it('a row without a local edit takes the server row as is (identity kept)', () => {
    const b = t('b')
    const prev = board([b])
    const b2 = t('b', { status: 'done' })
    const next = patchBoardRows(prev, ['b'], { tasks: [b2], taskTags: {}, blockedTaskIds: [] })!
    expect(patchMirrorTasks([b], ['b'], prev, next)[0]).toBe(b2)
  })

  it('removes a row the server deleted', () => {
    const prev = board([t('a'), t('b')])
    const next = patchBoardRows(prev, ['b'], { tasks: [], taskTags: {}, blockedTaskIds: [] })!
    expect(patchMirrorTasks(prev.tasks, ['b'], prev, next).map((x) => x.id)).toEqual(['a'])
  })

  it('compares JSON fields by value, not identity (each fetch re-parses them)', () => {
    const base = t('b', { panel_visibility: { terminal: true } } as Partial<Task>)
    const local = { ...base, title: 'local edit' } as Task
    const remote = t('b', { panel_visibility: { terminal: true } } as Partial<Task>)
    expect(mergeRow(base, local, remote)).toMatchObject({ title: 'local edit' })
  })

  it('tags and blocked take the server value only where the server changed it', () => {
    const prev = board([t('a'), t('b')], { taskTags: { a: ['x'] }, blockedTaskIds: [] })
    const next = { ...prev, taskTags: { a: ['x'], b: ['y'] }, blockedTaskIds: ['b'] }
    const tags = patchMirrorTaskTags(new Map([['a', ['local']]]), ['a', 'b'], prev, next)
    expect(tags.get('a')).toEqual(['local']) // server unchanged → local kept
    expect(tags.get('b')).toEqual(['y'])
    const blocked = patchMirrorBlocked(new Set(['a']), ['a', 'b'], prev, next)
    expect([...blocked].sort()).toEqual(['a', 'b'])
  })
})
