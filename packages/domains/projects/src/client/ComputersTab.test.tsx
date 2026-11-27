// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Project } from '@slayzone/projects-contracts'

type Computer = { id: string; name: string; usable?: boolean; disabledAt?: number | null }
let computers: Computer[] = []
// What the hub answers to projects.list after a change (the re-read).
let hubProjects: Project[] = []

const setProjectPath = vi.fn(async (_input: unknown) => ({ computerId: 'x', path: '/x' }))
const forgetProjectPath = vi.fn(async (_input: unknown) => ({ computerId: 'x', ok: true }))
const setDefaultComputer = vi.fn(async (_input: unknown) => undefined)
const relocate = vi.fn(async (_input: unknown) => hubProjects[0])
const toastError = vi.fn()

vi.mock('./trpc', () => ({
  useTRPC: () => ({
    computers: {
      list: {
        queryOptions: () => ({ queryKey: ['computers.list'], queryFn: async () => computers })
      },
      setProjectDefaultComputer: { mutationOptions: () => ({ mutationFn: setDefaultComputer }) }
    },
    projects: {
      list: {
        queryOptions: () => ({ queryKey: ['projects.list'], queryFn: async () => hubProjects }),
        queryFilter: () => ({ queryKey: ['projects.list'] })
      },
      relocate: { mutationOptions: () => ({ mutationFn: relocate }) }
    }
  }),
  useTRPCClient: () => ({
    workspace: {
      setProjectPath: { mutate: setProjectPath },
      forgetProjectPath: { mutate: forgetProjectPath }
    }
  })
}))

// The picker is its own unit (its own queries); here it only has to open on the
// right computer.
const pickerTargets: unknown[] = []
vi.mock('@slayzone/file-editor/client/WorkspaceDirPicker', () => ({
  WorkspaceDirPicker: ({ target }: { target: unknown }) => {
    pickerTargets.push(target)
    return <div data-testid="dir-picker" />
  }
}))

vi.mock('@slayzone/ui', async (load) => ({
  ...(await load<typeof import('@slayzone/ui')>()),
  toast: { success: () => undefined, error: (...args: unknown[]) => toastError(...args) }
}))

import { ComputersTab, useHubHasManyComputers } from './ComputersTab'

const project = (over: Partial<Project> = {}): Project =>
  ({
    id: 'p1',
    name: 'Proj',
    color: '#000000',
    default_computer_id: 'laptop',
    resolved_computer_id: 'laptop',
    placements: [
      { computer_id: 'laptop', path: '/Users/me/proj', status: 'ready' },
      { computer_id: 'server', path: '/srv/proj', status: 'pending' }
    ],
    ...over
  }) as Project

function renderTab(p: Project, onChanged = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ComputersTab project={p} onChanged={onChanged} />
    </QueryClientProvider>
  )
  return onChanged
}

