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
  SelectValue: () => null
}))

// computers.list + computers.resolveTaskComputer drive useQuery; computers.setTaskComputer
// drives the mutation. Data is swappable per test via the mutable holders below.
let computersData: Array<{ id: string; name: string }> = []
let resolvedComputerId: string | null = null
const setTaskComputerSpy = vi.fn()
const refetchSpy = vi.fn()
const previewSpy = vi.fn()
const beginMoveSpy = vi.fn()
let moveData: unknown = null

// The domain's typed view (`./trpc`) re-exports the runtime; point it at this mock.
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({
  useTRPCClient: () => ({ task: { computerMovePreview: { query: previewSpy } } }),
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

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  computersData = []
  resolvedComputerId = null
  moveData = null
  previewSpy.mockResolvedValue({
    sourceComputerId: 'computer-a',
    destinationComputerId: 'computer-b',
    requiresMigration: false,
    hasFiles: false,
    ready: true,
    blockers: [],
    agents: []
  })
  beginMoveSpy.mockResolvedValue({ id: 'move-1' })
  setTaskComputerSpy.mockResolvedValue({ ok: true })
})

describe('ComputerCard', () => {
  it('previews a real migration without saving the binding, then confirms explicitly', async () => {
    computersData = [
      { id: 'computer-a', name: 'source' },
      { id: 'computer-b', name: 'destination' }
    ]
    previewSpy.mockResolvedValueOnce({
      sourceComputerId: 'computer-a',
      destinationComputerId: 'computer-b',
      requiresMigration: true,
      hasFiles: true,
      ready: true,
      blockers: [],
      agents: []
    })
    render(
      <ComputerCard taskId="task-1" taskComputerId="computer-a" projectDefaultComputerId={null} />
    )
    fireEvent.change(screen.getByTestId('computer-select'), { target: { value: 'computer-b' } })
    expect(await screen.findByRole('dialog')).toBeDefined()
    expect(setTaskComputerSpy).not.toHaveBeenCalled()
    expect(beginMoveSpy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Move to destination' }))
    await waitFor(() =>
      expect(beginMoveSpy).toHaveBeenCalledWith({
        taskId: 'task-1',
        computerId: 'computer-b',
        allowFreshSessions: false
      })
    )
  })
  it('shows destination blockers and never starts an unavailable move', async () => {
    computersData = [{ id: 'computer-b', name: 'destination' }]
    previewSpy.mockResolvedValueOnce({
      sourceComputerId: 'computer-a',
      destinationComputerId: 'computer-b',
      requiresMigration: true,
      hasFiles: true,
      ready: false,
      blockers: ['Destination must be online.'],
      agents: []
    })
    render(<ComputerCard taskId="task-1" taskComputerId={null} projectDefaultComputerId={null} />)
    fireEvent.change(screen.getByTestId('computer-select'), { target: { value: 'computer-b' } })
    expect(await screen.findByText('Destination must be online.')).toBeDefined()
    expect(
      (screen.getByRole('button', { name: 'Move to destination' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(beginMoveSpy).not.toHaveBeenCalled()
  })
  it('reports failed saves inline without an unhandled rejection', async () => {
    computersData = [{ id: 'computer-a', name: 'source' }]
    setTaskComputerSpy.mockRejectedValueOnce(new Error('Connection lost'))
    render(<ComputerCard taskId="task-1" taskComputerId={null} projectDefaultComputerId={null} />)
    fireEvent.change(screen.getByTestId('computer-select'), { target: { value: 'computer-a' } })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Connection lost')
  })
  it('shows a minimal "runs locally" state when no computers are enrolled', () => {
    computersData = []
    render(<ComputerCard taskId="task-1" taskComputerId={null} projectDefaultComputerId={null} />)
    expect(screen.getByText('No computers — runs locally')).toBeDefined()
    // No select rendered in the empty state.
    expect(screen.queryByTestId('computer-select')).toBeNull()
  })

  it('renders inherit + each enrolled computer as options, labeling inherit with the project default', () => {
    computersData = [
      { id: 'computer-a', name: 'mac-studio' },
      { id: 'computer-b', name: 'linux-box' }
    ]
    resolvedComputerId = null
    render(<ComputerCard taskId="task-1" taskComputerId={null} projectDefaultComputerId={null} />)

    const options = Array.from(
      screen.getByTestId('computer-select').querySelectorAll('option')
    ).map((o) => o.textContent)
    expect(options).toContain('Inherit project default (Local)')
    expect(options).toContain('mac-studio')
    expect(options).toContain('linux-box')
  })

  it('labels the inherit option with the project default computer name when set', () => {
    computersData = [{ id: 'computer-a', name: 'mac-studio' }]
    render(
      <ComputerCard taskId="task-1" taskComputerId={null} projectDefaultComputerId="computer-a" />
    )
    const options = Array.from(
      screen.getByTestId('computer-select').querySelectorAll('option')
    ).map((o) => o.textContent)
    expect(options).toContain('Inherit project default (mac-studio)')
  })

  it('selecting a computer fires setTaskComputer with that computerId', async () => {
    computersData = [{ id: 'computer-a', name: 'mac-studio' }]
    render(<ComputerCard taskId="task-1" taskComputerId={null} projectDefaultComputerId={null} />)

    fireEvent.change(screen.getByTestId('computer-select'), { target: { value: 'computer-a' } })

    await waitFor(() => {
      expect(setTaskComputerSpy).toHaveBeenCalledWith({
        taskId: 'task-1',
        computerId: 'computer-a'
      })
    })
  })

  it('selecting inherit fires setTaskComputer with null', async () => {
    computersData = [{ id: 'computer-a', name: 'mac-studio' }]
    // Start pinned so switching to inherit is a real change.
    render(
      <ComputerCard taskId="task-1" taskComputerId="computer-a" projectDefaultComputerId={null} />
    )

    fireEvent.change(screen.getByTestId('computer-select'), { target: { value: '__inherit__' } })

    await waitFor(() => {
      expect(setTaskComputerSpy).toHaveBeenCalledWith({ taskId: 'task-1', computerId: null })
    })
  })

  it('re-syncs the local binding only when the task or its persisted binding changes', async () => {
    computersData = [
      { id: 'computer-a', name: 'mac-studio' },
      { id: 'computer-b', name: 'linux-box' }
    ]
    const select = (): HTMLSelectElement =>
      screen.getByTestId('computer-select') as HTMLSelectElement
    const { rerender } = render(
      <ComputerCard taskId="task-1" taskComputerId={null} projectDefaultComputerId={null} />
    )
    expect(select().value).toBe('__inherit__')

    // Local choice sticks across re-renders with unchanged props.
    fireEvent.change(select(), { target: { value: 'computer-a' } })
    await waitFor(() => expect(setTaskComputerSpy).toHaveBeenCalled())
    rerender(<ComputerCard taskId="task-1" taskComputerId={null} projectDefaultComputerId={null} />)
    expect(select().value).toBe('computer-a')

    // Persisted binding changes → mirror it.
    rerender(
      <ComputerCard taskId="task-1" taskComputerId="computer-b" projectDefaultComputerId={null} />
    )
    expect(select().value).toBe('computer-b')

    // Another task with the same binding value still re-syncs (taskId is a trigger).
    fireEvent.change(select(), { target: { value: 'computer-a' } })
    rerender(
      <ComputerCard taskId="task-2" taskComputerId="computer-b" projectDefaultComputerId={null} />
    )
    expect(select().value).toBe('computer-b')
  })

  it('a rejected save rolls the select back to the persisted binding', async () => {
    computersData = [{ id: 'computer-a', name: 'mac-studio' }]
    setTaskComputerSpy.mockRejectedValueOnce(new Error('computer offline'))
    const select = (): HTMLSelectElement =>
      screen.getByTestId('computer-select') as HTMLSelectElement
    render(<ComputerCard taskId="task-1" taskComputerId={null} projectDefaultComputerId={null} />)

    // The handler rethrows (as before); swallow it here so the test sees the UI.
    const onUnhandled = (e: PromiseRejectionEvent | Error) => {
      if ('preventDefault' in e) e.preventDefault()
    }
    process.on('unhandledRejection', onUnhandled)
    fireEvent.change(select(), { target: { value: 'computer-a' } })
    await waitFor(() => expect(setTaskComputerSpy).toHaveBeenCalled())
    await waitFor(() => expect(select().value).toBe('__inherit__'))
    process.off('unhandledRejection', onUnhandled)
  })

  it('shows the effective resolved computer', () => {
    computersData = [{ id: 'computer-a', name: 'mac-studio' }]
    resolvedComputerId = 'computer-a'
    render(
      <ComputerCard taskId="task-1" taskComputerId={null} projectDefaultComputerId="computer-a" />
    )
    expect(screen.getByText('Runs on mac-studio')).toBeDefined()
  })
})
