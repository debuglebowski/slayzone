// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// tRPC surface used by GeneralTab. runners.list drives useQuery (data swapped per
// test); runners.setProjectDefaultRunner + the project mutations route to spies.
let runnersData: Array<{ id: string; name: string }> = []
const setProjectDefaultRunnerSpy = vi.fn()
const setProjectLockedRunnerSpy = vi.fn()
const genericMutateAsync = vi.fn()

vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    app: { dialog: { showOpenDialog: { mutationOptions: () => ({ __key: 'showOpenDialog' }) } } },
    projects: {
      uploadIcon: { mutationOptions: () => ({ __key: 'uploadIcon' }) },
      update: { mutationOptions: () => ({ __key: 'projects.update' }) }
    },
    runners: {
      list: { queryOptions: () => ({ queryKey: ['runners.list'] }) },
      setProjectDefaultRunner: {
        mutationOptions: () => ({ __key: 'runners.setProjectDefaultRunner' })
      },
      setProjectLockedRunner: {
        mutationOptions: () => ({ __key: 'runners.setProjectLockedRunner' })
      }
    }
  })
}))

// The directory picker is its own unit with its own queries; GeneralTab only has
// to open it. Stubbing keeps this file about the runner select and the path
// field, and keeps the picker's data layer out of this mock.
vi.mock('@slayzone/file-editor/client/WorkspaceDirPicker', () => ({
  WorkspaceDirPicker: () => null
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: runnersData, isLoading: false, refetch: vi.fn() }),
  useMutation: (opts: { __key: string }) => ({
    mutateAsync:
      opts.__key === 'runners.setProjectDefaultRunner'
        ? setProjectDefaultRunnerSpy
        : opts.__key === 'runners.setProjectLockedRunner'
          ? setProjectLockedRunnerSpy
          : genericMutateAsync
  })
}))

// Stand-ins for the design-system components GeneralTab renders. Each is typed
// against the intrinsic element it degrades to, so a prop the real component
// forwards but the stub drops fails here rather than silently at runtime.
type Kids = { children?: React.ReactNode }

vi.mock('@slayzone/ui', () => {
  const Passthrough = ({ children }: Kids) => <>{children}</>
  return {
    Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
      <button {...props}>{children}</button>
    ),
    IconButton: ({ children, ...props }: React.ComponentProps<'button'>) => (
      <button {...props}>{children}</button>
    ),
    Input: (props: React.ComponentProps<'input'>) => <input {...props} />,
    // Radix Checkbox is a button with aria-checked, not an <input>. Stubbed as a
    // real checkbox so `fireEvent.click` toggles it the way the component expects.
    Checkbox: ({
      checked,
      onCheckedChange,
      ...props
    }: {
      checked?: boolean
      onCheckedChange?: (checked: boolean) => void
    } & React.ComponentProps<'input'>) => (
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
        {...props}
      />
    ),
    Label: ({ children, ...props }: React.ComponentProps<'label'>) => (
      <label {...props}>{children}</label>
    ),
    ColorPicker: ({ value }: { value?: string }) => (
      <div data-testid="color-picker" data-value={value} />
    ),
    Select: ({
      children,
      value,
      onValueChange
    }: Kids & { value?: string; onValueChange: (value: string) => void }) => (
      <select
        data-testid="default-runner-select"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {children}
      </select>
    ),
    SelectContent: Passthrough,
    SelectItem: ({ children, value }: Kids & { value: string }) => (
      <option value={value}>{children}</option>
    ),
    SelectTrigger: ({ children }: Kids) => <>{children}</>,
    SelectValue: () => null
  }
})

vi.mock('@slayzone/platform/slz-file-url', () => ({ toSlzFileUrl: (p: string) => `slz://${p}` }))
vi.mock('@slayzone/settings/client', () => ({
  useDialogStore: { getState: () => ({ openDeleteProject: vi.fn() }) }
}))
vi.mock('./project-settings-shared', () => ({
  SettingsTabIntro: ({ title }: { title: string }) => <h2>{title}</h2>
}))

import { GeneralTab } from './GeneralTab'
import type { Project } from '@slayzone/projects/shared'

// Only the columns GeneralTab reads are filled in; the rest of the `Project` row
// is irrelevant here, so the literal is widened through `unknown` rather than
// padded with fields no assertion touches.
function makeProject(overrides: Record<string, unknown> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    color: '#ff0000',
    path: '/tmp/test',
    icon_letters: null,
    icon_image_path: null,
    default_runner_id: null,
    columns_config: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides
  } as unknown as Project
}

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  runnersData = []
  setProjectDefaultRunnerSpy.mockResolvedValue({ ok: true })
  setProjectLockedRunnerSpy.mockResolvedValue({ ok: true })
})

function renderTab(project = makeProject()) {
  return render(
    <GeneralTab project={project} onUpdated={vi.fn()} onChanged={vi.fn()} onClose={vi.fn()} />
  )
}

