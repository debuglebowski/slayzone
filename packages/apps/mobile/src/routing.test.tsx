/**
 * The app's screens as Expo Router mounts them (the real `src/app` routes and root
 * layout): the signed-in guard, deep links, and which screen a route opens. Hub data
 * is faked at the module boundary — sessions (`hub-session`), feeds
 * (`hub-connections`), the hub theme reader — so no socket opens.
 */
import { userEvent } from '@testing-library/react-native'
import { act, renderRouter, screen, within } from 'expo-router/testing-library'
import type { ReactNode } from 'react'
import { Dimensions } from 'react-native'
import type { BoardData, HubFeed } from './hub-board'
import type { HubSession } from './hub-session'

const mockSessions: { kept: HubSession[] } = { kept: [] }
const mockFeeds: { list: HubFeed[] } = { list: [] }

jest.mock('./hub-session', () => {
  const actual = jest.requireActual('./hub-session')
  return {
    ...actual,
    hubSessions: {
      restore: async () => mockSessions.kept,
      save: async () => undefined,
      forget: async () => undefined
    }
  }
})
jest.mock('./hub-connections', () => ({
  HubConnections: ({ children }: { children: ReactNode }) => children,
  useHubFeeds: () => ({ feeds: mockFeeds.list, retry: () => undefined, clientFor: () => null })
}))
// The agent screen talks to its hub (tRPC); here only which one a route opens matters.
jest.mock('./agents/AgentScreen', () => ({
  AgentScreen: (props: { feed: HubFeed; taskId: string; tabId?: string }) => {
    const { Text } = jest.requireActual('react-native')
    return (
      <Text>{`agent screen ${props.feed.hub.label} ${props.taskId} ${props.tabId ?? 'main'}`}</Text>
    )
  }
}))
jest.mock('./hub-theme', () => ({
  HubThemeProvider: ({ children }: { children: ReactNode }) => children
}))
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  HubScope: ({ children }: { children: ReactNode }) => children
}))

const { hubEntryOf } = jest.requireActual('./hub-session') as typeof import('./hub-session')
const home: HubSession = { entry: hubEntryOf('home.example'), token: 't' }

const board = {
  tasks: [
    {
      id: 't0',
      title: 'Write spec',
      status: 'todo',
      priority: 2,
      project_id: 'p',
      parent_id: null,
      description: 'Spec notes'
    }
  ],
  projects: [{ id: 'p', name: 'Home', color: null }],
  tags: [],
  taskTags: {},
  blockedTaskIds: []
} as unknown as BoardData

const homeFeed: HubFeed = {
  hub: home.entry,
  connection: { status: 'open', error: null },
  stalled: false,
  board: { data: board, pending: false, error: null, refreshing: false },
  agents: {
    state: { byId: {}, hibernated: {}, lastPushedAt: {}, jobsById: {} },
    loaded: true,
    error: null
  }
}

/** Home's feed, with task t0's main agent running. */
const homeWithAgent: HubFeed = {
  ...homeFeed,
  agents: { ...homeFeed.agents, state: { ...homeFeed.agents.state, byId: { 't0:t0': 'running' } } }
}

/** A phone-sized window (the default test window is 750 wide: an iPad split). */
function phone() {
  const window = { width: 390, height: 844, scale: 3, fontScale: 1 }
  Dimensions.set({ window, screen: window })
}
function tablet() {
  const window = { width: 1024, height: 1366, scale: 2, fontScale: 1 }
  Dimensions.set({ window, screen: window })
}

beforeEach(() => {
  mockSessions.kept = []
  mockFeeds.list = []
  phone()
})

const ROUTES = 'src/app'

