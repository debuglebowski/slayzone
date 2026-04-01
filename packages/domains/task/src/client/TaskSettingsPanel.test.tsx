// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import React from 'react'
import { afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TaskSettingsPanel } from './TaskSettingsPanel'

afterEach(cleanup)

describe('TaskSettingsPanel', () => {
  it('switches to history and back from the header action', () => {
    render(
      <TaskSettingsPanel
        taskId="task-1"
        renderDefaultContent={() => <div>Settings body</div>}
        renderHistoryContent={() => <div>History body</div>}
      />
    )

    expect(screen.getByText('View history')).toBeDefined()
    fireEvent.click(screen.getByText('View history'))
    expect(screen.queryByText('View history')).toBeNull()
    expect(screen.getByText('Back to settings')).toBeDefined()
    expect(screen.getByText('History body')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Back to settings' }))
    expect(screen.getByText('View history')).toBeDefined()
  })

  it('resets to default view when the task changes', () => {
    const { rerender } = render(
      <TaskSettingsPanel
        taskId="task-1"
        renderDefaultContent={() => <div>Settings body</div>}
        renderHistoryContent={() => <div>History body</div>}
      />
    )

    fireEvent.click(screen.getByText('View history'))
    expect(screen.getByText('History body')).toBeDefined()

    rerender(
      <TaskSettingsPanel
        taskId="task-2"
        renderDefaultContent={() => <div>Settings body</div>}
        renderHistoryContent={() => <div>History body</div>}
      />
    )

    expect(screen.getByText('View history')).toBeDefined()
    expect(screen.queryByText('History body')).toBeNull()
  })

  it('keeps the header action on the right and updates its copy by view', () => {
    render(
      <TaskSettingsPanel
        taskId="task-1"
        renderDefaultContent={() => <div>Settings body</div>}
        renderHistoryContent={() => <div>History body</div>}
      />
    )

    expect(screen.getByText('Settings body')).toBeDefined()
    expect(screen.getByRole('button', { name: 'View history' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'View history' }))
    expect(screen.getByRole('button', { name: 'Back to settings' })).toBeDefined()
  })
})
