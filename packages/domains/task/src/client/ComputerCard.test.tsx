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

vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
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
    if (key === 'computers.list') {
      return { data: computersData, isLoading: false, refetch: refetchSpy }
    }
    return { data: { computerId: resolvedComputerId }, isLoading: false, refetch: refetchSpy }
  },
  useMutation: (opts: { __mutationKey: string }) => ({
    mutateAsync: opts.__mutationKey === 'computers.setTaskComputer' ? setTaskComputerSpy : vi.fn(),
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
  setTaskComputerSpy.mockResolvedValue({ ok: true })
})

describe('ComputerCard', () => {
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

  it('shows the effective resolved computer', () => {
    computersData = [{ id: 'computer-a', name: 'mac-studio' }]
    resolvedComputerId = 'computer-a'
    render(
      <ComputerCard taskId="task-1" taskComputerId={null} projectDefaultComputerId="computer-a" />
    )
    expect(screen.getByText('Runs on mac-studio')).toBeDefined()
  })
})
