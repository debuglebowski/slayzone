import { render, screen, userEvent, within } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import type { HubFeed } from '../hub-board'
import {
  boardOf,
  createFakeHubs,
  feedOf,
  homeHub,
  projectOf,
  taskOf,
  workHub
} from '../hubs/testing'
import { ProjectsScreen } from './ProjectsScreen'

const mockHubs = createFakeHubs()
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  HubScope: (props: { hubId: string; fallback?: ReactNode; children: ReactNode }) =>
    mockHubs.HubScope(props)
}))

function feeds(): HubFeed[] {
  return [
    feedOf(homeHub, boardOf({ projects: [projectOf('h1', { name: 'Site' })] })),
    feedOf(
      workHub,
      boardOf({
        projects: [projectOf('w1', { name: 'API' })],
        tasks: [taskOf('t1', { title: 'Add auth', project_id: 'w1' })]
      })
    )
  ]
}

beforeEach(() => {
  for (const hub of [homeHub, workHub]) {
    mockHubs.serve(hub.id, {
      procedures: { 'computers.list': () => [] },
      subscriptions: { 'computers.onStatusChange': () => undefined }
    })
  }
})

function setup(
  layout: 'list' | 'split',
  selected: { hubId: string; projectId: string } | null = null
) {
  const handlers = { onSelect: jest.fn(), onOpenTask: jest.fn(), onBack: jest.fn() }
  const ui = <ProjectsScreen feeds={feeds()} layout={layout} selected={selected} {...handlers} />
  return { ui, handlers }
}

describe('ProjectsScreen', () => {
  it("lists every hub's projects; a phone opens a tapped one", async () => {
    const { ui, handlers } = setup('list')
    await render(ui)
    expect(screen.queryByTestId('project-detail-w1')).toBeNull()
    await userEvent.setup().press(screen.getByText('API'))
    expect(handlers.onSelect).toHaveBeenCalledWith(expect.objectContaining({ hubId: workHub.id }))
  })

  it('shows the selected project beside the list on a wide screen', async () => {
    const { ui } = setup('split', { hubId: workHub.id, projectId: 'w1' })
    await render(ui)
    const detail = within(screen.getByTestId('project-detail-w1'))
    expect(detail.getByText('Add auth')).toBeOnTheScreen()
  })

  it('shows the first project when none is selected', async () => {
    const { ui } = setup('split')
    await render(ui)
    expect(screen.getByTestId('project-detail-h1')).toBeOnTheScreen()
  })

  it('opens a task of the project', async () => {
    const { ui, handlers } = setup('split', { hubId: workHub.id, projectId: 'w1' })
    await render(ui)
    await userEvent.setup().press(screen.getByText('Add auth'))
    expect(handlers.onOpenTask).toHaveBeenCalledWith(
      expect.objectContaining({ hubId: workHub.id, task: expect.objectContaining({ id: 't1' }) })
    )
  })
})
