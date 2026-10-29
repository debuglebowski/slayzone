// @vitest-environment jsdom
import React, { Activity } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Task } from '@slayzone/task-contracts'

// Stand-in prop shapes: only what the sidebar tree actually passes to each
// primitive, so a changed call site fails here instead of silently drifting.
type MockChildren = { children?: React.ReactNode }
type MockVariantButtonProps = React.ComponentProps<'button'> & {
  variant?: string
  size?: string
}
type MockSplitButtonProps = MockChildren & {
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  /** Renders the dropdown items; the arg closes the menu, which this stub no-ops. */
  menu: (close: () => void) => React.ReactNode
}

vi.mock('@slayzone/ui', async (importOriginal) => {
  const { useDepsChanged } = await importOriginal<typeof import('@slayzone/ui')>()
  const Passthrough = ({ children }: MockChildren) => <>{children}</>
  const Button = ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: MockVariantButtonProps) => <button {...props}>{children}</button>
  const Input = (props: React.ComponentProps<'input'>) => <input {...props} />

  const SplitButton = ({ children, onClick, menu }: MockSplitButtonProps) => (
    <div>
      <button onClick={onClick}>{children}</button>
      {menu(() => {
        // Menu stays open for the whole test — nothing to close.
      })}
    </div>
  )
  const SplitButtonItem = ({
    children,
    onClick
  }: MockChildren & { onClick?: React.MouseEventHandler<HTMLButtonElement> }) => (
    <button onClick={onClick}>{children}</button>
  )
  const Textarea = (props: React.ComponentProps<'textarea'>) => <textarea {...props} />

  return {
    Select: Passthrough,
    SelectContent: Passthrough,
    SelectItem: ({ children }: MockChildren) => <div>{children}</div>,
    SelectTrigger: ({ children }: MockChildren) => <div>{children}</div>,
    SelectValue: () => null,
    Popover: Passthrough,
    PopoverContent: ({ children }: MockChildren) => <div>{children}</div>,
    PopoverTrigger: ({ children }: MockChildren) => <>{children}</>,
    // Honors `open` like Radix: a closed dialog's content is not mounted.
    Dialog: ({ open, children }: MockChildren & { open?: boolean }) =>
      open ? <>{children}</> : null,
    DialogContent: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: ({ children }: MockChildren) => <div>{children}</div>,
    Calendar: () => null,
    Button,
    Input,
    Textarea,
    SplitButton,
    SplitButtonItem,
    Tooltip: Passthrough,
    TooltipTrigger: ({ children }: MockChildren) => <>{children}</>,
    TooltipContent: ({ children }: MockChildren) => <div>{children}</div>,
    ProgressRing: () => null,
    Slider: () => null,
    buildStatusOptions: () => [],
    taskStatusOptions: [],
    cn: (...args: Array<string | false | null | undefined>) => args.filter(Boolean).join(' '),
    getColumnStatusStyle: (
      status: string | undefined,
      columns?: Array<{ id: string; label: string }>
    ) => {
      if (!status) return null
      const column = columns?.find((item) => item.id === status)
      const label = column?.label ?? status
      return {
        bg: '',
        text: '',
        label,
        iconClass: `icon-${label}`,
        icon: ({ className, ...props }: React.ComponentProps<'svg'>) => (
          <svg data-testid={`status-icon-${label}`} className={className} {...props} />
        )
      }
    },
    PriorityIcon: () => null,
    toast: { success: vi.fn(), error: vi.fn() },
    useDepsChanged
  }
})

