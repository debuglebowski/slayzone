// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AutomationCard } from './AutomationCard'
import type { Automation } from '@slayzone/automations/shared'

afterEach(cleanup)

const automation: Automation = {
  id: 'automation-1',
  project_id: 'project-1',
  name: 'Auto close stale tasks',
  description: 'Closes tasks that have been sitting in review for too long.',
  enabled: true,
  trigger_config: {
    type: 'task_status_change',
    params: { fromStatus: 'in_review', toStatus: 'done' },
  },
  conditions: [],
  actions: [
    { type: 'run_command', params: { command: 'printf close' } },
  ],
  run_count: 3,
  last_run_at: '2026-03-31T11:00:00.000Z',
  sort_order: 0,
  created_at: '2026-03-31T10:00:00.000Z',
  updated_at: '2026-03-31T10:00:00.000Z',
}

beforeEach(() => {
  window.api = {
    history: {
      getAutomationActionRuns: vi.fn().mockResolvedValue([
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
          durationMs: 1000,
        },
      ]),
    },
  } as any
})

describe('AutomationCard', () => {
  it('renders a structured summary with status and configuration metadata', () => {
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

    expect(screen.getByText('Auto close stale tasks')).toBeDefined()
    expect(screen.getByText('Active')).toBeDefined()
    expect(screen.getByText('Task status')).toBeDefined()
    expect(screen.getByText('Run command')).toBeDefined()
    expect(screen.getByText('3 runs')).toBeDefined()
    expect(screen.getByText('Closes tasks that have been sitting in review for too long.')).toBeDefined()
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
        completed_at: '2026-03-31T11:00:01.200Z',
      },
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
