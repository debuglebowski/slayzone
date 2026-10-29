// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Automation, AutomationRun } from '@slayzone/automations/shared'

// AutomationCard loads per-run action details over tRPC
// (`queryClient.fetchQuery(trpc.history.getAutomationActionRuns.queryOptions(...))`).
// Stub the domain's tRPC view + the react-query client so the render stays a
// pure component test: `queryOptions` carries the input into `queryFn`, and
// `fetchQuery` just runs it. `getActionRunsMock` is the swappable data source
// (the old `window.api.history.getAutomationActionRuns` mock).
const getActionRunsMock = vi.fn()

vi.mock('./trpc', () => ({
  useTRPC: () => ({
    history: {
      getAutomationActionRuns: {
        queryOptions: (input: { runId: string }) => ({
          queryKey: ['history', 'getAutomationActionRuns', input],
          queryFn: () => getActionRunsMock(input.runId)
        })
      }
    }
  })
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    fetchQuery: (opts: { queryFn: () => unknown }) => opts.queryFn()
  })
}))

import { AutomationCard } from './AutomationCard'

afterEach(cleanup)

const automation: Automation = {
  id: 'automation-1',
  project_id: 'project-1',
  name: 'Auto close stale tasks',
  description: 'Closes tasks that have been sitting in review for too long.',
  enabled: true,
  trigger_config: {
    type: 'task_status_change',
    params: { fromStatus: 'in_review', toStatus: 'done' }
  },
  conditions: [],
  actions: [{ type: 'run_command', params: { command: 'printf close' } }],
  run_count: 3,
  last_run_at: '2026-03-31T11:00:00.000Z',
  catchup_on_start: false,
  sort_order: 0,
  created_at: '2026-03-31T10:00:00.000Z',
  updated_at: '2026-03-31T10:00:00.000Z'
}

beforeEach(() => {
  getActionRunsMock.mockReset()
  getActionRunsMock.mockResolvedValue([
    {
      id: 'step-1',
      runId: 'run-1',
      automationId: automation.id,
      taskId: 'task-1',
      projectId: automation.project_id,
      actionIndex: 0,
      actionType: 'run_command',
      command: 'printf close',
      status: 'success',
      outputTail: 'close',
      error: null,
      startedAt: '2026-03-31T11:00:00.000Z',
      completedAt: '2026-03-31T11:00:01.000Z',
      durationMs: 1000
    }
  ])
})

