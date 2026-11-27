// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// Stand-in prop shapes: only what ComputerCard actually passes to each primitive,
// so a changed call site fails here instead of silently drifting.
type MockChildren = { children?: React.ReactNode }
type MockSelectProps = MockChildren & {
  value?: string
  onValueChange: (value: string) => void
}

// Native-<select> stand-in for the Radix Select so onValueChange is drivable via
// fireEvent.change (SelectTrigger renders nothing — its content lives in the
// options emitted by SelectContent).
vi.mock('@slayzone/ui', () => ({
  Button: ({
    children,
    onClick,
    disabled
  }: MockChildren & { onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Dialog: ({ children, open }: MockChildren & { open: boolean }) =>
    open ? <section role="dialog">{children}</section> : null,
  DialogContent: ({ children }: MockChildren) => <>{children}</>,
  DialogHeader: ({ children }: MockChildren) => <>{children}</>,
  DialogTitle: ({ children }: MockChildren) => <h2>{children}</h2>,
  DialogDescription: ({ children }: MockChildren) => <p>{children}</p>,
  DialogFooter: ({ children }: MockChildren) => <>{children}</>,
  Checkbox: ({
    checked,
    onCheckedChange,
    id
  }: {
    checked: boolean
    onCheckedChange: (v: boolean) => void
    id: string
  }) => (
    <input
      type="checkbox"
      id={id}
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
  Select: ({ children, value, onValueChange }: MockSelectProps) => (
    <select
      data-testid="computer-select"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: MockChildren) => <>{children}</>,
  SelectItem: ({ children, value }: MockChildren & { value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  // The title-row chip's menu: always rendered open-or-not by its `open` prop.
  DropdownMenu: ({ children }: MockChildren) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: MockChildren) => <>{children}</>,
  DropdownMenuContent: ({ children }: MockChildren) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled
  }: MockChildren & { onSelect?: () => void; disabled?: boolean }) => (
    <button role="menuitem" disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: MockChildren) => <>{children}</>,
  DropdownMenuSeparator: () => null,
  DropdownMenuShortcut: ({ children }: MockChildren) => <kbd>{children}</kbd>,
  cn: (...c: unknown[]) => c.filter(Boolean).join(' '),
  useShortcutDisplay: () => '⌘⇧M'
}))

// computers.list + computers.resolveTaskComputer drive useQuery; computers.setTaskComputer
// drives the mutation. Data is swappable per test via the mutable holders below.
let computersData: Array<{ id: string; name: string }> = []
let resolvedComputerId: string | null = null
const setTaskComputerSpy = vi.fn()
const refetchSpy = vi.fn()
const previewSpy = vi.fn()
const beginMoveSpy = vi.fn()
const setProjectPathSpy = vi.fn()
const cloneSpy = vi.fn()
let moveData: unknown = null

// The folder picker browses a computer; here it hands back one fixed path.
vi.mock('@slayzone/file-editor/client/WorkspaceDirPicker', () => ({
  WorkspaceDirPicker: ({
    open,
    onSelect,
    target
  }: {
    open: boolean
    onSelect: (path: string) => void
    target: { computerId?: string | null; projectId?: string }
  }) =>
    open ? (
      <button onClick={() => onSelect('/dest/project')}>
        pick on {target.computerId} for {target.projectId}
      </button>
    ) : null
}))

// The domain's typed view (`./trpc`) re-exports the runtime; point it at this mock.
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({
  useTRPCClient: () => ({
    task: {
      computerMovePreview: { query: previewSpy },
      cloneForComputerMove: { mutate: cloneSpy }
    },
    workspace: { setProjectPath: { mutate: setProjectPathSpy } }
  }),
  useTRPC: () => ({
    task: {
      computerMove: { queryOptions: () => ({ queryKey: ['task.computerMove'] }) },
      beginComputerMove: { mutationOptions: () => ({ __mutationKey: 'task.beginComputerMove' }) },
      runComputerMove: { mutationOptions: () => ({ __mutationKey: 'task.runComputerMove' }) },
      cancelComputerMove: { mutationOptions: () => ({ __mutationKey: 'task.cancelComputerMove' }) }
    },
    computers: {
      list: { queryOptions: () => ({ queryKey: ['computers.list'] }) },
      resolveTaskComputer: {
        queryOptions: (input: { taskId: string }) => ({
          queryKey: ['computers.resolveTaskComputer', input]
        })
      },
      setTaskComputer: { mutationOptions: () => ({ __mutationKey: 'computers.setTaskComputer' }) }
    }
  })
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey: unknown[] }) => {
    const key = opts.queryKey[0]
    if (key === 'task.computerMove') return { data: moveData, refetch: refetchSpy }
    if (key === 'computers.list') {
      return { data: computersData, isLoading: false, refetch: refetchSpy }
    }
    return { data: { computerId: resolvedComputerId }, isLoading: false, refetch: refetchSpy }
  },
  useMutation: (opts: { __mutationKey: string }) => ({
    mutateAsync:
      opts.__mutationKey === 'computers.setTaskComputer'
        ? setTaskComputerSpy
        : opts.__mutationKey === 'task.beginComputerMove'
          ? beginMoveSpy
          : vi.fn(),
    mutate: vi.fn(),
    isPending: false
  })
}))

