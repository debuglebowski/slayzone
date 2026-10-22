// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import React from 'react'
import { afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@slayzone/ui'
import { TaskSettingsPanel } from './TaskSettingsPanel'

afterEach(cleanup)

// The header action renders a Tooltip, which needs the provider the app mounts at the root.
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <TooltipProvider>{children}</TooltipProvider>
)

describe('TaskSettingsPanel', () => {
  it('switches to activity and back from the header action', () => {
    render(
      <TaskSettingsPanel
        taskId="task-1"
        renderDefaultContent={() => <div>Settings body</div>}
        renderHistoryContent={() => <div>History body</div>}
      />,
      { wrapper }
    )

    expect(screen.getByText('View activity')).toBeDefined()
    fireEvent.click(screen.getByText('View activity'))
    expect(screen.queryByText('View activity')).toBeNull()
    expect(screen.getByText('Back to settings')).toBeDefined()
    expect(screen.getByText('History body')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Back to settings' }))
    expect(screen.getByText('View activity')).toBeDefined()
  })

  it('resets to default view when the task changes', () => {
    const { rerender } = render(
      <TaskSettingsPanel
        taskId="task-1"
        renderDefaultContent={() => <div>Settings body</div>}
        renderHistoryContent={() => <div>History body</div>}
      />,
      { wrapper }
    )

    fireEvent.click(screen.getByText('View activity'))
    expect(screen.getByText('History body')).toBeDefined()

    rerender(
      <TaskSettingsPanel
        taskId="task-2"
        renderDefaultContent={() => <div>Settings body</div>}
        renderHistoryContent={() => <div>History body</div>}
      />
    )

    expect(screen.getByText('View activity')).toBeDefined()
    expect(screen.queryByText('History body')).toBeNull()
  })

  it('keeps the header action on the right and updates its copy by view', () => {
    render(
      <TaskSettingsPanel
        taskId="task-1"
        renderDefaultContent={() => <div>Settings body</div>}
        renderHistoryContent={() => <div>History body</div>}
      />,
      { wrapper }
    )

    expect(screen.getByText('Settings body')).toBeDefined()
    expect(screen.getByRole('button', { name: 'View activity' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'View activity' }))
    expect(screen.getByRole('button', { name: 'Back to settings' })).toBeDefined()
  })
})