describe('AutomationCard', () => {
  it('renders the current collapsed card controls', () => {
    render(
      <AutomationCard
        automation={automation}
        onToggle={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onRunManual={vi.fn()}
        onLoadRuns={vi.fn().mockResolvedValue([])}
      />
    )

    expect(screen.getByRole('button', { name: 'Expand automation details' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Auto close stale tasks' })).toBeDefined()
    expect(screen.getByRole('switch')).toBeDefined()
    expect(screen.queryByText('Succeeded')).toBeNull()
  })

  it('expands recent runs and loads action details for a run item', async () => {
    const onLoadRuns = vi.fn().mockResolvedValue([
      {
        id: 'run-1',
        automation_id: automation.id,
        trigger_event: null,
        status: 'success',
        error: 'Partial warning',
        duration_ms: 1200,
        started_at: '2026-03-31T11:00:00.000Z',
        completed_at: '2026-03-31T11:00:01.200Z'
      }
    ])

    render(
      <AutomationCard
        automation={automation}
        onToggle={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onRunManual={vi.fn()}
        onLoadRuns={onLoadRuns}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand automation details' }))

    await waitFor(() => {
      expect(screen.getByText('Succeeded')).toBeDefined()
    })

    expect(onLoadRuns).toHaveBeenCalledWith(automation.id)
    expect(screen.getByTestId('automation-run-marker-success')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Show run action details' }))

    await waitFor(() => {
      expect(screen.getByText('printf close')).toBeDefined()
    })

    expect(screen.getByText('Partial warning')).toBeDefined()
    expect(screen.getByTestId('automation-step-marker-success')).toBeDefined()
    expect(screen.getByTestId('automation-step-marker-output')).toBeDefined()
    expect(screen.queryByText('Step 1')).toBeNull()
    expect(screen.queryByText('Output')).toBeNull()
    expect(screen.getAllByText('close').length).toBeGreaterThan(0)
  })
})

// A new run (run_count bump from the parent) resets the loaded run state: details
// collapse, cached action runs are dropped, and an expanded card reloads its runs.
describe('AutomationCard run_count reset', () => {
  const run = (id: string): AutomationRun => ({
    id,
    automation_id: automation.id,
    trigger_event: null,
    status: 'success',
    error: null,
    duration_ms: 10,
    started_at: '2026-03-31T11:00:00.000Z',
    completed_at: '2026-03-31T11:00:01.000Z'
  })
  const loader = (runs: AutomationRun[]) =>
    vi.fn<(automationId: string) => Promise<AutomationRun[]>>().mockResolvedValue(runs)

  function renderCard(onLoadRuns: ReturnType<typeof loader>, runCount = 3) {
    const props = {
      onToggle: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onDuplicate: vi.fn(),
      onRunManual: vi.fn(),
      onLoadRuns
    }
    const view = render(
      <AutomationCard automation={{ ...automation, run_count: runCount }} {...props} />
    )
    return {
      setRunCount: (n: number) =>
        view.rerender(<AutomationCard automation={{ ...automation, run_count: n }} {...props} />)
    }
  }

  async function expandAndShowDetails(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: 'Expand automation details' }))
    await waitFor(() => expect(screen.getByText('Show details')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Show run action details' }))
    await waitFor(() => expect(screen.getByText('printf close')).toBeDefined())
  }

  it('expanded + loaded: collapses details, drops action runs, reloads runs once', async () => {
    const onLoadRuns = loader([run('run-1')])
    const card = renderCard(onLoadRuns)
    await expandAndShowDetails()
    expect(onLoadRuns).toHaveBeenCalledTimes(1)
    expect(getActionRunsMock).toHaveBeenCalledTimes(1)

    onLoadRuns.mockResolvedValue([run('run-2'), run('run-1')])
    await act(async () => card.setRunCount(4))
    expect(onLoadRuns).toHaveBeenCalledTimes(2)
    expect(onLoadRuns).toHaveBeenLastCalledWith(automation.id)
    expect(screen.queryByText('printf close')).toBeNull()
    expect(screen.getAllByText('Show details')).toHaveLength(2)

    // Action runs were dropped, so showing details fetches them again.
    fireEvent.click(screen.getAllByRole('button', { name: 'Show run action details' })[1])
    await waitFor(() => expect(screen.getByText('printf close')).toBeDefined())
    expect(getActionRunsMock).toHaveBeenCalledTimes(2)
  })

  it('a second bump before any re-expand does not reload again', async () => {
    const onLoadRuns = loader([run('run-1')])
    const card = renderCard(onLoadRuns)
    await expandAndShowDetails()
    await act(async () => card.setRunCount(4))
    await act(async () => card.setRunCount(5))
    expect(onLoadRuns).toHaveBeenCalledTimes(2)
  })

  it('collapsed after loading: no reload until the next expand', async () => {
    const onLoadRuns = loader([run('run-1')])
    const card = renderCard(onLoadRuns)
    await expandAndShowDetails()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse automation details' }))
    await act(async () => card.setRunCount(4))
    expect(onLoadRuns).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Expand automation details' }))
    await waitFor(() => expect(onLoadRuns).toHaveBeenCalledTimes(2))
  })

  it('never loaded: a bump does nothing', async () => {
    const onLoadRuns = loader([run('run-1')])
    const card = renderCard(onLoadRuns)
    await act(async () => card.setRunCount(4))
    expect(onLoadRuns).not.toHaveBeenCalled()
  })

  it('a re-render with the same run_count keeps details open', async () => {
    const onLoadRuns = loader([run('run-1')])
    const card = renderCard(onLoadRuns)
    await expandAndShowDetails()
    await act(async () => card.setRunCount(3))
    expect(screen.getByText('printf close')).toBeDefined()
    expect(onLoadRuns).toHaveBeenCalledTimes(1)
  })
})
