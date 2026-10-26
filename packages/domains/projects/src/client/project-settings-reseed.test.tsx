// @vitest-environment jsdom
/**
 * Form state that re-seeds from props: the project-settings tabs, the folder
 * dialog, the integration credential modal and the lock popover all keep local
 * edits until a NEW prop object (or a re-open) arrives, then reset from it.
 */
import React, { createContext, useContext } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Project, ProjectGroup } from '@slayzone/projects/shared'

vi.mock('@slayzone/transport/client', () => {
  const inert = { mutationOptions: () => ({}) }
  return {
    useTRPC: () => new Proxy({}, { get: () => new Proxy({}, { get: () => new Proxy(inert, {}) }) })
  }
})

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync: vi.fn() }),
  useQueryClient: () => ({ fetchQuery: vi.fn() })
}))

type Kids = { children?: React.ReactNode }
type OpenProps = Kids & { open?: boolean; onOpenChange?: (open: boolean) => void }

vi.mock('@slayzone/ui', () => {
  const Passthrough = ({ children }: Kids) => <>{children}</>
  const OpenCtx = createContext<{ open: boolean; onOpenChange?: (open: boolean) => void }>({
    open: false
  })
  const Openable = ({ open = false, onOpenChange, children }: OpenProps) => (
    <OpenCtx.Provider value={{ open, onOpenChange }}>{children}</OpenCtx.Provider>
  )
  const OpenContent = ({ children }: Kids) => (useContext(OpenCtx).open ? <>{children}</> : null)
  const Trigger = ({ children }: Kids) => {
    const { open, onOpenChange } = useContext(OpenCtx)
    return (
      <span data-testid="open-trigger" onClick={() => onOpenChange?.(!open)}>
        {children}
      </span>
    )
  }
  const Button = ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  )
  return {
    cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
    Button,
    IconButton: Button,
    Input: (props: React.ComponentProps<'input'>) => <input {...props} />,
    Label: ({ children, ...props }: React.ComponentProps<'label'>) => (
      <label {...props}>{children}</label>
    ),
    Switch: ({
      checked,
      onCheckedChange
    }: {
      checked?: boolean
      onCheckedChange?: (checked: boolean) => void
    }) => (
      <input
        type="checkbox"
        data-testid="switch"
        checked={!!checked}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
      />
    ),
    Select: ({ children, value }: Kids & { value?: string }) => (
      <div data-select-value={value}>{children}</div>
    ),
    SelectContent: Passthrough,
    SelectItem: ({ children }: Kids) => <div>{children}</div>,
    SelectTrigger: ({ children }: Kids) => <div>{children}</div>,
    SelectValue: () => null,
    DropdownMenu: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuContent: () => null,
    DropdownMenuItem: Passthrough,
    Dialog: Openable,
    DialogContent: OpenContent,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
    DialogDescription: Passthrough,
    AlertDialog: Openable,
    AlertDialogContent: OpenContent,
    AlertDialogHeader: Passthrough,
    AlertDialogTitle: Passthrough,
    AlertDialogDescription: Passthrough,
    AlertDialogFooter: Passthrough,
    AlertDialogCancel: Passthrough,
    AlertDialogAction: Passthrough,
    Popover: Openable,
    PopoverTrigger: Trigger,
    PopoverContent: OpenContent
  }
})

import { ColumnsTab } from './ColumnsTab'
import { EnvironmentTab } from './EnvironmentTab'
import { WorktreesTab } from './WorktreesTab'
import { GroupSettingsDialog } from './GroupSettingsDialog'
import { ProjectIntegrationConnectionModal } from './ProjectIntegrationConnectionModal'
import { ProjectLockPopover } from './ProjectLockPopover'

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    color: '#ff0000',
    path: '/tmp/test',
    auto_create_worktree_on_task_create: null,
    worktree_source_branch: 'main',
    worktree_copy_behavior: null,
    worktree_copy_paths: null,
    worktree_submodule_init: null,
    columns_config: [
      { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
      { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' }
    ],
    execution_context: { type: 'docker', container: 'box-1' },
    selected_repo: null,
    task_automation_config: null,
    lock_config: null,
    icon_letters: null,
    icon_image_path: null,
    owner_user_id: null,
    group_id: null,
    starred: false,
    sort_order: 0,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides
  } as Project
}

const valueOf = (selector: string) =>
  (document.querySelector(selector) as HTMLInputElement | null)?.value
const type = (selector: string, value: string) =>
  fireEvent.change(document.querySelector(selector)!, { target: { value } })

afterEach(cleanup)

describe('EnvironmentTab', () => {
  const ui = (project: Project) => (
    <EnvironmentTab project={project} onUpdated={vi.fn()} onClose={vi.fn()} />
  )

  it('seeds from the project on mount', () => {
    render(ui(makeProject()))
    expect(valueOf('#exec-container')).toBe('box-1')
  })

  it('keeps edits for the same project object, re-seeds from a new one', () => {
    const project = makeProject()
    const { rerender } = render(ui(project))
    type('#exec-container', 'edited')
    rerender(ui(project))
    expect(valueOf('#exec-container')).toBe('edited')

    rerender(ui(makeProject({ execution_context: { type: 'docker', container: 'box-2' } })))
    expect(valueOf('#exec-container')).toBe('box-2')

    rerender(ui(makeProject({ execution_context: { type: 'ssh', target: 'me@host' } })))
    expect(valueOf('#exec-container')).toBeUndefined()
    expect(valueOf('#exec-ssh-target')).toBe('me@host')
  })
})

