// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const data = vi.hoisted(() => ({
  boardStatus: 'success' as 'success' | 'pending' | 'error',
  boardError: null as Error | null,
  projects: [
    { id: 'p1', name: 'SlayZone' },
    { id: 'p2', name: 'Website' }
  ],
  tasks: [{ id: 't1', title: 'Fix login', project_id: 'p1' }]
}))
vi.mock('@slayzone/tasks/client', () => ({ useTasksData: () => data }))

const bridge = vi.hoisted(() => ({ isNative: true, open: vi.fn(), close: vi.fn() }))
vi.mock('./spatial-bridge', () => ({ spatialBridge: () => bridge }))

vi.mock('@slayzone/home/client', () => ({
  HomeContainer: (props: { selectedProjectId: string; onTaskClick: (t: unknown) => void }) => (
    <button onClick={() => props.onTaskClick(data.tasks[0])}>
      board:{props.selectedProjectId}
    </button>
  )
}))
vi.mock('../TaskDetailView', () => ({
  TaskDetailView: (props: {
    taskId: string
    onClose: () => void
    onNavigateToTask: (id: string) => void
  }) => (
    <div>
      <span>task:{props.taskId}</span>
      <button onClick={props.onClose}>close</button>
      <button onClick={() => props.onNavigateToTask('t1')}>sibling</button>
    </div>
  )
}))

import { SpatialApp } from './SpatialApp'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  data.boardStatus = 'success'
})

describe('SpatialApp launcher', () => {
  it('lists every project and opens its board as a new panel', () => {
    render(<SpatialApp route={{ panel: 'launcher' }} />)
    expect(screen.getByText('Website')).toBeTruthy()
    fireEvent.click(screen.getByText('SlayZone'))
    expect(bridge.open).toHaveBeenCalledWith({ panel: 'board', projectId: 'p1' }, 'SlayZone')
  })

  it('shows a connecting state until the board loads', () => {
    data.boardStatus = 'pending'
    render(<SpatialApp route={{ panel: 'launcher' }} />)
    expect(screen.getByText('Connecting…')).toBeTruthy()
  })
})

describe('SpatialApp board panel', () => {
  it('renders the project board and opens a clicked task as its own panel', () => {
    render(<SpatialApp route={{ panel: 'board', projectId: 'p1' }} />)
    fireEvent.click(screen.getByText('board:p1'))
    expect(bridge.open).toHaveBeenCalledWith({ panel: 'task', taskId: 't1' }, 'Fix login')
  })

  it('says so when the project no longer exists', () => {
    render(<SpatialApp route={{ panel: 'board', projectId: 'gone' }} />)
    expect(screen.getByText('Project not found.')).toBeTruthy()
  })
})

describe('SpatialApp task panel', () => {
  it('renders the task and closes its own panel on close', () => {
    render(<SpatialApp route={{ panel: 'task', taskId: 't1' }} />)
    expect(screen.getByText('task:t1')).toBeTruthy()
    fireEvent.click(screen.getByText('close'))
    expect(bridge.close).toHaveBeenCalled()
  })

  it('opens a linked task as another panel', () => {
    render(<SpatialApp route={{ panel: 'task', taskId: 't1' }} />)
    fireEvent.click(screen.getByText('sibling'))
    expect(bridge.open).toHaveBeenCalledWith({ panel: 'task', taskId: 't1' }, 'Fix login')
  })
})