vi.mock('@slayzone/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('@slayzone/tags/client', () => ({ TagSelector: () => null }))
vi.mock('@slayzone/projects', () => ({ ProjectSelect: () => null }))
vi.mock('./SnoozePicker', () => ({ SnoozePicker: () => null }))
vi.mock('@slayzone/projects-contracts', () => ({
  isTerminalStatus: (status: string, columns?: Array<{ id: string; category?: string }>) => {
    const column = columns?.find((item) => item.id === status)
    return column?.category === 'completed' || status === 'done'
  },
  isCompletedStatus: (status: string, columns?: Array<{ id: string; category?: string }>) => {
    const column = columns?.find((item) => item.id === status)
    return column?.category === 'completed' || status === 'done'
  }
}))

// Deliberately partial: the sidebar only reads the columns spelled out below,
// so the fixture asserts to `Task` rather than restating every DB column (and
// drifting the moment one is added).
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project_id: 'project-1',
    parent_id: null,
    title: 'Current task',
    description: null,
    description_format: 'markdown',
    assignee: null,
    status: 'todo',
    priority: 3,
    order: 0,
    due_date: null,
    archived_at: null,
    terminal_mode: 'terminal',
    provider_config: {},
    terminal_shell: null,
    claude_conversation_id: null,
    codex_conversation_id: null,
    cursor_conversation_id: null,
    gemini_conversation_id: null,
    opencode_conversation_id: null,
    claude_flags: '',
    codex_flags: '',
    cursor_flags: '',
    gemini_flags: '',
    opencode_flags: '',
    dangerously_skip_permissions: false,
    panel_visibility: null,
    worktree_path: null,
    worktree_parent_branch: null,
    base_dir: null,
    browser_url: null,
    browser_tabs: null,
    web_panel_urls: null,
    editor_open_files: null,
    merge_state: null,
    merge_context: null,
    loop_config: null,
    snoozed_until: null,
    is_temporary: false,
    is_blocked: false,
    blocked_comment: null,
    pr_url: null,
    repo_name: null,
    linear_url: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  } as Task
}

