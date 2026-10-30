/**
 * The app's screens as Expo Router mounts them (the real `src/app` routes and root
 * layout): the signed-in guard, deep links, and which screen a route opens. Hub data
 * is faked at the module boundary — sessions (`hub-session`), feeds
 * (`hub-connections`), the hub theme reader — so no socket opens.
 */
import { userEvent } from '@testing-library/react-native'
import { act, renderRouter, screen } from 'expo-router/testing-library'
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
  board: { data: board, pending: false, error: null, refreshing: false }
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

  it('opens an agent route (a placeholder until the agents phase)', async () => {
    mockSessions.kept = [home]
    await renderRouter(ROUTES, { initialUrl: '/agent/home.example/s1' })
    expect(
      await screen.findByText('Agent sessions on home.example will open here.')
    ).toBeOnTheScreen()
  })
})