describe('routing', () => {
  it('signed out, every route leads to sign-in', async () => {
    await renderRouter(ROUTES, { initialUrl: '/task/home.example/t0' })
    expect(await screen.findByText('Sign in to a hub')).toBeOnTheScreen()
    expect(screen).toHavePathname('/sign-in')
  })

  it('signed in, opens home with every hub’s tasks', async () => {
    mockSessions.kept = [home]
    mockFeeds.list = [homeFeed]
    await renderRouter(ROUTES, { initialUrl: '/' })
    expect(await screen.findByText('Write spec')).toBeOnTheScreen()
    expect(screen).toHavePathname('/')
  })

  it('a deep link to a task opens it (phone: its own screen)', async () => {
    mockSessions.kept = [home]
    mockFeeds.list = [homeFeed]
    await renderRouter(ROUTES, { initialUrl: '/task/home.example/t0' })
    expect(await screen.findByText('Spec notes')).toBeOnTheScreen()
    expect(screen).toHavePathname('/task/home.example/t0')
  })

  it('a deep link to a task on an iPad shows it beside the list', async () => {
    tablet()
    mockSessions.kept = [home]
    mockFeeds.list = [homeFeed]
    await renderRouter(ROUTES, { initialUrl: '/task/home.example/t0' })
    expect(await screen.findByText('Spec notes')).toBeOnTheScreen()
    // The row in the list, and the title of the detail beside it.
    expect(screen.getAllByText('Write spec')).toHaveLength(2)
  })

  it('tapping a task on a phone opens its screen', async () => {
    mockSessions.kept = [home]
    mockFeeds.list = [homeFeed]
    await renderRouter(ROUTES, { initialUrl: '/' })
    await userEvent.setup().press(await screen.findByText('Write spec'))
    expect(screen).toHavePathname('/task/home.example/t0')
  })

  it('opens the hubs screen and its sign-in for another hub', async () => {
    mockSessions.kept = [home]
    mockFeeds.list = [homeFeed]
    await renderRouter(ROUTES, { initialUrl: '/' })
    const user = userEvent.setup()
    await user.press(await screen.findByText('Hubs'))
    expect(screen).toHavePathname('/hubs')
    await user.press(screen.getByText('Add a hub'))
    expect(screen).toHavePathname('/add-hub')
    expect(screen.getByText('Sign in to another hub')).toBeOnTheScreen()
  })

  it('signing out of the last hub returns to sign-in', async () => {
    mockSessions.kept = [home]
    mockFeeds.list = [homeFeed]
    await renderRouter(ROUTES, { initialUrl: '/' })
    await userEvent.setup().press(await screen.findByText('Sign out'))
    await act(async () => undefined)
    expect(await screen.findByText('Sign in to a hub')).toBeOnTheScreen()
  })

  it("a deep link to a task's agents opens them on its hub (a tab as ?tab=)", async () => {
    mockSessions.kept = [home]
    mockFeeds.list = [homeFeed]
    await renderRouter(ROUTES, { initialUrl: '/agent/home.example/t0' })
    expect(await screen.findByText('agent screen home.example t0 main')).toBeOnTheScreen()
  })

  it('opens the tab an agent link names', async () => {
    mockSessions.kept = [home]
    mockFeeds.list = [homeFeed]
    await renderRouter(ROUTES, { initialUrl: '/agent/home.example/t0?tab=side' })
    expect(await screen.findByText('agent screen home.example t0 side')).toBeOnTheScreen()
  })

  it('an agent link to a hub the app is not signed in to says so', async () => {
    mockSessions.kept = [home]
    mockFeeds.list = [homeFeed]
    await renderRouter(ROUTES, { initialUrl: '/agent/other.example/t0' })
    expect(await screen.findByText('Not signed in to other.example')).toBeOnTheScreen()
  })

  it('tapping an agent on home opens its agent screen', async () => {
    mockSessions.kept = [home]
    mockFeeds.list = [homeWithAgent]
    await renderRouter(ROUTES, { initialUrl: '/' })
    const agents = await screen.findByTestId('agents-section')
    await userEvent.setup().press(within(agents).getByText('Write spec'))
    expect(screen).toHavePathname('/agent/home.example/t0')
  })

  it('the agents screen lists every agent and opens one', async () => {
    mockSessions.kept = [home]
    mockFeeds.list = [homeWithAgent]
    await renderRouter(ROUTES, { initialUrl: '/agents' })
    expect(await screen.findByText('Running')).toBeOnTheScreen()
    await userEvent.setup().press(screen.getByText('Write spec'))
    expect(screen).toHavePathname('/agent/home.example/t0')
  })
})
