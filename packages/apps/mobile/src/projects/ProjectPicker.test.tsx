import { render, screen, userEvent, within } from '@testing-library/react-native'
import type { HubFeed } from '../hub-board'
import { boardOf, feedOf, homeHub, projectOf, workHub } from '../hubs/testing'
import { ProjectPicker } from './ProjectPicker'

const mockFeeds: { list: HubFeed[] } = { list: [] }
jest.mock('../hub-connections', () => ({
  useHubFeeds: () => ({ feeds: mockFeeds.list, retry: () => undefined, clientFor: () => null })
}))

beforeEach(() => {
  mockFeeds.list = [
    feedOf(homeHub, boardOf({ projects: [projectOf('same', { name: 'Site' })] })),
    feedOf(
      workHub,
      boardOf({ projects: [projectOf('same', { name: 'API' }), projectOf('w2', { name: 'Docs' })] })
    )
  ]
})

describe('ProjectPicker', () => {
  it("lists every signed-in hub's projects under their hub", async () => {
    await render(<ProjectPicker visible selected={null} onSelect={jest.fn()} onClose={jest.fn()} />)
    const sheet = within(screen.getByTestId('project-picker'))
    expect(sheet.getByText(homeHub.label)).toBeOnTheScreen()
    expect(sheet.getByText(workHub.label)).toBeOnTheScreen()
    expect(sheet.getByText('Site')).toBeOnTheScreen()
    expect(sheet.getByText('Docs')).toBeOnTheScreen()
  })

  it('hands back the hub AND the project picked (two hubs may share a project id)', async () => {
    const onSelect = jest.fn()
    const onClose = jest.fn()
    await render(<ProjectPicker visible selected={null} onSelect={onSelect} onClose={onClose} />)
    await userEvent.setup().press(screen.getByText('API'))
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        hubId: workHub.id,
        project: expect.objectContaining({ id: 'same' })
      })
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('marks the project selected now, on its own hub only', async () => {
    await render(
      <ProjectPicker
        visible
        selected={{ hubId: workHub.id, projectId: 'same' }}
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />
    )
    expect(screen.getByTestId(`project-${workHub.id}-same`)).toBeSelected()
    expect(screen.getByTestId(`project-${homeHub.id}-same`)).not.toBeSelected()
  })

  it('says when a hub is still loading or has no projects', async () => {
    mockFeeds.list = [feedOf(homeHub, undefined), feedOf(workHub, boardOf({}))]
    await render(<ProjectPicker visible selected={null} onSelect={jest.fn()} onClose={jest.fn()} />)
    expect(screen.getByText('Loading…')).toBeOnTheScreen()
    expect(screen.getByText('No projects')).toBeOnTheScreen()
  })
})
