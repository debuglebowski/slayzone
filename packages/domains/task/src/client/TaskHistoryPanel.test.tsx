// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TaskHistoryPanel } from './TaskHistoryPanel'

afterEach(cleanup)

beforeEach(() => {
  window.api = {
    history: {
      listForTask: vi.fn().mockResolvedValue({
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
            createdAt: '2026-03-31T10:00:00.000Z',
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
            payload: { automationId: 'automation-1', automationName: 'Auto close', status: 'success' },
            createdAt: '2026-03-31T11:00:00.000Z',
          },
        ],
        nextCursor: null,
      }),
      getAutomationActionRuns: vi.fn().mockResolvedValue([
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
          durationMs: 1000,
        },
      ]),
    },
  } as any
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
    ;(window.api.history.listForTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      events: [],
      nextCursor: null,
    })

    render(<TaskHistoryPanel taskId="task-2" />)

    await waitFor(() => {
      expect(screen.getByText('No history yet')).toBeDefined()
    })

    expect(screen.getByText('Task changes and automation activity will appear here once this task starts changing.')).toBeDefined()
  })
})