describe('GeneralTab default runner', () => {
  it('shows a "runs locally" note when no runners are enrolled', () => {
    runnersData = []
    renderTab()
    expect(screen.getByText('No runners — tasks run locally')).toBeDefined()
    expect(screen.queryByTestId('default-runner-select')).toBeNull()
  })

  it('renders Local + each enrolled runner as options', () => {
    runnersData = [
      { id: 'runner-a', name: 'mac-studio' },
      { id: 'runner-b', name: 'linux-box' }
    ]
    renderTab()
    const options = Array.from(
      screen.getByTestId('default-runner-select').querySelectorAll('option')
    ).map((o) => o.textContent)
    expect(options).toContain('Local')
    expect(options).toContain('mac-studio')
    expect(options).toContain('linux-box')
  })

  it('selecting a runner fires setProjectDefaultRunner with that runnerId', async () => {
    runnersData = [{ id: 'runner-a', name: 'mac-studio' }]
    renderTab()
    fireEvent.change(screen.getByTestId('default-runner-select'), {
      target: { value: 'runner-a' }
    })
    await waitFor(() => {
      expect(setProjectDefaultRunnerSpy).toHaveBeenCalledWith({
        projectId: 'proj-1',
        runnerId: 'runner-a'
      })
    })
  })

  it('selecting Local fires setProjectDefaultRunner with null', async () => {
    runnersData = [{ id: 'runner-a', name: 'mac-studio' }]
    renderTab(makeProject({ default_runner_id: 'runner-a' }))
    fireEvent.change(screen.getByTestId('default-runner-select'), {
      target: { value: '__local__' }
    })
    await waitFor(() => {
      expect(setProjectDefaultRunnerSpy).toHaveBeenCalledWith({
        projectId: 'proj-1',
        runnerId: null
      })
    })
  })

  it('preselects the project default runner', () => {
    runnersData = [{ id: 'runner-a', name: 'mac-studio' }]
    renderTab(makeProject({ default_runner_id: 'runner-a' }))
    expect((screen.getByTestId('default-runner-select') as HTMLSelectElement).value).toBe(
      'runner-a'
    )
  })
})

describe('GeneralTab lock to runner', () => {
  // Only offered when there is more than one machine: a single-runner hub has
  // nothing to lock away from, and the control would be inert.
  it('is hidden with fewer than two runners', () => {
    runnersData = [{ id: 'runner-a', name: 'mac-studio' }]
    renderTab()
    expect(screen.queryByLabelText('Lock to this runner')).toBeNull()
  })

  // Deliberately not a second runner picker: two controls naming a machine for one
  // project invites setting them to different runners, and the lock's whole point
  // is that there is exactly one.
  it('locks to the CURRENT default runner', async () => {
    runnersData = [
      { id: 'runner-a', name: 'mac-studio' },
      { id: 'runner-b', name: 'linux-box' }
    ]
    renderTab(makeProject({ default_runner_id: 'runner-b' }))
    fireEvent.click(screen.getByLabelText('Lock to this runner'))
    await waitFor(() => {
      expect(setProjectLockedRunnerSpy).toHaveBeenCalledWith({
        projectId: 'proj-1',
        runnerId: 'runner-b'
      })
    })
  })

  // A lock left pointing at the old runner would show one machine in the UI while
  // every task resolved to another.
  it('follows the default runner when that changes while locked', async () => {
    runnersData = [
      { id: 'runner-a', name: 'mac-studio' },
      { id: 'runner-b', name: 'linux-box' }
    ]
    renderTab(makeProject({ default_runner_id: 'runner-a', locked_runner_id: 'runner-a' }))
    fireEvent.change(screen.getByTestId('default-runner-select'), {
      target: { value: 'runner-b' }
    })
    await waitFor(() => {
      expect(setProjectLockedRunnerSpy).toHaveBeenCalledWith({
        projectId: 'proj-1',
        runnerId: 'runner-b'
      })
    })
  })

  it('unlocks with null', async () => {
    runnersData = [
      { id: 'runner-a', name: 'mac-studio' },
      { id: 'runner-b', name: 'linux-box' }
    ]
    renderTab(makeProject({ default_runner_id: 'runner-a', locked_runner_id: 'runner-a' }))
    fireEvent.click(screen.getByLabelText('Lock to this runner'))
    await waitFor(() => {
      expect(setProjectLockedRunnerSpy).toHaveBeenCalledWith({
        projectId: 'proj-1',
        runnerId: null
      })
    })
  })
})

describe('GeneralTab remote git mode', () => {
  it('reveals the url field only when enabled, and saves both', async () => {
    renderTab()
    const toggle = screen.getByLabelText('Clone from a git remote when a runner needs it')
    expect(screen.queryByPlaceholderText('git@github.com:owner/repo.git')).toBeNull()

    fireEvent.click(toggle)
    const url = screen.getByPlaceholderText('git@github.com:owner/repo.git')
    fireEvent.change(url, { target: { value: 'git@github.com:o/r.git' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(genericMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ gitMode: 'remote', repoUrl: 'git@github.com:o/r.git' })
      )
    })
  })

  // An empty string would pass the server's `git_mode === 'remote' && repo_url`
  // check and produce a clone of nothing.
  it('sends null rather than an empty url', async () => {
    renderTab(makeProject({ git_mode: 'remote', repo_url: '' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(genericMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ repoUrl: null }))
    })
  })
})
