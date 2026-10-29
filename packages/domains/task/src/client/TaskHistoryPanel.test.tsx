// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React, { Activity } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ActivityEvent, ActivityEventCursor } from '@slayzone/history/shared'

// tRPC client mock — TaskHistoryPanel now calls trpcClient.history.* (imperative
// vanilla client via useTRPCClient) instead of window.api.history.*. The mock
// mirrors the tanstack client shape: nested router → procedure → { query }.
const trpcClientMock = {
  history: {
    listForTask: { query: vi.fn() },
    getAutomationActionRuns: { query: vi.fn() }
  }
}

// The domain's typed view (`./trpc`) re-exports the runtime; point it at this mock.
vi.mock('./trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({
  useTRPCClient: () => trpcClientMock
}))

import { TaskHistoryPanel } from './TaskHistoryPanel'

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  trpcClientMock.history.listForTask.query.mockResolvedValue({
    events: [
      {
        id: 'event-1',
        entityType: 'task',
        entityId: 'task-1',
        projectId: 'project-1',
        taskId: 'task-1',
        kind: 'task.status_changed',
        actorType: 'user',
        source: 'task',
        summary: 'Status changed from Todo to In Progress',
        payload: { from: 'todo', to: 'in_progress' },
        createdAt: '2026-03-31T10:00:00.000Z'
      },
      {
        id: 'event-2',
        entityType: 'automation_run',
        entityId: 'run-1',
        projectId: 'project-1',
        taskId: 'task-1',
        kind: 'automation.run_succeeded',
        actorType: 'automation',
        source: 'automations',
        summary: 'Automation "Auto close" succeeded',
        payload: {
          automationId: 'automation-1',
          automationName: 'Auto close',
          status: 'success'
        },
        createdAt: '2026-03-31T11:00:00.000Z'
      }
    ],
    nextCursor: null
  })
  trpcClientMock.history.getAutomationActionRuns.query.mockResolvedValue([
    {
      id: 'step-1',
      runId: 'run-1',
      automationId: 'automation-1',
      taskId: 'task-1',
      projectId: 'project-1',
      actionIndex: 0,
      actionType: 'run_command',
      command: 'printf success',
      status: 'success',
      outputTail: 'success',
      error: null,
      startedAt: '2026-03-31T11:00:00.000Z',
      completedAt: '2026-03-31T11:00:01.000Z',
      durationMs: 1000
    }
  ])
})

