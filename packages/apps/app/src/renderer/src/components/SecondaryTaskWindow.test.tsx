// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createTrpcTest } from '@slayzone/transport/testing'
import { TooltipProvider } from '@slayzone/ui'

const fetchTaskDetail = vi.hoisted(() => vi.fn())
vi.mock('@slayzone/task/client/taskDetailCache', () => ({ fetchTaskDetail }))
vi.mock('@slayzone/task/client/TaskShell', () => ({
  TaskShell: () => <div data-testid="shell" />
}))
vi.mock('@slayzone/task/client/TaskDetailPage', () => ({
  TaskDetailPage: (props: { taskId: string; task: { title: string } }) => (
    <div data-testid="page">
      {props.taskId}:{props.task.title}
    </div>
  )
}))
vi.mock('@/components/usage/BoostPill', () => ({ BoostPill: () => null }))
vi.mock('@/components/usage/UsagePopover', () => ({ UsagePopover: () => null }))
vi.mock('@/components/usage/useUsage', () => ({
  useUsage: () => ({ data: null, refresh: () => {} })
}))

import { SecondaryTaskWindow } from './SecondaryTaskWindow'

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

function renderWindow() {
  const { wrapper: Wrapper } = createTrpcTest({
    procedures: { 'app.taskWindows.getPrimaryActive': () => null },
    subscriptions: { 'app.taskWindows.onPrimaryActiveChanged': () => () => undefined }
  })
  return render(
    <Wrapper>
      <TooltipProvider>
        <SecondaryTaskWindow taskId="t1" />
      </TooltipProvider>
    </Wrapper>
  )
}

beforeEach(() => {
  fetchTaskDetail.mockReset()
  document.title = 'start'
})

afterEach(() => {
  cleanup()
})

describe('SecondaryTaskWindow load', () => {
  it('shows the shell, then the task page, and titles the window', async () => {
    fetchTaskDetail.mockResolvedValue({ task: { title: 'Fix bug' }, project: null })
    renderWindow()
    expect(screen.getByTestId('shell')).toBeTruthy()
    await flush()
    expect(fetchTaskDetail).toHaveBeenCalledWith('t1')
    expect(screen.getByTestId('page').textContent).toBe('t1:Fix bug')
    expect(document.title).toBe('Fix bug — SlayZone')
  })

  it('missing task → not-found error', async () => {
    fetchTaskDetail.mockResolvedValue(null)
    renderWindow()
    await flush()
    expect(screen.getByText('Task not found: t1')).toBeTruthy()
    expect(document.title).toBe('start')
  })

  it('failed fetch → the error text', async () => {
    fetchTaskDetail.mockRejectedValue(new Error('boom'))
    renderWindow()
    await flush()
    expect(screen.getByText('Error: boom')).toBeTruthy()
  })
})