describe('WorktreesTab', () => {
  const ui = (project: Project) => (
    <WorktreesTab project={project} onUpdated={vi.fn()} onClose={vi.fn()} />
  )

  it('seeds on mount, keeps edits for the same object, re-seeds from a new one', () => {
    const project = makeProject()
    const { rerender } = render(ui(project))
    expect(valueOf('#worktree-source-branch')).toBe('main')

    type('#worktree-source-branch', 'dev')
    rerender(ui(project))
    expect(valueOf('#worktree-source-branch')).toBe('dev')

    rerender(ui(makeProject({ worktree_source_branch: 'release' })))
    expect(valueOf('#worktree-source-branch')).toBe('release')
  })
})

describe('ColumnsTab', () => {
  const ui = (project: Project) => <ColumnsTab project={project} onUpdated={vi.fn()} />
  const labels = () =>
    screen.getAllByPlaceholderText('Status label').map((el) => (el as HTMLInputElement).value)

  it('keeps a draft for the same project object, re-seeds from a new one', () => {
    const project = makeProject()
    const { rerender } = render(ui(project))
    expect(labels()).toEqual(['Todo', 'Done'])

    fireEvent.change(screen.getAllByPlaceholderText('Status label')[0], {
      target: { value: 'Backlog' }
    })
    rerender(ui(project))
    expect(labels()).toEqual(['Backlog', 'Done'])

    rerender(ui(makeProject()))
    expect(labels()).toEqual(['Todo', 'Done'])
  })
})

describe('GroupSettingsDialog', () => {
  const ui = (group: ProjectGroup) => (
    <GroupSettingsDialog
      group={group}
      open
      onClose={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
    />
  )
  const group = (id: string, name: string) => ({ id, name }) as ProjectGroup

  it('keeps edits for the same group, resets on another group or a rename', () => {
    const { rerender } = render(ui(group('g1', 'Alpha')))
    expect(valueOf('#group-name')).toBe('Alpha')

    type('#group-name', 'typing')
    rerender(ui(group('g1', 'Alpha')))
    expect(valueOf('#group-name')).toBe('typing')

    rerender(ui(group('g2', 'Beta')))
    expect(valueOf('#group-name')).toBe('Beta')

    type('#group-name', 'typing')
    rerender(ui(group('g2', 'Beta 2')))
    expect(valueOf('#group-name')).toBe('Beta 2')
  })
})

describe('ProjectIntegrationConnectionModal', () => {
  const ui = (open: boolean, provider: 'github' | 'linear' = 'github') => (
    <ProjectIntegrationConnectionModal
      open={open}
      onOpenChange={vi.fn()}
      projectId="proj-1"
      provider={provider}
      mode="connect"
      onConnectionsChanged={vi.fn()}
    />
  )

  it('keeps the credential while open, clears it on re-open and on provider switch', () => {
    const { rerender } = render(ui(true))
    type('#project-github-connect-credential', 'ghp_secret')
    rerender(ui(true))
    expect(valueOf('#project-github-connect-credential')).toBe('ghp_secret')

    rerender(ui(false))
    rerender(ui(true))
    expect(valueOf('#project-github-connect-credential')).toBe('')

    type('#project-github-connect-credential', 'ghp_secret')
    rerender(ui(true, 'linear'))
    expect(valueOf('#project-linear-connect-credential')).toBe('')
  })

  it('re-rendering with unchanged props keeps the credential (reset only on transitions)', () => {
    const { rerender } = render(ui(true))
    type('#project-github-connect-credential', 'kept')
    rerender(ui(true, 'github'))
    expect(valueOf('#project-github-connect-credential')).toBe('kept')
  })
})

describe('ProjectLockPopover', () => {
  const ui = (project: Project) => <ProjectLockPopover project={project} onUpdated={vi.fn()} />
  const toggleOpen = () => fireEvent.click(screen.getByTestId('open-trigger'))
  const durationSwitch = () => screen.getAllByTestId('switch')[0] as HTMLInputElement
  const rateLimitSwitch = () => screen.getAllByTestId('switch')[1] as HTMLInputElement

  it('discards pending edits when re-opened', () => {
    render(ui(makeProject()))
    toggleOpen()
    expect(durationSwitch().checked).toBe(false)
    fireEvent.click(durationSwitch())
    expect(durationSwitch().checked).toBe(true)

    toggleOpen()
    toggleOpen()
    expect(durationSwitch().checked).toBe(false)
  })

  it('opens on the persisted config and follows a config change while open', () => {
    const lock = (perMinutes: number) =>
      ({
        locked_until: null,
        rate_limit: { max_tasks: 2, per_minutes: perMinutes },
        schedule: null
      }) as Project['lock_config']
    const project = makeProject({ lock_config: lock(30) })
    const { rerender } = render(ui(project))
    toggleOpen()
    expect(rateLimitSwitch().checked).toBe(true)

    fireEvent.click(rateLimitSwitch())
    expect(rateLimitSwitch().checked).toBe(false)
    rerender(ui(project))
    expect(rateLimitSwitch().checked).toBe(false)

    rerender(ui(makeProject({ lock_config: lock(60) })))
    expect(rateLimitSwitch().checked).toBe(true)
  })
})