const projects = [
  {
    id: 'project-1',
    name: 'Core',
    color: '#111111',
    columns_config: [
      { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
      { id: 'doing', label: 'Doing', color: 'yellow', position: 1, category: 'started' },
      { id: 'done', label: 'Done', color: 'green', position: 2, category: 'completed' }
    ]
  },
  {
    id: 'project-2',
    name: 'Infra',
    color: '#222222',
    columns_config: [
      { id: 'triage', label: 'Triage', color: 'gray', position: 0, category: 'triage' },
      { id: 'waiting', label: 'Waiting', color: 'orange', position: 1, category: 'started' }
    ]
  }
]

const blockerTask = makeTask({
  id: 'blocker-1',
  title: 'Fix API',
  status: 'doing',
  project_id: 'project-1'
})
const extraBlockerTask = makeTask({
  id: 'blocker-2',
  title: 'Refactor auth',
  status: 'triage',
  project_id: 'project-2'
})
const availableTask = makeTask({
  id: 'candidate-1',
  title: 'Ship docs',
  status: 'waiting',
  project_id: 'project-2'
})
const doneTask = makeTask({
  id: 'candidate-2',
  title: 'Already done',
  status: 'done',
  project_id: 'project-1'
})

// All tasks (old `window.api.db.getTasks`) and current blockers (old
// `window.api.taskDependencies.getBlockers`) now flow through useTRPC + react-query
// `useQuery`. Stable refs so the data-mirror effect doesn't loop.
const allTasksList = [blockerTask, extraBlockerTask, availableTask, doneTask]
const blockersList = [blockerTask, extraBlockerTask]

const boardReads = vi.fn()
// Current getBlockers payload. Replaced (new identity) only when a test simulates a
// refetch that returned new data; otherwise every read returns the same list.
let blockersData: Task[] = blockersList
const queryData: Record<string, () => unknown> = {
  'task.loadBoardData': () => {
    boardReads()
    return { tasks: allTasksList }
  },
  'task.getBlockers': () => blockersData,
  'projects.list': () => projects,
  // No computers enrolled in the sidebar tests → ComputerCard shows its minimal
  // "runs locally" state (no Select), keeping the other assertions untouched.
  'computers.list': () => [],
  'computers.resolveTaskComputer': () => ({ computerId: null })
}

// Mutations live in the real child cards (BlockedBySection / ProjectStatusCard /
// …) via `useMutation(trpc.X.mutationOptions())`. Route each mutation key to its
// own spy so the old `window.api.*` call assertions map 1:1.
const mutationMocks: Record<string, ReturnType<typeof vi.fn>> = {
  'task.update': vi.fn(),
  'task.addBlocker': vi.fn(),
  'task.removeBlocker': vi.fn(),
  'tags.setForTask': vi.fn(),
  'computers.setTaskComputer': vi.fn()
}

// The domain's typed view (`./trpc`) re-exports the runtime; point it at this mock.
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    task: {
      // The blocker picker's task list comes from the app's board query.
      loadBoardData: {
        queryOptions: (_input: undefined, opts?: Record<string, unknown>) => ({
          ...opts,
          queryKey: ['task.loadBoardData'],
          queryFn: queryData['task.loadBoardData']
        })
      },
      getBlockers: {
        queryOptions: (input: { taskId: string }) => ({
          queryKey: ['task.getBlockers', input],
          queryFn: queryData['task.getBlockers']
        })
      },
      update: { mutationOptions: () => ({ __mutationKey: 'task.update' }) },
      addBlocker: { mutationOptions: () => ({ __mutationKey: 'task.addBlocker' }) },
      removeBlocker: { mutationOptions: () => ({ __mutationKey: 'task.removeBlocker' }) }
    },
    projects: {
      list: {
        queryOptions: () => ({ queryKey: ['projects.list'], queryFn: queryData['projects.list'] })
      }
    },
    computers: {
      list: {
        queryOptions: () => ({ queryKey: ['computers.list'], queryFn: queryData['computers.list'] })
      },
      resolveTaskComputer: {
        queryOptions: (input: { taskId: string }) => ({
          queryKey: ['computers.resolveTaskComputer', input],
          queryFn: queryData['computers.resolveTaskComputer']
        })
      },
      setTaskComputer: { mutationOptions: () => ({ __mutationKey: 'computers.setTaskComputer' }) }
    },
    tags: {
      setForTask: { mutationOptions: () => ({ __mutationKey: 'tags.setForTask' }) }
    }
  }),
  useSubscription: () => undefined
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryFn: () => unknown; select?: (d: never) => unknown }) => ({
    data: opts.select ? opts.select(opts.queryFn() as never) : opts.queryFn(),
    isLoading: false,
    isPending: false,
    error: null,
    refetch: vi.fn()
  }),
  useMutation: (opts: { __mutationKey: string }) => ({
    mutateAsync: mutationMocks[opts.__mutationKey],
    mutate: mutationMocks[opts.__mutationKey],
    isPending: false,
    reset: vi.fn()
  })
}))

import { TaskMetadataSidebar } from './TaskMetadataSidebar'

afterEach(() => cleanup())

// jsdom ships no ResizeObserver. The sidebar only constructs/observes/disconnects
// one — it never reacts to a callback — so an inert stub is enough.
globalThis.ResizeObserver = class {
  observe() {
    // Never fires: no layout engine in jsdom to report a resize from.
  }
  unobserve() {
    // Nothing was observed.
  }
  disconnect() {
    // Nothing was observed.
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  blockersData = blockersList
  mutationMocks['task.update'].mockResolvedValue(makeTask())
  mutationMocks['task.addBlocker'].mockResolvedValue(undefined)
  mutationMocks['task.removeBlocker'].mockResolvedValue(undefined)
  mutationMocks['tags.setForTask'].mockResolvedValue(undefined)
})

function renderSidebar(taskOverrides?: Partial<Task>) {
  return render(
    <TaskMetadataSidebar
      task={makeTask(taskOverrides)}
      tags={[]}
      taskTagIds={[]}
      onUpdate={vi.fn()}
      onTagsChange={vi.fn()}
    />
  )
}

