import type { HubConnection } from '@slayzone/transport/client'
import { render, screen, userEvent, within } from '@testing-library/react-native'
import type { BoardData, BoardTask, HubFeed } from './hub-board'
import { hubEntryOf } from './hub-session'
import { TaskBrowser, type TaskBrowserProps } from './TaskBrowser'

const home = hubEntryOf('home.example')
const work = hubEntryOf('work.example')

const OPEN: HubConnection = { status: 'open', error: null }
const FAILED: HubConnection = { status: 'connecting', error: new Error('WebSocket closed') }

function boardOf(projectName: string, ...titles: string[]): BoardData {
  return {
    tasks: titles.map(
      (title, i) =>
        ({
          id: `t${i}`,
          title,
          status: 'todo',
          priority: 2,
          project_id: 'p1',
          parent_id: null,
          description: `About ${title}`
        }) as BoardTask
    ),
    projects: [{ id: 'p1', name: projectName, color: null }],
    tags: [],
    taskTags: {},
    blockedTaskIds: []
  } as unknown as BoardData
}

const loading = (hub: typeof home): HubFeed => ({
  hub,
  connection: OPEN,
  stalled: false,
  board: { data: undefined, pending: true, error: null, refreshing: false }
})
const loaded = (hub: typeof home, data: BoardData): HubFeed => ({
  hub,
  connection: OPEN,
  stalled: false,
  board: { data, pending: false, error: null, refreshing: false }
})
const unreachable = (hub: typeof home): HubFeed => ({
  hub,
  connection: FAILED,
  stalled: true,
  board: { data: undefined, pending: true, error: null, refreshing: false }
})

function props(fields: Partial<TaskBrowserProps>): TaskBrowserProps {
  return {
    feeds: [],
    layout: 'list',
    selected: null,
    onSelect: jest.fn(),
    onRetry: jest.fn(),
    onSignOut: jest.fn(),
    onManageHubs: jest.fn(),
    ...fields
  }
}

describe('TaskBrowser', () => {
  // A session whose hub is gone must still be able to sign out: Sign out stays while
  // the board loads and when it fails (fix of 2026-10-29).
  it('offers Sign out while the board is loading', async () => {
    const p = props({ feeds: [loading(home)] })
    await render(<TaskBrowser {...p} />)

    await userEvent.setup().press(screen.getByText('Sign out'))
    expect(p.onSignOut).toHaveBeenCalledWith(home.id)
  })

  it("says when a hub can't be reached, with Retry and Sign out", async () => {
    const p = props({ feeds: [unreachable(home)] })
    await render(<TaskBrowser {...p} />)

    const banner = within(screen.getByTestId(`hub-banner-${home.id}`))
    expect(banner.getByText("Can't reach home.example")).toBeOnTheScreen()
    const user = userEvent.setup()
    await user.press(banner.getByText('Retry'))
    expect(p.onRetry).toHaveBeenCalledWith(home.id)
    await user.press(banner.getByText('Sign out'))
    expect(p.onSignOut).toHaveBeenCalledWith(home.id)
  })

  it('offers Sign out when a connected hub refuses the board', async () => {
    const refused: HubFeed = {
      ...loaded(home, boardOf('Home')),
      board: {
        data: undefined,
        pending: false,
        error: 'hub requires authentication',
        refreshing: false
      }
    }
    const p = props({ feeds: [refused] })
    await render(<TaskBrowser {...p} />)

    const banner = within(screen.getByTestId(`hub-banner-${home.id}`))
    expect(banner.getByText('hub requires authentication')).toBeOnTheScreen()
    await userEvent.setup().press(banner.getByText('Sign out'))
    expect(p.onSignOut).toHaveBeenCalledWith(home.id)
  })

  it("lists every hub's tasks in one list, each tagged with its hub", async () => {
    const p = props({
      feeds: [loaded(home, boardOf('Home', 'Write spec')), loaded(work, boardOf('Work', 'Ship'))]
    })
    await render(<TaskBrowser {...p} />)

    expect(screen.getByText('Write spec')).toBeOnTheScreen()
    expect(screen.getByText('Ship')).toBeOnTheScreen()
    expect(screen.getByText('Home · todo · home.example')).toBeOnTheScreen()
    expect(screen.getByText('Work · todo · work.example')).toBeOnTheScreen()
  })

  it("keeps showing the reachable hubs' tasks while another can't be reached", async () => {
    const p = props({ feeds: [unreachable(home), loaded(work, boardOf('Work', 'Ship'))] })
    await render(<TaskBrowser {...p} />)

    expect(screen.getByText('Ship')).toBeOnTheScreen()
    expect(screen.getByText("Can't reach home.example")).toBeOnTheScreen()
  })

  it('opens a task with its hub (two hubs may share task ids)', async () => {
    const p = props({
      feeds: [loaded(home, boardOf('Home', 'Same')), loaded(work, boardOf('Work', 'Same'))]
    })
    await render(<TaskBrowser {...p} />)

    await userEvent.setup().press(screen.getAllByText('Same')[1])
    expect(p.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ hubId: work.id, task: expect.objectContaining({ id: 't0' }) })
    )
  })

  it('on a wide screen shows the selected task beside the list', async () => {
    const p = props({
      layout: 'split',
      feeds: [loaded(home, boardOf('Home', 'First', 'Second'))],
      selected: { hubId: home.id, taskId: 't1' }
    })
    await render(<TaskBrowser {...p} />)

    expect(screen.getByText('About Second')).toBeOnTheScreen()
    expect(screen.queryByText('About First')).toBeNull()
  })

  it('on a wide screen shows the first task until one is picked', async () => {
    const p = props({ layout: 'split', feeds: [loaded(home, boardOf('Home', 'First', 'Second'))] })
    await render(<TaskBrowser {...p} />)
    expect(screen.getByText('About First')).toBeOnTheScreen()
  })

  it('opens the hubs screen', async () => {
    const p = props({ feeds: [loaded(home, boardOf('Home'))] })
    await render(<TaskBrowser {...p} />)
    await userEvent.setup().press(screen.getByText('Hubs'))
    expect(p.onManageHubs).toHaveBeenCalled()
  })
})
