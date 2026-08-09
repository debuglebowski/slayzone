// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// tRPC surface used by GeneralTab. runners.list drives useQuery (data swapped per
// test); runners.setProjectDefaultRunner + the project mutations route to spies.
let runnersData: Array<{ id: string; name: string }> = []
const setProjectDefaultRunnerSpy = vi.fn()
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
