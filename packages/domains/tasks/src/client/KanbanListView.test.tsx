// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Task } from '@slayzone/task-contracts'
import type { Column } from './kanban'
import type { ViewConfig } from './FilterState'

// Stable across renders: the grouping memo must not be invalidated by mocks.
const activeTaskIds = new Set<string>()
vi.mock('@slayzone/terminal', () => ({ useActiveTaskIds: () => activeTaskIds }))
vi.mock('@slayzone/dialogs', () => ({ useDialogStore: { getState: () => ({}) } }))
// Each group renders as a labelled list of its task titles.
vi.mock('./KanbanGroupSection', () => ({
  GroupSection: ({ column }: { column: Column }) => (
    <section data-testid={`group:${column.id}`}>
      {column.tasks.map((t) => t.title).join(',')}
    </section>
  )
}))

const { KanbanListView } = await import('./KanbanListView')

const task = (id: string): Task =>
  ({ id, title: id, status: 'in_progress', priority: 3, order: 0, snoozed_until: null }) as Task

const viewConfig = (over: Partial<ViewConfig> = {}): ViewConfig => ({
  groupBy: 'status',
  sortBy: 'manual',
  showEmptyColumns: true,
  completedFilter: 'all',
  showArchived: false,
  showSubTasks: true,
  showBlockedColumn: true,
  blockedColumnAfter: null,
  showSnoozedColumn: false,
  snoozedColumnAfter: null,
  ...over
})

// Same `tasks` array on every render: only the prop under test changes.
const tasks = [task('a'), task('b')]
const props = { tasks, onTaskMove: vi.fn(), onTaskReorder: vi.fn() }

const blockedGroup = () => screen.queryByTestId('group:__blocked__')?.textContent ?? null

afterEach(cleanup)

describe('KanbanListView grouping', () => {
  it('puts blocked tasks in the Blocked group', () => {
    render(<KanbanListView {...props} viewConfig={viewConfig()} blockedTaskIds={new Set(['a'])} />)
    expect(blockedGroup()).toBe('a')
  })

  it('regroups when blockedTaskIds changes and tasks do not', () => {
    const vc = viewConfig()
    const { rerender } = render(
      <KanbanListView {...props} viewConfig={vc} blockedTaskIds={new Set()} />
    )
    expect(blockedGroup()).toBe('')
    rerender(<KanbanListView {...props} viewConfig={vc} blockedTaskIds={new Set(['b'])} />)
    expect(blockedGroup()).toBe('b')
  })

  it('regroups when the Blocked group is toggled on and tasks do not change', () => {
    const blocked = new Set(['a'])
    const { rerender } = render(
      <KanbanListView
        {...props}
        viewConfig={viewConfig({ showBlockedColumn: false })}
        blockedTaskIds={blocked}
      />
    )
    expect(blockedGroup()).toBeNull()
    rerender(<KanbanListView {...props} viewConfig={viewConfig()} blockedTaskIds={blocked} />)
    expect(blockedGroup()).toBe('a')
  })
})
