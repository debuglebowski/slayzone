// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// tRPC surface used by GeneralTab. computers.list drives useQuery (data swapped per
// test); computers.setProjectDefaultComputer + the project mutations route to spies.
let computersData: Array<{ id: string; name: string }> = []
const setProjectDefaultComputerSpy = vi.fn()
const genericMutateAsync = vi.fn()

vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    app: { dialog: { showOpenDialog: { mutationOptions: () => ({ __key: 'showOpenDialog' }) } } },
    projects: {
      uploadIcon: { mutationOptions: () => ({ __key: 'uploadIcon' }) },
      update: { mutationOptions: () => ({ __key: 'projects.update' }) }
    },
    computers: {
      list: { queryOptions: () => ({ queryKey: ['computers.list'] }) },
      setProjectDefaultComputer: {
        mutationOptions: () => ({ __key: 'computers.setProjectDefaultComputer' })
      }
    }
  })
}))

// The directory picker is its own unit with its own queries; GeneralTab only has
// to open it. Stubbing keeps this file about the computer select and the path
// field, and keeps the picker's data layer out of this mock.
vi.mock('@slayzone/file-editor/client/WorkspaceDirPicker', () => ({
  WorkspaceDirPicker: () => null
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: computersData, isLoading: false, refetch: vi.fn() }),
  useMutation: (opts: { __key: string }) => ({
    mutateAsync:
      opts.__key === 'computers.setProjectDefaultComputer'
        ? setProjectDefaultComputerSpy
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
        data-testid="default-computer-select"
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
    default_computer_id: null,
    columns_config: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides
  } as unknown as Project
}

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  computersData = []
  setProjectDefaultComputerSpy.mockResolvedValue({ ok: true })
})

function renderTab(project = makeProject()) {
  return render(
    <GeneralTab project={project} onUpdated={vi.fn()} onChanged={vi.fn()} onClose={vi.fn()} />
  )
}

describe('GeneralTab default computer', () => {
  it('shows a "runs locally" note when no computers are enrolled', () => {
    computersData = []
    renderTab()
    expect(screen.getByText('No computers — tasks run locally')).toBeDefined()
    expect(screen.queryByTestId('default-computer-select')).toBeNull()
  })

  it('renders Local + each enrolled computer as options', () => {
    computersData = [
      { id: 'computer-a', name: 'mac-studio' },
      { id: 'computer-b', name: 'linux-box' }
    ]
    renderTab()
    const options = Array.from(
      screen.getByTestId('default-computer-select').querySelectorAll('option')
    ).map((o) => o.textContent)
    expect(options).toContain('Local')
    expect(options).toContain('mac-studio')
    expect(options).toContain('linux-box')
  })

  it('selecting a computer fires setProjectDefaultComputer with that computerId', async () => {
    computersData = [{ id: 'computer-a', name: 'mac-studio' }]
    renderTab()
    fireEvent.change(screen.getByTestId('default-computer-select'), {
      target: { value: 'computer-a' }
    })
    await waitFor(() => {
      expect(setProjectDefaultComputerSpy).toHaveBeenCalledWith({
        projectId: 'proj-1',
        computerId: 'computer-a'
      })
    })
  })

  it('selecting Local fires setProjectDefaultComputer with null', async () => {
    computersData = [{ id: 'computer-a', name: 'mac-studio' }]
    renderTab(makeProject({ default_computer_id: 'computer-a' }))
    fireEvent.change(screen.getByTestId('default-computer-select'), {
      target: { value: '__local__' }
    })
    await waitFor(() => {
      expect(setProjectDefaultComputerSpy).toHaveBeenCalledWith({
        projectId: 'proj-1',
        computerId: null
      })
    })
  })

  it('preselects the project default computer', () => {
    computersData = [{ id: 'computer-a', name: 'mac-studio' }]
    renderTab(makeProject({ default_computer_id: 'computer-a' }))
    expect((screen.getByTestId('default-computer-select') as HTMLSelectElement).value).toBe(
      'computer-a'
    )
  })
})