describe('TaskHistoryPanel', () => {
  it('renders task and automation events', async () => {
    render(<TaskHistoryPanel taskId="task-1" />)

    await waitFor(() => {
      expect(screen.getByText('Automation "Auto close" succeeded')).toBeDefined()
    })

    expect(screen.getByText('Status changed from Todo to In Progress')).toBeDefined()
    expect(screen.getByTestId('history-marker-task-status-changed')).toBeDefined()
    expect(screen.getByTestId('history-marker-automation-run-succeeded')).toBeDefined()
  })

  it('loads action steps when expanding an automation event', async () => {
    render(<TaskHistoryPanel taskId="task-1" />)

    await waitFor(() => {
      expect(screen.getByText('Automation "Auto close" succeeded')).toBeDefined()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Show automation run details' }))

    await waitFor(() => {
      expect(screen.getByText('printf success')).toBeDefined()
    })

    expect(screen.getAllByText('success').length).toBeGreaterThan(0)
  })

  it('renders a richer empty state when there is no history', async () => {
    trpcClientMock.history.listForTask.query.mockResolvedValueOnce({
      events: [],
      nextCursor: null
    })

    render(<TaskHistoryPanel taskId="task-2" />)

    await waitFor(() => {
      expect(screen.getByText('No history yet')).toBeDefined()
    })

    expect(
      screen.getByText(
        'Task changes and automation activity will appear here once this task starts changing.'
      )
    ).toBeDefined()
  })
})

// Every history.listForTask call held open until the test lands (or fails) it.
type Page = { events: ActivityEvent[]; nextCursor: ActivityEventCursor | null }
type Call = {
  input: { taskId: string; options: { before?: ActivityEventCursor } }
  resolve: (p: Page) => void
  reject: (e: Error) => void
}
let calls: Call[] = []
function deferPages(): void {
  calls = []
  trpcClientMock.history.listForTask.query.mockImplementation(
    (input: Call['input']) =>
      new Promise<Page>((resolve, reject) => {
        calls.push({ input, resolve, reject })
      })
  )
}

const ev = (id: string, summary: string, run?: string): ActivityEvent =>
  ({
    id,
    entityType: run ? 'automation_run' : 'task',
    entityId: run ?? 'task-1',
    projectId: 'project-1',
    taskId: 'task-1',
    kind: run ? 'automation.run_succeeded' : 'task.status_changed',
    actorType: run ? 'automation' : 'user',
    source: run ? 'automations' : 'task',
    summary,
    payload: {},
    createdAt: '2026-03-31T10:00:00.000Z'
  }) as unknown as ActivityEvent
const cursor = (id: string): ActivityEventCursor => ({
  createdAt: '2026-03-31T10:00:00.000Z',
  id
})

function Tab({ mode, taskId = 'task-1' }: { mode: 'visible' | 'hidden'; taskId?: string }) {
  return (
    <Activity mode={mode}>
      <TaskHistoryPanel taskId={taskId} />
    </Activity>
  )
}
const land = (i: number, page: Page) => act(async () => calls[i].resolve(page))
const fail = (i: number) => act(async () => calls[i].reject(new Error('hub unreachable')))
const loadingShown = () => screen.queryByText('Loading history...') !== null

// Task tabs live in <Activity>. The history panel has no live updates: the page-1
// reload when its tab is shown again is its ONLY refresh. It must keep happening,
// without the reset that used to ride along (spinner, collapsed runs).
describe('TaskHistoryPanel across a tab switch', () => {
  beforeEach(deferPages)

  it('reloads page 1 when the tab is shown again: an event added while away appears', async () => {
    const view = render(<Tab mode="visible" />)
    await land(0, { events: [ev('e1', 'First change')], nextCursor: null })
    expect(screen.getByText('First change')).toBeDefined()

    view.rerender(<Tab mode="hidden" />)
    view.rerender(<Tab mode="visible" />)
    expect(calls).toHaveLength(2)
    expect(calls[1].input).toEqual({ taskId: 'task-1', options: { limit: 50 } })
    await land(1, {
      events: [ev('e2', 'Added while away'), ev('e1', 'First change')],
      nextCursor: null
    })
    expect(screen.getByText('Added while away')).toBeDefined()
    expect(screen.getByText('First change')).toBeDefined()
  })

  it('the reload on show replaces loaded pages with page 1 (as before)', async () => {
    const view = render(<Tab mode="visible" />)
    await land(0, { events: [ev('e1', 'Page one')], nextCursor: cursor('e1') })
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(calls[1].input.options.before).toEqual(cursor('e1'))
    await land(1, { events: [ev('e0', 'Page two')], nextCursor: null })
    expect(screen.getByText('Page two')).toBeDefined()

    view.rerender(<Tab mode="hidden" />)
    view.rerender(<Tab mode="visible" />)
    await land(2, { events: [ev('e1', 'Page one')], nextCursor: cursor('e1') })
    expect(screen.queryByText('Page two')).toBeNull()
    expect(screen.getByText('Page one')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDefined()
  })

  it("a task change shows the spinner, resets expanded runs, and drops the old task's late page", async () => {
    trpcClientMock.history.getAutomationActionRuns.query.mockResolvedValue([])
    const view = render(<Tab mode="visible" />)
    await land(0, { events: [ev('e1', 'Run one', 'run-1')], nextCursor: null })
    fireEvent.click(screen.getByRole('button', { name: 'Show automation run details' }))
    await screen.findByText('No action details.')

    view.rerender(<Tab mode="visible" taskId="task-2" />)
    expect(loadingShown()).toBe(true)
    view.rerender(<Tab mode="visible" taskId="task-3" />)
    expect(calls.map((c) => c.input.taskId)).toEqual(['task-1', 'task-2', 'task-3'])
    await land(2, { events: [ev('e1', 'Run one', 'run-1')], nextCursor: null })
    expect(loadingShown()).toBe(false)
    // Same run id on the new task: collapsed again, its action runs fetched again.
    expect(screen.getByRole('button', { name: 'Show automation run details' })).toBeDefined()
    expect(screen.queryByText('No action details.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show automation run details' }))
    await screen.findByText('No action details.')
    expect(trpcClientMock.history.getAutomationActionRuns.query).toHaveBeenCalledTimes(2)

    // task-2's page lands after task-3's: dropped.
    await land(1, { events: [ev('x', 'Stale task two')], nextCursor: null })
    expect(screen.queryByText('Stale task two')).toBeNull()
  })

  it('keeps the history on screen while it reloads on show (no spinner)', async () => {
    const view = render(<Tab mode="visible" />)
    await land(0, { events: [ev('e1', 'First change')], nextCursor: cursor('e1') })

    view.rerender(<Tab mode="hidden" />)
    view.rerender(<Tab mode="visible" />)
    expect(calls).toHaveLength(2)
    expect(loadingShown()).toBe(false)
    expect(screen.getByText('First change')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDefined()
  })

  it('an expanded automation run stays expanded across a tab switch', async () => {
    const view = render(<Tab mode="visible" />)
    await land(0, { events: [ev('e1', 'Run one', 'run-1')], nextCursor: null })
    fireEvent.click(screen.getByRole('button', { name: 'Show automation run details' }))
    await screen.findByText('printf success')

    view.rerender(<Tab mode="hidden" />)
    view.rerender(<Tab mode="visible" />)
    await land(1, { events: [ev('e1', 'Run one', 'run-1')], nextCursor: null })
    expect(screen.getByRole('button', { name: 'Hide automation run details' })).toBeDefined()
    expect(screen.getByText('printf success')).toBeDefined()
    expect(trpcClientMock.history.getAutomationActionRuns.query).toHaveBeenCalledTimes(1)
  })

  it('a Load more page that no longer continues the list (page 1 reloaded first) is dropped', async () => {
    const view = render(<Tab mode="visible" />)
    await land(0, { events: [ev('e2', 'Page one')], nextCursor: cursor('e2') })
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await land(1, { events: [ev('e1', 'Page two')], nextCursor: cursor('e1') })

    view.rerender(<Tab mode="hidden" />)
    view.rerender(<Tab mode="visible" />)
    // Clicked while page 1 reloads: asks for the page after the list on screen.
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(calls[3].input.options.before).toEqual(cursor('e1'))
    // Page 1 lands first and replaces the list: page three no longer continues it.
    await land(2, { events: [ev('e3', 'New'), ev('e2', 'Page one')], nextCursor: cursor('e2') })
    await land(3, { events: [ev('e0', 'Page three')], nextCursor: null })
    expect(screen.queryByText('Page three')).toBeNull()
    expect(screen.getByText('New')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDefined()
  })

  it('a Load more page that still continues the list after the reload is appended', async () => {
    const view = render(<Tab mode="visible" />)
    await land(0, { events: [ev('e2', 'Page one')], nextCursor: cursor('e2') })
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    // In flight across the switch; page 1 comes back unchanged (same end cursor).
    view.rerender(<Tab mode="hidden" />)
    view.rerender(<Tab mode="visible" />)
    await land(2, { events: [ev('e2', 'Page one')], nextCursor: cursor('e2') })
    await land(1, { events: [ev('e1', 'Page two')], nextCursor: null })
    expect(screen.getByText('Page one')).toBeDefined()
    expect(screen.getByText('Page two')).toBeDefined()
  })
})

// A load that fails (hub briefly unreachable, server error) used to leave its
// loading state on forever: page 1 sat on "Loading history...", a failed "Load
// more" said nothing, and failed run details read as "No action details.".
describe('TaskHistoryPanel when a load fails', () => {
  beforeEach(deferPages)

  const errorShown = () => screen.queryByText("Couldn't load history.") !== null
  const retry = () => fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  const hideAndShow = (view: ReturnType<typeof render>, taskId = 'task-1') => {
    view.rerender(<Tab mode="hidden" taskId={taskId} />)
    view.rerender(<Tab mode="visible" taskId={taskId} />)
  }

  it('a failed first load shows the error, not "Loading history..." forever; Retry loads it', async () => {
    render(<Tab mode="visible" />)
    await fail(0)
    expect(loadingShown()).toBe(false)
    expect(errorShown()).toBe(true)

    retry()
    expect(loadingShown()).toBe(true)
    expect(errorShown()).toBe(false)
    expect(calls).toHaveLength(2)
    expect(calls[1].input).toEqual({ taskId: 'task-1', options: { limit: 50 } })
    await land(1, { events: [ev('e1', 'First change')], nextCursor: null })
    expect(screen.getByText('First change')).toBeDefined()
    expect(errorShown()).toBe(false)
  })

  it('a failed Retry shows the error again', async () => {
    render(<Tab mode="visible" />)
    await fail(0)
    retry()
    await fail(1)
    expect(loadingShown()).toBe(false)
    expect(errorShown()).toBe(true)
  })

  it('the error clears when the tab is shown again and that reload succeeds', async () => {
    const view = render(<Tab mode="visible" />)
    await fail(0)
    expect(errorShown()).toBe(true)

    hideAndShow(view)
    expect(calls).toHaveLength(2)
    await land(1, { events: [ev('e1', 'First change')], nextCursor: null })
    expect(errorShown()).toBe(false)
    expect(screen.getByText('First change')).toBeDefined()
  })

  it('a failed load after a task change shows the error; the next task change clears it to the spinner', async () => {
    const view = render(<Tab mode="visible" />)
    await land(0, { events: [ev('e1', 'Task one change')], nextCursor: null })

    view.rerender(<Tab mode="visible" taskId="task-2" />)
    await fail(1)
    expect(errorShown()).toBe(true)
    expect(screen.queryByText('Task one change')).toBeNull()

    view.rerender(<Tab mode="visible" taskId="task-3" />)
    expect(errorShown()).toBe(false)
    expect(loadingShown()).toBe(true)
    await land(2, { events: [ev('e3', 'Task three change')], nextCursor: null })
    expect(screen.getByText('Task three change')).toBeDefined()
  })

  it("the previous task's failed load never lands on the new task", async () => {
    const view = render(<Tab mode="visible" />)
    view.rerender(<Tab mode="visible" taskId="task-2" />)
    expect(calls.map((c) => c.input.taskId)).toEqual(['task-1', 'task-2'])

    // Before task-2's page lands: the spinner stays.
    await fail(0)
    expect(errorShown()).toBe(false)
    expect(loadingShown()).toBe(true)

    await land(1, { events: [ev('e2', 'Task two change')], nextCursor: null })
    expect(screen.getByText('Task two change')).toBeDefined()
  })

  it('a failed reload on tab show keeps the history on screen; a later show refreshes it', async () => {
    const view = render(<Tab mode="visible" />)
    await land(0, { events: [ev('e1', 'First change')], nextCursor: cursor('e1') })

    hideAndShow(view)
    await fail(1)
    expect(errorShown()).toBe(false)
    expect(loadingShown()).toBe(false)
    expect(screen.getByText('First change')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDefined()

    hideAndShow(view)
    await land(2, {
      events: [ev('e2', 'Added while away'), ev('e1', 'First change')],
      nextCursor: null
    })
    expect(screen.getByText('Added while away')).toBeDefined()
  })

  it('a failed Load more says so; Retry asks for the same page and appends it', async () => {
    render(<Tab mode="visible" />)
    await land(0, { events: [ev('e2', 'Page one')], nextCursor: cursor('e2') })
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await fail(1)
    expect(screen.getByText("Couldn't load more history.")).toBeDefined()
    expect(screen.getByText('Page one')).toBeDefined()

    retry()
    expect(calls[2].input.options.before).toEqual(cursor('e2'))
    expect(screen.queryByText("Couldn't load more history.")).toBeNull()
    expect(screen.getByRole('button', { name: 'Loading more...' })).toBeDefined()
    await land(2, { events: [ev('e1', 'Page two')], nextCursor: null })
    expect(screen.getByText('Page one')).toBeDefined()
    expect(screen.getByText('Page two')).toBeDefined()
    expect(screen.queryByText("Couldn't load more history.")).toBeNull()
  })

  it('a failed Load more for a list replaced meanwhile (page 1 reloaded on show) is dropped', async () => {
    const view = render(<Tab mode="visible" />)
    await land(0, { events: [ev('e2', 'Page one')], nextCursor: cursor('e2') })
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await land(1, { events: [ev('e1', 'Page two')], nextCursor: cursor('e1') })

    hideAndShow(view)
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(calls[3].input.options.before).toEqual(cursor('e1'))
    // Page 1 lands first and replaces the list: the page after e1 no longer continues it.
    await land(2, { events: [ev('e3', 'New'), ev('e2', 'Page one')], nextCursor: cursor('e2') })
    await fail(3)
    expect(screen.queryByText("Couldn't load more history.")).toBeNull()
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDefined()
  })

  it("the previous task's failed Load more never shows on the new task", async () => {
    const view = render(<Tab mode="visible" />)
    await land(0, { events: [ev('e2', 'Task one page')], nextCursor: cursor('e2') })
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    view.rerender(<Tab mode="visible" taskId="task-2" />)
    await land(2, { events: [ev('t2', 'Task two page')], nextCursor: cursor('t2') })
    await fail(1)
    expect(screen.queryByText("Couldn't load more history.")).toBeNull()
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDefined()
  })

  describe('automation run details', () => {
    const detailsQuery = trpcClientMock.history.getAutomationActionRuns.query
    const step = (command: string) => ({
      id: `step-${command}`,
      runId: 'run-1',
      automationId: 'automation-1',
      taskId: 'task-1',
      projectId: 'project-1',
      actionIndex: 0,
      actionType: 'run_command',
      command,
      status: 'success',
      outputTail: null,
      error: null,
      startedAt: '2026-03-31T11:00:00.000Z',
      completedAt: '2026-03-31T11:00:01.000Z',
      durationMs: 1000
    })
    type DetailsCall = { resolve: (runs: unknown[]) => void; reject: (e: Error) => void }
    let details: DetailsCall[] = []
    beforeEach(() => {
      details = []
      detailsQuery.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            details.push({ resolve, reject })
          })
      )
    })
    const showDetails = () =>
      fireEvent.click(screen.getByRole('button', { name: 'Show automation run details' }))
    const detailsErrorShown = () => screen.queryByText("Couldn't load details.") !== null

    it('a failed fetch says so with Retry, never "No action details."; Retry loads them', async () => {
      render(<Tab mode="visible" />)
      await land(0, { events: [ev('e1', 'Run one', 'run-1')], nextCursor: null })
      showDetails()
      expect(screen.getByText('Loading details...')).toBeDefined()
      expect(screen.queryByText('No action details.')).toBeNull()

      await act(async () => details[0].reject(new Error('hub unreachable')))
      expect(detailsErrorShown()).toBe(true)
      expect(screen.queryByText('No action details.')).toBeNull()

      retry()
      expect(detailsQuery).toHaveBeenCalledTimes(2)
      expect(detailsErrorShown()).toBe(false)
      expect(screen.getByText('Loading details...')).toBeDefined()
      await act(async () => details[1].resolve([step('printf retried')]))
      expect(screen.getByText('printf retried')).toBeDefined()
    })

    it('expanding a failed run again retries it', async () => {
      render(<Tab mode="visible" />)
      await land(0, { events: [ev('e1', 'Run one', 'run-1')], nextCursor: null })
      showDetails()
      await act(async () => details[0].reject(new Error('hub unreachable')))
      fireEvent.click(screen.getByRole('button', { name: 'Hide automation run details' }))
      expect(detailsQuery).toHaveBeenCalledTimes(1)

      showDetails()
      expect(detailsQuery).toHaveBeenCalledTimes(2)
      await act(async () => details[1].resolve([step('printf again')]))
      expect(screen.getByText('printf again')).toBeDefined()
    })

    it("the previous task's late details (result or error) never land on the new task", async () => {
      const view = render(<Tab mode="visible" />)
      await land(0, { events: [ev('e1', 'Run one', 'run-1')], nextCursor: null })
      showDetails()
      // Same run id on the new task (as in the task-change test above).
      view.rerender(<Tab mode="visible" taskId="task-2" />)
      await land(1, { events: [ev('e1', 'Run one', 'run-1')], nextCursor: null })
      // task-1's details land after the change: dropped, so expanding fetches again.
      await act(async () => details[0].resolve([step('printf task one')]))
      showDetails()
      expect(detailsQuery).toHaveBeenCalledTimes(2)
      expect(screen.queryByText('printf task one')).toBeNull()
      expect(screen.getByText('Loading details...')).toBeDefined()

      // Its error too: task-2's own fetch is still loading, then lands.
      view.rerender(<Tab mode="visible" taskId="task-3" />)
      await land(2, { events: [ev('e1', 'Run one', 'run-1')], nextCursor: null })
      showDetails()
      await act(async () => details[1].reject(new Error('hub unreachable')))
      expect(detailsErrorShown()).toBe(false)
      await act(async () => details[2].resolve([step('printf task three')]))
      expect(screen.getByText('printf task three')).toBeDefined()
    })
  })
})
