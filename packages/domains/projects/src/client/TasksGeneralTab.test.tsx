// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'

const mockResolveColumns = vi.fn()

vi.mock('@slayzone/workflow', () => ({
  resolveColumns: (...args: unknown[]) => mockResolveColumns(...args)
}))

vi.mock('@slayzone/ui', () => {
  const Passthrough = ({ children }: any) => <>{children}</>
  return {
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
    Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
    Select: ({ children, value, onValueChange }: any) => (
      <div data-testid-select={value} data-value={value}>
        <input type="hidden" data-select-value={value} onChange={(e: any) => onValueChange(e.target.value)} />
        {children}
      </div>
    ),
    SelectContent: Passthrough,
    SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
    SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    SelectValue: () => null,
  }
})

vi.mock('./project-settings-shared', () => ({
  SettingsTabIntro: ({ title, description }: any) => (
    <div data-testid="settings-tab-intro">
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  )
}))

import { TasksGeneralTab } from './TasksGeneralTab'

const TEST_COLUMNS = [
  { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' as const },
  { id: 'in_progress', label: 'In Progress', color: 'yellow', position: 1, category: 'started' as const },
  { id: 'done', label: 'Done', color: 'green', position: 2, category: 'completed' as const },
]

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    name: 'Test Project',
    color: '#ff0000',
    path: '/tmp/test',
    auto_create_worktree_on_task_create: null,
    worktree_source_branch: null,
    worktree_copy_behavior: null,
    worktree_copy_paths: null,
    columns_config: TEST_COLUMNS,
    execution_context: null,
    selected_repo: null,
    task_automation_config: null,
    sort_order: 0,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides,
  } as any
}

beforeEach(() => {
  mockResolveColumns.mockReturnValue(TEST_COLUMNS)
  ;(window as any).api = {
    db: {
      updateProject: vi.fn().mockResolvedValue(makeProject())
    }
  }
})

afterEach(cleanup)

describe('TasksGeneralTab', () => {
  it('renders two labeled select sections', () => {
    render(<TasksGeneralTab project={makeProject()} onUpdated={vi.fn()} />)
    expect(screen.getByText('When terminal starts working')).toBeDefined()
    expect(screen.getByText('When terminal becomes idle')).toBeDefined()
  })

  it('shows "Do nothing" as default option in both selects', () => {
    render(<TasksGeneralTab project={makeProject()} onUpdated={vi.fn()} />)
    const options = screen.getAllByText('Do nothing')
    expect(options.length).toBeGreaterThanOrEqual(2)
  })

  it('renders project statuses as select options', () => {
    render(<TasksGeneralTab project={makeProject()} onUpdated={vi.fn()} />)
    // Each status appears twice (once per select dropdown)
    expect(screen.getAllByText('Todo').length).toBe(2)
    expect(screen.getAllByText('In Progress').length).toBe(2)
    expect(screen.getAllByText('Done').length).toBe(2)
  })

  it('loads existing on_terminal_active from project', () => {
    const project = makeProject({
      task_automation_config: { on_terminal_active: 'in_progress', on_terminal_idle: null }
    })
    render(<TasksGeneralTab project={project} onUpdated={vi.fn()} />)
    const selects = document.querySelectorAll('[data-value]')
    const values = Array.from(selects).map(el => el.getAttribute('data-value'))
    expect(values).toContain('in_progress')
  })

  it('loads existing on_terminal_idle from project', () => {
    const project = makeProject({
      task_automation_config: { on_terminal_active: null, on_terminal_idle: 'done' }
    })
    render(<TasksGeneralTab project={project} onUpdated={vi.fn()} />)
    const selects = document.querySelectorAll('[data-value]')
    const values = Array.from(selects).map(el => el.getAttribute('data-value'))
    expect(values).toContain('done')
  })

  it('calls updateProject with correct config on save', async () => {
    const project = makeProject({
      task_automation_config: { on_terminal_active: 'in_progress', on_terminal_idle: 'done' }
    })
    const onUpdated = vi.fn()
    render(<TasksGeneralTab project={project} onUpdated={onUpdated} />)

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!)
    })

    expect(window.api.db.updateProject).toHaveBeenCalledWith({
      id: 'proj-1',
      taskAutomationConfig: { on_terminal_active: 'in_progress', on_terminal_idle: 'done' }
    })
  })

  it('sends null taskAutomationConfig when both set to "none"', async () => {
    const project = makeProject() // no config → both default to "none"
    render(<TasksGeneralTab project={project} onUpdated={vi.fn()} />)

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!)
    })

    expect(window.api.db.updateProject).toHaveBeenCalledWith({
      id: 'proj-1',
      taskAutomationConfig: null
    })
  })

  it('calls onUpdated with returned project after save', async () => {
    const returned = makeProject({ name: 'Updated' })
    ;(window.api.db.updateProject as any).mockResolvedValue(returned)
    const onUpdated = vi.fn()
    render(<TasksGeneralTab project={makeProject()} onUpdated={onUpdated} />)

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!)
    })

    expect(onUpdated).toHaveBeenCalledWith(returned)
  })

  it('resets selects when project prop changes', () => {
    const proj1 = makeProject({
      id: 'proj-1',
      task_automation_config: { on_terminal_active: 'in_progress', on_terminal_idle: null }
    })
    const proj2 = makeProject({
      id: 'proj-2',
      task_automation_config: { on_terminal_active: null, on_terminal_idle: 'done' }
    })

    const { rerender } = render(<TasksGeneralTab project={proj1} onUpdated={vi.fn()} />)
    let selects = document.querySelectorAll('[data-value]')
    let values = Array.from(selects).map(el => el.getAttribute('data-value'))
    expect(values).toContain('in_progress')

    rerender(<TasksGeneralTab project={proj2} onUpdated={vi.fn()} />)
    selects = document.querySelectorAll('[data-value]')
    values = Array.from(selects).map(el => el.getAttribute('data-value'))
    expect(values).toContain('done')
    expect(values).not.toContain('in_progress')
  })
})
