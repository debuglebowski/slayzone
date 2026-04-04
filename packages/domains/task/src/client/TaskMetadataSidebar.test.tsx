// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TaskMetadataSidebar } from './TaskMetadataSidebar'

vi.mock('@slayzone/ui', () => {
  const Passthrough = ({ children }: any) => <>{children}</>
  const Button = ({ children, variant: _variant, size: _size, ...props }: any) => <button {...props}>{children}</button>
  const Input = (props: any) => <input {...props} />

  return {
    Select: Passthrough,
    SelectContent: Passthrough,
    SelectItem: ({ children }: any) => <div>{children}</div>,
    SelectTrigger: ({ children }: any) => <div>{children}</div>,
    SelectValue: () => null,
    Popover: Passthrough,
    PopoverContent: ({ children }: any) => <div>{children}</div>,
    PopoverTrigger: ({ children }: any) => <>{children}</>,
    Calendar: () => null,
    Button,
    Input,
    Tooltip: Passthrough,
    TooltipTrigger: ({ children }: any) => <>{children}</>,
    TooltipContent: ({ children }: any) => <div>{children}</div>,
    buildStatusOptions: () => [],
    taskStatusOptions: [],
    cn: (...args: Array<string | false | null | undefined>) => args.filter(Boolean).join(' '),
    getColumnStatusStyle: (status: string | undefined, columns?: Array<{ id: string; label: string }>) => {
      if (!status) return null
      const column = columns?.find((item) => item.id === status)
      const label = column?.label ?? status
      return {
        bg: '',
        text: '',
        label,
        iconClass: `icon-${label}`,
        icon: ({ className, ...props }: any) => <svg data-testid={`status-icon-${label}`} className={className} {...props} />
      }
    },
    PriorityIcon: () => null,
    toast: { success: vi.fn(), error: vi.fn() }
  }
})

vi.mock('@slayzone/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('@slayzone/tags/client', () => ({ TagSelector: () => null }))
vi.mock('@slayzone/projects', () => ({ ProjectSelect: () => null }))
vi.mock('./SnoozePicker', () => ({ SnoozePicker: () => null }))
vi.mock('@slayzone/projects/shared', () => ({
  isTerminalStatus: (status: string, columns?: Array<{ id: string; category?: string }>) => {
    const column = columns?.find((item) => item.id === status)
    return column?.category === 'completed' || status === 'done'
  }
}))

afterEach(() => cleanup())

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any

function makeTask(overrides: Record<string, unknown> = {}) {
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
    ccs_profile: null,
    loop_config: null,
    snoozed_until: null,
    is_temporary: false,
    pr_url: null,
    repo_name: null,
    linear_url: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  } as any
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
] as any[]

const blockerTask = makeTask({ id: 'blocker-1', title: 'Fix API', status: 'doing', project_id: 'project-1' })
const extraBlockerTask = makeTask({ id: 'blocker-2', title: 'Refactor auth', status: 'triage', project_id: 'project-2' })
const availableTask = makeTask({ id: 'candidate-1', title: 'Ship docs', status: 'waiting', project_id: 'project-2' })
const doneTask = makeTask({ id: 'candidate-2', title: 'Already done', status: 'done', project_id: 'project-1' })

function renderSidebar() {
  return render(
    <TaskMetadataSidebar
      task={makeTask()}
      tags={[]}
      taskTagIds={[]}
      onUpdate={vi.fn()}
      onTagsChange={vi.fn()}
    />
  )
}

beforeEach(() => {
  ;(window as any).api = {
    db: {
      getTasks: vi.fn().mockResolvedValue([blockerTask, extraBlockerTask, availableTask, doneTask]),
      getProjects: vi.fn().mockResolvedValue(projects),
      updateTask: vi.fn()
    },
    taskDependencies: {
      getBlockers: vi.fn().mockResolvedValue([blockerTask, extraBlockerTask]),
      addBlocker: vi.fn().mockResolvedValue(undefined),
      removeBlocker: vi.fn().mockResolvedValue(undefined)
    },
    taskTags: {
      setTagsForTask: vi.fn().mockResolvedValue(undefined)
    },
    integrations: {
      getLink: vi.fn().mockResolvedValue(null),
      getTaskSyncStatus: vi.fn().mockResolvedValue(null)
    }
  }
})

describe('TaskMetadataSidebar', () => {
  it('renders status icons using project-specific status config for blocker rows and available blockers', async () => {
    renderSidebar()

    await screen.findByText('Fix API')

    expect(screen.queryByLabelText('Search blockers')).toBeNull()
    expect(screen.getByTitle('Doing')).toBeDefined()
    expect(screen.getByTitle('Triage')).toBeDefined()
    expect(screen.getByTitle('Waiting')).toBeDefined()
    expect(screen.queryByText('Already done')).toBeNull()
  })

  it('filters the add-blocker list independently and adds the selected blocker', async () => {
    renderSidebar()

    const addSearch = await screen.findByLabelText('Search available blockers')
    const addBlockerSection = addSearch.parentElement?.parentElement as HTMLElement
    fireEvent.change(addSearch, { target: { value: 'ship' } })

    expect(within(addBlockerSection).getByText('Ship docs')).toBeDefined()
    expect(within(addBlockerSection).queryByText('Fix API')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Ship docs' }))

    await waitFor(() => {
      expect(window.api.taskDependencies.addBlocker).toHaveBeenCalledWith('task-1', 'candidate-1')
    })

    expect(screen.getByText('No tasks available')).toBeDefined()
  })

  it('removes a blocker from the filtered list', async () => {
    renderSidebar()

    await screen.findByText('Fix API')

    const blockerResults = screen.getByText('Fix API').closest('div')?.parentElement as HTMLElement
    const row = within(blockerResults).getByText('Fix API').closest('div')
    expect(row).not.toBeNull()

    fireEvent.click(within(row as HTMLElement).getByRole('button'))

    await waitFor(() => {
      expect(window.api.taskDependencies.removeBlocker).toHaveBeenCalledWith('task-1', 'blocker-1')
    })

    expect(within(blockerResults).queryByText('Fix API')).toBeNull()
  })
})