function openBlockerPicker(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Set blocking task' }))
}

describe('TaskMetadataSidebar', () => {
  it('reads the whole board only once the blocker picker is opened', async () => {
    renderSidebar()
    await screen.findByText('Fix API')
    expect(boardReads).not.toHaveBeenCalled()
    openBlockerPicker()
    await screen.findByLabelText('Search available blockers')
    expect(boardReads).toHaveBeenCalled()
  })

  it('renders status icons using project-specific status config for blocker rows and available blockers', async () => {
    renderSidebar()

    await screen.findByText('Fix API')
    openBlockerPicker()
    await screen.findByLabelText('Search available blockers')

    expect(screen.queryByLabelText('Search blockers')).toBeNull()
    expect(screen.getByTitle('Doing')).toBeDefined()
    expect(screen.getByTitle('Triage')).toBeDefined()
    expect(screen.getByTitle('Waiting')).toBeDefined()
    expect(screen.queryByText('Already done')).toBeNull()
  })

  it('filters the add-blocker list independently and adds the selected blocker', async () => {
    renderSidebar()

    await screen.findByText('Fix API')
    openBlockerPicker()
    const addSearch = await screen.findByLabelText('Search available blockers')
    const addBlockerSection = addSearch.parentElement?.parentElement as HTMLElement
    fireEvent.change(addSearch, { target: { value: 'ship' } })

    expect(within(addBlockerSection).getByText('Ship docs')).toBeDefined()
    expect(within(addBlockerSection).queryByText('Fix API')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Ship docs' }))

    await waitFor(() => {
      expect(mutationMocks['task.addBlocker']).toHaveBeenCalledWith({
        taskId: 'task-1',
        blockerTaskId: 'candidate-1'
      })
    })

    // Picking closes the picker; reopened, the added blocker is no longer offered.
    openBlockerPicker()
    expect(await screen.findByText('No tasks available')).toBeDefined()
  })

  it('removes a blocker from the filtered list', async () => {
    renderSidebar()

    await screen.findByText('Fix API')

    const blockerResults = screen.getByText('Fix API').closest('div')?.parentElement as HTMLElement
    const row = within(blockerResults).getByText('Fix API').closest('div')
    expect(row).not.toBeNull()

    fireEvent.click(within(row as HTMLElement).getByRole('button'))

    await waitFor(() => {
      expect(mutationMocks['task.removeBlocker']).toHaveBeenCalledWith({
        taskId: 'task-1',
        blockerTaskId: 'blocker-1'
      })
    })

    expect(within(blockerResults).queryByText('Fix API')).toBeNull()
  })

  it('shows "Set blocked" when task is not blocked', async () => {
    renderSidebar({ is_blocked: false })
    await screen.findByText('Fix API')
    expect(screen.getAllByRole('button', { name: 'Set blocked' }).length).toBeGreaterThanOrEqual(1)
  })

  it('shows "Unblock" when task is blocked', async () => {
    renderSidebar({ is_blocked: true })
    await screen.findByText('Fix API')
    expect(screen.getByRole('button', { name: 'Unblock' })).toBeDefined()
  })

  it('clicking "Set blocked" calls updateTask with isBlocked: true', async () => {
    renderSidebar({ is_blocked: false })
    await screen.findByText('Fix API')
    fireEvent.click(screen.getAllByRole('button', { name: 'Set blocked' })[0])
    await waitFor(() => {
      expect(mutationMocks['task.update']).toHaveBeenCalledWith({ id: 'task-1', isBlocked: true })
    })
  })

  it('clicking "Unblock" calls updateTask with isBlocked: false', async () => {
    renderSidebar({ is_blocked: true })
    await screen.findByText('Fix API')
    fireEvent.click(screen.getByRole('button', { name: 'Unblock' }))
    await waitFor(() => {
      expect(mutationMocks['task.update']).toHaveBeenCalledWith({
        id: 'task-1',
        isBlocked: false,
        blockedComment: null
      })
    })
  })

  it('displays blocked_comment when present', async () => {
    renderSidebar({ is_blocked: true, blocked_comment: 'waiting on API' })
    await screen.findByText('Fix API')
    expect(screen.getByText('waiting on API')).toBeDefined()
  })

  it('resets the add-blocker search when the task changes, not on a re-render', async () => {
    const view = renderSidebar()
    await screen.findByText('Fix API')
    openBlockerPicker()
    const search = (): HTMLInputElement =>
      screen.getByLabelText('Search available blockers') as HTMLInputElement
    await screen.findByLabelText('Search available blockers')
    fireEvent.change(search(), { target: { value: 'ship' } })

    const rerender = (task: Task): void =>
      view.rerender(
        <TaskMetadataSidebar
          task={task}
          tags={[]}
          taskTagIds={[]}
          onUpdate={vi.fn()}
          onTagsChange={vi.fn()}
        />
      )
    rerender(makeTask({ title: 'Renamed' }))
    expect(search().value).toBe('ship')

    rerender(makeTask({ id: 'task-2' }))
    expect(search().value).toBe('')
  })

  it('clearing blocked_comment calls updateTask', async () => {
    renderSidebar({ is_blocked: true, blocked_comment: 'waiting on API' })
    const commentText = await screen.findByText('waiting on API')
    const removeBtn = commentText.closest('div')!.querySelector('button')!
    fireEvent.click(removeBtn)
    await waitFor(() => {
      expect(mutationMocks['task.update']).toHaveBeenCalledWith({
        id: 'task-1',
        blockedComment: null
      })
    })
  })
})

// Task tabs live in <Activity>: hiding and re-showing a tab re-runs its effects.
// The blocker list is a local mirror of the getBlockers query that add/remove
// update optimistically; it re-syncs only when the query hands over new data.
describe('TaskMetadataSidebar blockers across a tab switch', () => {
  // `rev` re-renders the sidebar the way a query update would (this test file is
  // compiled too, so identical props would be memoized and never re-render it).
  function Tab({ mode, rev = 0 }: { mode: 'visible' | 'hidden'; rev?: number }) {
    return (
      <Activity mode={mode}>
        <TaskMetadataSidebar
          task={makeTask({ updated_at: `rev-${rev}` })}
          tags={[]}
          taskTagIds={[]}
          onUpdate={vi.fn()}
          onTagsChange={vi.fn()}
        />
      </Activity>
    )
  }
  const blockerRow = (title: string) => screen.queryByText(title)

  it('a blocker removed here stays removed after the tab is hidden and shown', async () => {
    const view = render(<Tab mode="visible" />)
    await screen.findByText('Fix API')
    const row = screen.getByText('Fix API').closest('div') as HTMLElement
    fireEvent.click(within(row).getByRole('button'))
    await waitFor(() => expect(blockerRow('Fix API')).toBeNull())

    view.rerender(<Tab mode="hidden" />)
    view.rerender(<Tab mode="visible" />)
    expect(blockerRow('Fix API')).toBeNull()
    expect(blockerRow('Refactor auth')).not.toBeNull()
  })

  it('new query data (a refetch) replaces the list, also when it lands while hidden', async () => {
    const view = render(<Tab mode="visible" />)
    await screen.findByText('Fix API')

    blockersData = [availableTask]
    view.rerender(<Tab mode="visible" rev={1} />)
    expect(blockerRow('Ship docs')).not.toBeNull()
    expect(blockerRow('Fix API')).toBeNull()

    view.rerender(<Tab mode="hidden" rev={1} />)
    blockersData = [doneTask]
    view.rerender(<Tab mode="hidden" rev={2} />)
    view.rerender(<Tab mode="visible" rev={2} />)
    expect(blockerRow('Already done')).not.toBeNull()
    expect(blockerRow('Ship docs')).toBeNull()
  })
})