import { ComputerCard } from './ComputerCard'
import { TaskComputerChip } from './TaskComputerChip'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  computersData = []
  resolvedComputerId = null
  moveData = null
  // The hub resolves inherit to the project default; here computer-a.
  previewSpy.mockImplementation(async ({ computerId }: { computerId: string | null }) => ({
    sourceComputerId: 'computer-a',
    destinationComputerId: computerId ?? 'computer-a',
    requiresMigration: false,
    hasFiles: false,
    ready: true,
    blockers: [],
    agents: []
  }))
  beginMoveSpy.mockResolvedValue({ id: 'move-1' })
  setProjectPathSpy.mockResolvedValue({ computerId: 'computer-b', path: '/dest/project' })
  setTaskComputerSpy.mockResolvedValue({ ok: true })
})

describe('ComputerCard', () => {
  const card = (props: Partial<React.ComponentProps<typeof ComputerCard>> = {}) =>
    render(
      <ComputerCard
        projectId="project-1"
        taskId="task-1"
        taskComputerId={null}
        projectDefaultComputerId={null}
        {...props}
      />
    )
  const openDialog = () => fireEvent.click(screen.getByText('Change computer…'))
  const choose = (value: string) =>
    fireEvent.change(screen.getByTestId('computer-select'), { target: { value } })
  const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
  const migration = {
    sourceComputerId: 'computer-a',
    destinationComputerId: 'computer-b',
    requiresMigration: true,
    hasFiles: true,
    ready: true,
    blockers: [],
    agents: []
  }

  it('shows where the task runs and a button, no picker until asked', () => {
    computersData = [{ id: 'computer-a', name: 'mac-studio' }]
    resolvedComputerId = 'computer-a'
    card({ projectDefaultComputerId: 'computer-a' })
    expect(screen.getByText('Runs on mac-studio')).toBeDefined()
    expect(screen.queryByTestId('computer-select')).toBeNull()
    openDialog()
    expect(screen.getByRole('dialog')).toBeDefined()
    expect(screen.getByTestId('computer-select')).toBeDefined()
  })

  it('shows a minimal "runs locally" state when no computers are enrolled', () => {
    computersData = []
    card()
    expect(screen.getByText('No computers — runs locally')).toBeDefined()
    expect(screen.queryByText('Change computer…')).toBeNull()
  })

  it('offers inherit (labeled with the project default) and each computer', () => {
    computersData = [
      { id: 'computer-a', name: 'mac-studio' },
      { id: 'computer-b', name: 'linux-box' }
    ]
    card({ projectDefaultComputerId: 'computer-a' })
    openDialog()
    const options = Array.from(
      screen.getByTestId('computer-select').querySelectorAll('option')
    ).map((o) => o.textContent)
    expect(options).toEqual(['Inherit project default (mac-studio)', 'mac-studio', 'linux-box'])
  })

  it('previews a real migration without saving the binding, then confirms explicitly', async () => {
    computersData = [
      { id: 'computer-a', name: 'source' },
      { id: 'computer-b', name: 'destination' }
    ]
    previewSpy.mockResolvedValueOnce(migration)
    card({ taskComputerId: 'computer-a' })
    openDialog()
    choose('computer-b')
    await waitFor(() => expect(button('Move to destination').disabled).toBe(false))
    expect(setTaskComputerSpy).not.toHaveBeenCalled()
    fireEvent.click(button('Move to destination'))
    await waitFor(() =>
      expect(beginMoveSpy).toHaveBeenCalledWith({
        taskId: 'task-1',
        computerId: 'computer-b',
        allowFreshSessions: false
      })
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows destination blockers and never starts an unavailable move', async () => {
    computersData = [{ id: 'computer-b', name: 'destination' }]
    previewSpy.mockResolvedValueOnce({
      ...migration,
      ready: false,
      blockers: ['Destination must be online.']
    })
    card()
    openDialog()
    choose('computer-b')
    expect(await screen.findByText('Destination must be online.')).toBeDefined()
    expect(button('Move to destination').disabled).toBe(true)
    expect(beginMoveSpy).not.toHaveBeenCalled()
  })

  it('switches without a move when nothing has to travel', async () => {
    computersData = [{ id: 'computer-a', name: 'mac-studio' }]
    card()
    openDialog()
    choose('computer-a')
    await waitFor(() => expect(button('Switch to mac-studio').disabled).toBe(false))
    expect(setTaskComputerSpy).not.toHaveBeenCalled()
    fireEvent.click(button('Switch to mac-studio'))
    await waitFor(() =>
      expect(setTaskComputerSpy).toHaveBeenCalledWith({
        taskId: 'task-1',
        computerId: 'computer-a'
      })
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('switching back to inherit saves null', async () => {
    computersData = [
      { id: 'computer-a', name: 'mac-studio' },
      { id: 'computer-b', name: 'linux-box' }
    ]
    card({ taskComputerId: 'computer-b', projectDefaultComputerId: 'computer-a' })
    openDialog()
    choose('__inherit__')
    await waitFor(() => expect(button('Switch to mac-studio').disabled).toBe(false))
    fireEvent.click(button('Switch to mac-studio'))
    await waitFor(() =>
      expect(setTaskComputerSpy).toHaveBeenCalledWith({ taskId: 'task-1', computerId: null })
    )
  })

  it('the current computer is not a change', () => {
    computersData = [{ id: 'computer-a', name: 'mac-studio' }]
    card({ taskComputerId: 'computer-a' })
    openDialog()
    expect((screen.getByTestId('computer-select') as HTMLSelectElement).value).toBe('computer-a')
    expect(previewSpy).not.toHaveBeenCalled()
    expect(button('Switch to mac-studio').disabled).toBe(true)
  })

  it('a failed switch is shown in the dialog, which stays open', async () => {
    computersData = [{ id: 'computer-a', name: 'source' }]
    setTaskComputerSpy.mockRejectedValueOnce(new Error('Connection lost'))
    card()
    openDialog()
    choose('computer-a')
    await waitFor(() => expect(button('Switch to source').disabled).toBe(false))
    fireEvent.click(button('Switch to source'))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Connection lost')
    expect(screen.getByRole('dialog')).toBeDefined()
  })

  it('a failed check is shown in the dialog', async () => {
    computersData = [{ id: 'computer-a', name: 'source' }]
    previewSpy.mockRejectedValueOnce(new Error('Computers are still connecting'))
    card()
    openDialog()
    choose('computer-a')
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Computers are still connecting'
    )
  })

  it('cannot be changed while a move is running', () => {
    computersData = [{ id: 'computer-a', name: 'source' }]
    moveData = {
      status: 'running',
      step: 'files',
      destinationComputerId: 'computer-a',
      bytesDone: 0,
      bytesTotal: 0,
      error: null
    }
    card()
    expect(button('Change computer…').disabled).toBe(true)
  })

  describe('a destination that is not set up', () => {
    const blocked = (destination: object) => ({
      ...migration,
      ready: false,
      blockers: ['Choose this project’s folder on the destination computer first.'],
      destination: {
        folder: null,
        folderExists: false,
        repoPath: null,
        repoRequired: true,
        repoReady: false,
        cloneUrl: 'git@example.test:org/repo.git',
        ...destination
      }
    })
    beforeEach(() => {
      computersData = [
        { id: 'computer-a', name: 'source' },
        { id: 'computer-b', name: 'destination' }
      ]
    })

    it('picks the folder on the destination computer, then checks again', async () => {
      previewSpy.mockResolvedValueOnce(blocked({})).mockResolvedValueOnce(migration)
      card({ taskComputerId: 'computer-a' })
      openDialog()
      choose('computer-b')
      fireEvent.click(await screen.findByText('Choose folder…'))
      fireEvent.click(screen.getByText('pick on computer-b for project-1'))
      await waitFor(() =>
        expect(setProjectPathSpy).toHaveBeenCalledWith({
          computerId: 'computer-b',
          projectId: 'project-1',
          path: '/dest/project'
        })
      )
      await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(2))
      expect(previewSpy).toHaveBeenLastCalledWith({ taskId: 'task-1', computerId: 'computer-b' })
      await waitFor(() => expect(button('Move to destination').disabled).toBe(false))
    })

    it('clones the repository into the chosen folder', async () => {
      previewSpy.mockResolvedValueOnce(
        blocked({ folder: '/dest/project', repoPath: '/dest/project' })
      )
      cloneSpy.mockResolvedValueOnce(migration)
      card({ taskComputerId: 'computer-a' })
      openDialog()
      choose('computer-b')
      expect(await screen.findByText(/git@example.test:org\/repo.git/)).toBeDefined()
      fireEvent.click(screen.getByText('Clone repository'))
      await waitFor(() =>
        expect(cloneSpy).toHaveBeenCalledWith({ taskId: 'task-1', computerId: 'computer-b' })
      )
      await waitFor(() => expect(button('Move to destination').disabled).toBe(false))
    })

    it('shows why a clone failed and keeps the dialog open', async () => {
      previewSpy.mockResolvedValueOnce(
        blocked({ folder: '/dest/project', repoPath: '/dest/project' })
      )
      cloneSpy.mockRejectedValueOnce(new Error('/dest/project is not empty.'))
      card({ taskComputerId: 'computer-a' })
      openDialog()
      choose('computer-b')
      fireEvent.click(await screen.findByText('Clone repository'))
      expect(await screen.findByText('/dest/project is not empty.')).toBeDefined()
      expect(screen.getByRole('dialog')).toBeDefined()
    })
  })
})

describe('TaskComputerChip', () => {
  const chip = (props: Partial<React.ComponentProps<typeof TaskComputerChip>> = {}) =>
    render(
      <TaskComputerChip
        projectId="project-1"
        taskId="task-1"
        taskComputerId={null}
        projectDefaultComputerId={null}
        open
        onOpenChange={() => {}}
        {...props}
      />
    )

  it('renders nothing when no computer is enrolled', () => {
    const { container } = chip()
    expect(container.innerHTML).toBe('')
  })

  it('shows the computer the task runs on', () => {
    computersData = [{ id: 'computer-a', name: 'mac-studio' }]
    resolvedComputerId = 'computer-a'
    chip({ taskComputerId: 'computer-a' })
    expect(screen.getByRole('button', { name: 'Computer: mac-studio' })).toBeDefined()
  })

  it('picking another computer opens the change dialog with it chosen, saving nothing yet', async () => {
    computersData = [
      { id: 'computer-a', name: 'mac-studio' },
      { id: 'computer-b', name: 'golden-comet' }
    ]
    resolvedComputerId = 'computer-a'
    chip({ taskComputerId: 'computer-a' })
    fireEvent.click(screen.getByRole('menuitem', { name: /golden-comet/ }))
    expect(await screen.findByRole('dialog')).toBeDefined()
    await waitFor(() =>
      expect(previewSpy).toHaveBeenCalledWith({ taskId: 'task-1', computerId: 'computer-b' })
    )
    expect(setTaskComputerSpy).not.toHaveBeenCalled()
  })

  it('picking the current computer does nothing', () => {
    computersData = [{ id: 'computer-a', name: 'mac-studio' }]
    resolvedComputerId = 'computer-a'
    chip({ taskComputerId: 'computer-a' })
    fireEvent.click(screen.getByRole('menuitem', { name: /mac-studio/ }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(previewSpy).not.toHaveBeenCalled()
  })
})
