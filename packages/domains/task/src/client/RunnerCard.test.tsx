// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// Native-<select> stand-in for the Radix Select so onValueChange is drivable via
// fireEvent.change (SelectTrigger renders nothing — its content lives in the
// options emitted by SelectContent).
vi.mock('@slayzone/ui', () => ({
  Select: ({ children, value, onValueChange }: any) => (
    <select
      data-testid="runner-select"
      value={value}
      onChange={(e: any) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
  SelectTrigger: () => null,
  SelectValue: () => null
}))

// runners.list + runners.resolveTaskRunner drive useQuery; runners.setTaskRunner
// drives the mutation. Data is swappable per test via the mutable holders below.
let runnersData: Array<{ id: string; name: string }> = []
let resolvedRunnerId: string | null = null
const setTaskRunnerSpy = vi.fn()
const refetchSpy = vi.fn()

vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    runners: {
      list: { queryOptions: () => ({ queryKey: ['runners.list'] }) },
      resolveTaskRunner: {
        queryOptions: (input: { taskId: string }) => ({
          queryKey: ['runners.resolveTaskRunner', input]
        })
      },
      setTaskRunner: { mutationOptions: () => ({ __mutationKey: 'runners.setTaskRunner' }) }
    }
  })
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey: unknown[] }) => {
    const key = opts.queryKey[0]
    if (key === 'runners.list') {
      return { data: runnersData, isLoading: false, refetch: refetchSpy }
    }
    return { data: { runnerId: resolvedRunnerId }, isLoading: false, refetch: refetchSpy }
  },
  useMutation: (opts: { __mutationKey: string }) => ({
    mutateAsync: opts.__mutationKey === 'runners.setTaskRunner' ? setTaskRunnerSpy : vi.fn(),
    mutate: vi.fn(),
    isPending: false
  })
}))

import { RunnerCard } from './RunnerCard'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  runnersData = []
  resolvedRunnerId = null
  setTaskRunnerSpy.mockResolvedValue({ ok: true })
})

describe('RunnerCard', () => {
  it('shows a minimal "runs locally" state when no runners are enrolled', () => {
    runnersData = []
    render(<RunnerCard taskId="task-1" taskRunnerId={null} projectDefaultRunnerId={null} />)
    expect(screen.getByText('No runners — runs locally')).toBeDefined()
    // No select rendered in the empty state.
    expect(screen.queryByTestId('runner-select')).toBeNull()
  })

  it('renders inherit + each enrolled runner as options, labeling inherit with the project default', () => {
    runnersData = [
      { id: 'runner-a', name: 'mac-studio' },
      { id: 'runner-b', name: 'linux-box' }
    ]
    resolvedRunnerId = null
    render(<RunnerCard taskId="task-1" taskRunnerId={null} projectDefaultRunnerId={null} />)

    const options = Array.from(
      screen.getByTestId('runner-select').querySelectorAll('option')
    ).map((o) => o.textContent)
    expect(options).toContain('Inherit project default (Local)')
    expect(options).toContain('mac-studio')
    expect(options).toContain('linux-box')
  })

  it('labels the inherit option with the project default runner name when set', () => {
    runnersData = [{ id: 'runner-a', name: 'mac-studio' }]
    render(
      <RunnerCard taskId="task-1" taskRunnerId={null} projectDefaultRunnerId="runner-a" />
    )
    const options = Array.from(
      screen.getByTestId('runner-select').querySelectorAll('option')
    ).map((o) => o.textContent)
    expect(options).toContain('Inherit project default (mac-studio)')
  })

  it('selecting a runner fires setTaskRunner with that runnerId', async () => {
    runnersData = [{ id: 'runner-a', name: 'mac-studio' }]
    render(<RunnerCard taskId="task-1" taskRunnerId={null} projectDefaultRunnerId={null} />)

    fireEvent.change(screen.getByTestId('runner-select'), { target: { value: 'runner-a' } })

    await waitFor(() => {
      expect(setTaskRunnerSpy).toHaveBeenCalledWith({ taskId: 'task-1', runnerId: 'runner-a' })
    })
  })

  it('selecting inherit fires setTaskRunner with null', async () => {
    runnersData = [{ id: 'runner-a', name: 'mac-studio' }]
    // Start pinned so switching to inherit is a real change.
    render(<RunnerCard taskId="task-1" taskRunnerId="runner-a" projectDefaultRunnerId={null} />)

    fireEvent.change(screen.getByTestId('runner-select'), { target: { value: '__inherit__' } })

    await waitFor(() => {
      expect(setTaskRunnerSpy).toHaveBeenCalledWith({ taskId: 'task-1', runnerId: null })
    })
  })

  it('shows the effective resolved runner', () => {
    runnersData = [{ id: 'runner-a', name: 'mac-studio' }]
    resolvedRunnerId = 'runner-a'
    render(<RunnerCard taskId="task-1" taskRunnerId={null} projectDefaultRunnerId="runner-a" />)
    expect(screen.getByText('Runs on mac-studio')).toBeDefined()
  })
})
