import { describe, expect, test } from 'vitest'
import type { Task } from '@slayzone/task-contracts'
import { DEFAULT_COLUMNS } from '@slayzone/projects-contracts'
import { groupTreeRows, type GroupOpts } from './treeGrouping'

const task = (id: string, status = 'todo', extra: Partial<Task> = {}): Task =>
  ({ id, status, priority: 3, ...extra }) as Task
const options = (extra: Partial<GroupOpts> = {}): GroupOpts => ({
  showEmpty: false,
  statusFilter: new Set(),
  groupPinned: true,
  groupTemporary: true,
  pinnedIds: new Set(),
  groupBlocked: true,
  blockedIds: new Set(),
  ...extra
})

describe('tree groups', () => {
  test('default statuses follow workflow order regardless of task arrival order', () => {
    const columns = [...DEFAULT_COLUMNS].sort((a, b) => a.position - b.position)
    const roots = [...columns].reverse().map((c) => task(c.id, c.id))
    expect(groupTreeRows(roots, 'status', null, options()).map((g) => g.key)).toEqual(
      columns.map((c) => c.id)
    )
  })

  test('custom column positions apply with empty groups hidden or shown', () => {
    const cols = DEFAULT_COLUMNS.slice(0, 3).map((c, i) => ({ ...c, position: 2 - i }))
    const roots = cols.map((c) => task(c.id, c.id))
    for (const showEmpty of [false, true]) {
      expect(
        groupTreeRows(roots, 'status', cols, options({ showEmpty })).map((g) => g.key)
      ).toEqual([...cols].reverse().map((c) => c.id))
    }
  })

  test.each(['status', 'priority', 'none'] as const)('blocked group supports %s grouping', (by) => {
    const roots = [
      task('normal'),
      task('flagged', 'todo', { is_blocked: true }),
      task('dependency')
    ]
    const groups = groupTreeRows(roots, by, null, options({ blockedIds: new Set(['dependency']) }))
    const blocked = groups.find((g) => g.key === '__blocked__')
    expect(blocked?.isBlocked).toBe(true)
    expect(blocked?.tasks.map((t) => t.id)).toEqual(['flagged', 'dependency'])
    expect(
      groups
        .flatMap((g) => g.tasks)
        .map((t) => t.id)
        .sort()
    ).toEqual(['dependency', 'flagged', 'normal'])
  })

  test('pinned and temporary take precedence; blocked grouping can be disabled', () => {
    const roots = [
      task('pinned', 'todo', { is_blocked: true }),
      task('temp', 'todo', { is_temporary: true, is_blocked: true }),
      task('blocked', 'todo', { is_blocked: true })
    ]
    const opts = options({ pinnedIds: new Set(['pinned']) })
    expect(groupTreeRows(roots, 'status', null, opts).map((g) => g.key)).toEqual([
      '__pinned__',
      '__blocked__',
      '__temporary__'
    ])
    expect(
      groupTreeRows(roots, 'status', null, { ...opts, groupBlocked: false }).map((g) => g.key)
    ).toEqual(['__pinned__', 'todo', '__temporary__'])
  })
})