beforeEach(() => {
  computers = [
    { id: 'server', name: 'Server', usable: false },
    { id: 'laptop', name: 'Laptop', usable: true },
    { id: 'ci', name: 'CI box', usable: true },
    { id: 'old', name: 'Old', usable: true, disabledAt: 1 }
  ]
  hubProjects = [project()]
  pickerTargets.length = 0
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ComputersTab', () => {
  it('lists every computer, the default first, each with its folder and state', async () => {
    renderTab(project())
    const rows = await screen.findAllByTestId(/^project-computer-[a-z]+$/)
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      'project-computer-laptop',
      'project-computer-ci',
      'project-computer-old',
      'project-computer-server'
    ])
    expect(screen.getByTestId('project-computer-laptop-path').textContent).toBe('/Users/me/proj')
    expect(screen.getByTestId('project-computer-laptop-status').textContent).toBe('Ready')
    expect(screen.getByTestId('project-computer-server-status').textContent).toBe(
      'Waiting for computer'
    )
    expect(screen.getByTestId('project-computer-ci-status').textContent).toBe('Not set')
    expect(screen.getByTestId('project-computer-server').textContent).toContain('offline')
    expect(screen.getByTestId('project-computer-old').textContent).toContain('disabled')
  })

  it('sets a folder on a computer that is not the default, and hands back the hub’s project', async () => {
    const updated = project({
      placements: [
        ...project().placements,
        { computer_id: 'ci', path: '/builds/proj', status: 'ready' }
      ]
    })
    hubProjects = [updated]
    const onChanged = renderTab(project())
    const row = await screen.findByTestId('project-computer-ci')
    fireEvent.click(row.querySelector('[aria-label="Type a path"]')!)
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: ' /builds/proj ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(updated))
    expect(setProjectPath).toHaveBeenCalledWith({
      computerId: 'ci',
      projectId: 'p1',
      path: '/builds/proj'
    })
  })

  it('a refused folder is shown to the user and changes nothing', async () => {
    setProjectPath.mockRejectedValueOnce(
      new Error("'/etc' is outside the folders this computer allows")
    )
    const onChanged = renderTab(project())
    const row = await screen.findByTestId('project-computer-ci')
    fireEvent.click(row.querySelector('[aria-label="Type a path"]')!)
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: '/etc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't use that folder", {
        description: "'/etc' is outside the folders this computer allows"
      })
    )
    expect(onChanged).not.toHaveBeenCalled()
    // Still editing: the user can fix the path.
    expect(screen.getByLabelText('Folder path')).toBeTruthy()
  })

  it('forgets the folder on that computer only', async () => {
    const onChanged = renderTab(project())
    fireEvent.click(await screen.findByTestId('project-computer-server-forget'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(forgetProjectPath).toHaveBeenCalledWith({ computerId: 'server', projectId: 'p1' })
  })

  it('browses the row’s own computer', async () => {
    renderTab(project())
    fireEvent.click(await screen.findByTestId('project-computer-server-browse'))
    expect(await screen.findByTestId('dir-picker')).toBeTruthy()
    expect(pickerTargets.at(-1)).toEqual({ computerId: 'server', projectId: 'p1' })
  })

  it('offers Make default on every other usable computer, never a disabled one', async () => {
    const onChanged = renderTab(project())
    await screen.findByTestId('project-computer-ci')
    expect(screen.queryByTestId('project-computer-laptop-make-default')).toBeNull()
    expect(screen.queryByTestId('project-computer-old-make-default')).toBeNull()
    // Offline is fine: work waits for it.
    fireEvent.click(screen.getByTestId('project-computer-server-make-default'))
    await waitFor(() =>
      expect(onChanged).toHaveBeenCalledWith(
        expect.objectContaining({ default_computer_id: 'server', resolved_computer_id: 'server' })
      )
    )
    expect(setDefaultComputer.mock.calls[0]![0]).toEqual({ projectId: 'p1', computerId: 'server' })
  })

  it('relocates the folder on the row’s computer', async () => {
    renderTab(project())
    const row = await screen.findByTestId('project-computer-server')
    fireEvent.click(
      Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Relocate…')!
    )
    const dialog = within(await screen.findByRole('dialog'))
    // The folder on THAT computer, not the default's.
    expect(dialog.getByText('/srv/proj')).toBeTruthy()
    fireEvent.click(dialog.getByLabelText(/Update path/))
    fireEvent.change(dialog.getByLabelText('Existing folder path'), {
      target: { value: '/srv/proj2' }
    })
    fireEvent.click(dialog.getByRole('button', { name: 'Update path' }))
    await waitFor(() => expect(relocate).toHaveBeenCalled())
    expect(relocate.mock.calls[0]![0]).toEqual({
      id: 'p1',
      computerId: 'server',
      sourcePath: '/srv/proj',
      path: '/srv/proj2',
      mode: 'update'
    })
  })
})

describe('useHubHasManyComputers', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  )
  it('is false with one computer (its folder is the General tab’s), true with two', async () => {
    computers = [{ id: 'laptop', name: 'Laptop' }]
    const one = renderHook(() => useHubHasManyComputers(), { wrapper })
    await new Promise((r) => setTimeout(r, 10))
    expect(one.result.current).toBe(false)
    computers = [...computers, { id: 'ci', name: 'CI' }]
    const two = renderHook(() => useHubHasManyComputers(), { wrapper })
    await waitFor(() => expect(two.result.current).toBe(true))
  })
})
