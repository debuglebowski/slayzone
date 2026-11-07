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
import { redirectSystemPath } from './app/+native-intent'

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
// The task page writes to its hub (`task/TaskPage.test.tsx` tests it): here which task,
// which part and which agent tab a route opens, and whether it is the wide layout.
jest.mock('./task/TaskPage', () => ({
  ...jest.requireActual('./task/TaskPage'),
  TaskPage: (p: import('./task/TaskPage').TaskPageProps) => {
    const { Pressable, Text } = jest.requireActual('react-native')
    return (
      <>
        <Text>{`task page ${p.row.hubLabel} ${p.row.task.id} ${p.segment} ${p.agentTabId ?? 'main'}${p.wide ? ' wide' : ''}`}</Text>
        {p.onBack ? (
          <Pressable onPress={p.onBack}>
            <Text>stand-in back</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => p.onSegment('details')}>
          <Text>stand-in details</Text>
        </Pressable>
      </>
    )
  }
}))
// A project's settings talk to its hub (`projects/routing.test.tsx` covers them).
jest.mock('./projects/ProjectScreen', () => ({ ProjectScreen: () => null }))
// Creating writes to a hub (its own suite tests it): here what the route hands it.
jest.mock('./task-edit/NewTaskScreen', () => ({
  NewTaskScreen: (p: import('./task-edit/NewTaskScreen').NewTaskScreenProps) => {
    const { Pressable, Text } = jest.requireActual('react-native')
    return (
      <>
        <Text>{`new task ${p.hubAddress} ${p.projectId} ${p.status ?? '-'} ${p.parentId ?? '-'}`}</Text>
        <Pressable onPress={() => p.onCreated(p.hubAddress, 'new1')}>
          <Text>stand-in create</Text>
        </Pressable>
        <Pressable onPress={p.onCancel}>
          <Text>stand-in cancel</Text>
        </Pressable>
      </>
    )
  }
}))
// Search reads every hub (its own suite tests it); here only that home opens it.
jest.mock('./artifacts/ArtifactSearchScreen', () => ({
  ArtifactSearchScreen: () => {
    const { Text } = jest.requireActual('react-native')
    return <Text>artifact search</Text>
  }
}))
jest.mock('./hub-theme', () => ({
  HubThemeProvider: ({ children }: { children: ReactNode }) => children
}))
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  HubScope: ({ children }: { children: ReactNode }) => children
}))
// A hub card's account and computers talk to that hub (tRPC); here only which screen a
// route opens matters.
jest.mock('./hubs/HubDetails', () => ({ HubDetails: () => null }))
// The board's moves write to its hub (tRPC; `board/*.test.tsx` test them).
jest.mock('./board/use-board-moves', () => ({ useBoardMoves: () => async () => undefined }))
jest.mock('./board/use-archive-all', () => ({ useArchiveAll: () => async () => undefined }))
jest.mock('./board/use-scratch-task', () => ({
  useScratchTask: () => ({ creating: false, create: () => undefined })
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
      description: 'Spec notes',
      order: 0,
      archived_at: null,
      snoozed_until: null,
      is_temporary: false,
      due_date: null
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

/** Home's feed, its hub unreachable (the per-hub banner). */
const homeUnreachable: HubFeed = {
  ...homeFeed,
  connection: { status: 'connecting', error: null },
  board: { data: undefined, pending: false, error: 'connect ECONNREFUSED', refreshing: false }
}

/** Queries inside one tab's stack (every tab stays mounted). */
const tab = (name: 'board' | 'search' | 'settings') => within(screen.getByTestId(`tab-${name}`))

/** A link from outside the app, as Expo Router receives it (`app/+native-intent.tsx`). */
const link = (url: string) => redirectSystemPath({ path: url, initial: true })

const signedIn = (feed: HubFeed = homeFeed) => {
  mockSessions.kept = [home]
  mockFeeds.list = [feed]
}

describe('routing', () => {
  it('signed out, every route leads to sign-in', async () => {
    await renderRouter(ROUTES, { initialUrl: '/task/home.example/t0' })
    expect(await screen.findByText('Sign in to a hub')).toBeOnTheScreen()
    expect(screen).toHavePathname('/sign-in')
  })

  it.each([
    '/',
    '/agents',
    '/tasks',
    '/hubs',
    '/settings',
    '/add-hub',
    '/agent/home.example/t0',
    '/projects',
    '/projects/home.example/p',
    '/artifacts',
    '/artifacts/home.example/t0',
    '/artifacts/home.example/t0/a1'
  ])('signed out, %s leads to sign-in', async (url) => {
    await renderRouter(ROUTES, { initialUrl: url })
    expect(await screen.findByText('Sign in to a hub')).toBeOnTheScreen()
    expect(screen).toHavePathname('/sign-in')
  })

  describe('tabs', () => {
    it("the app opens on the Board tab: the project's board", async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/' })
      expect(await screen.findByText('Write spec')).toBeOnTheScreen()
      expect(screen).toHaveSegments(['(tabs)', '(board)'])
      expect(tab('board').getByTestId('project-switcher')).toHaveTextContent('HHome▾')
    })

    it.each(['/agents', '/tasks', '/projects'])('the old %s link opens the board', async (url) => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: url })
      expect(await screen.findByText('Write spec')).toBeOnTheScreen()
      expect(screen).toHavePathname('/')
    })

    it('Search: tasks and artifacts', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/artifacts' })
      expect(await screen.findByText('artifact search')).toBeOnTheScreen()
      expect(screen).toHaveSegments(['(tabs)', '(search)', 'artifacts'])
    })

    it('Settings: the signed-in hubs, theme, about', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/settings' })
      expect(await screen.findByText('＋ Add a hub')).toBeOnTheScreen()
      expect(screen).toHaveSegments(['(tabs)', '(settings)', 'settings'])
    })

    it('the old /hubs link opens Settings', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/hubs' })
      expect(await screen.findByText('＋ Add a hub')).toBeOnTheScreen()
      expect(screen).toHavePathname('/settings')
    })
  })

  it('the connection banner shows on the board', async () => {
    signedIn(homeUnreachable)
    await renderRouter(ROUTES, { initialUrl: '/' })
    await screen.findAllByTestId(`hub-banner-${home.entry.id}`)
    expect(tab('board').getByTestId(`hub-banner-${home.entry.id}`)).toBeOnTheScreen()
  })

  // Each layout names the screen its stack starts at with `anchor`;
  // `initialRouteName` is deprecated and warns once per layout.
  it('the layouts use no deprecated settings', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    signedIn()
    await renderRouter(ROUTES, { initialUrl: link('slayzone://task/home.example/t0') })
    await screen.findByText('task page home.example t0 agent main')
    const deprecated = warn.mock.calls.filter((args) => String(args[0]).includes('deprecated'))
    warn.mockRestore()
    expect(deprecated).toEqual([])
  })

  describe('the board', () => {
    it('a tapped card opens its task in the Board tab, Agent first (phone); back returns', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/' })
      await userEvent.setup().press(await screen.findByText('Write spec'))
      expect(screen).toHavePathname('/task/home.example/t0')
      expect(screen).toHaveSegments(['(tabs)', '(board)', 'task', '[hub]', '[id]'])
      expect(tab('board').getByText('task page home.example t0 agent main')).toBeOnTheScreen()
      await userEvent.setup().press(tab('board').getByText('stand-in back'))
      expect(screen).toHavePathname('/')
    })

    it('the part of the task shown lives in the route', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/task/home.example/t0' })
      await userEvent.setup().press(await screen.findByText('stand-in details'))
      expect(screen).toHavePathnameWithParams('/task/home.example/t0?segment=details')
      expect(screen.getByText('task page home.example t0 details main')).toBeOnTheScreen()
    })

    it('the floating ＋ long-pressed opens new-task in the Board tab for the shown project and column; created, the task replaces it', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/' })
      await userEvent.setup().longPress(await screen.findByTestId('new-task'))
      expect(await screen.findByText('new task home.example p todo -')).toBeOnTheScreen()
      expect(screen).toHaveSegments(['(tabs)', '(board)', 'new-task'])
      await userEvent.setup().press(screen.getByText('stand-in create'))
      expect(screen).toHavePathname('/task/home.example/new1')
    })

    it('new-task takes a status and parent; Cancel leaves', async () => {
      signedIn()
      await renderRouter(ROUTES, {
        initialUrl: '/new-task?hub=home.example&project=p&status=todo&parent=t0'
      })
      expect(await screen.findByText('new task home.example p todo t0')).toBeOnTheScreen()
      await userEvent.setup().press(screen.getByText('stand-in cancel'))
      expect(screen).toHavePathname('/')
    })

    it("the project switcher's ⋯ opens the project's settings in the Board tab", async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/?sheet=projects' })
      await userEvent.setup().press(await screen.findByTestId('project-settings-p'))
      expect(screen).toHavePathname('/projects/home.example/p')
      expect(screen).toHaveSegments(['(tabs)', '(board)', 'projects', '[hub]', '[id]'])
    })

    it("a link's ?sheet=attention opens the 🔔 sheet; a row opens the task's Agent", async () => {
      signedIn(homeWithAgent)
      await renderRouter(ROUTES, { initialUrl: '/?sheet=attention' })
      await userEvent.setup().press(await screen.findByTestId('attention-row-t0'))
      expect(screen).toHavePathnameWithParams('/task/home.example/t0?segment=agent')
    })

    it('Settings: Add a hub opens in the Settings tab; back returns', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/settings' })
      await userEvent.setup().press(await screen.findByText('＋ Add a hub'))
      expect(screen).toHavePathname('/add-hub')
      expect(screen).toHaveSegments(['(tabs)', '(settings)', 'add-hub'])
      expect(screen.getByText('Sign in to another hub')).toBeOnTheScreen()
      await userEvent.setup().press(screen.getByText('Cancel'))
      expect(screen).toHavePathname('/settings')
    })
  })

  describe('deep links', () => {
    it('a task opens in the Board tab, above the board (phone)', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: link('slayzone://task/home.example/t0') })
      expect(await screen.findByText('task page home.example t0 agent main')).toBeOnTheScreen()
      expect(screen).toHaveSegments(['(tabs)', '(board)', 'task', '[hub]', '[id]'])
      await userEvent.setup().press(tab('board').getByText('stand-in back'))
      expect(screen).toHavePathname('/')
    })

    it("an older agent link opens the task's Agent, with the agent tab it names", async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: link('slayzone://agent/home.example/t0?tab=side') })
      expect(await screen.findByText('task page home.example t0 agent side')).toBeOnTheScreen()
      expect(screen).toHaveSegments(['(tabs)', '(board)', 'task', '[hub]', '[id]'])
    })

    it('on an iPad, a task link opens the task as a tab on the board', async () => {
      tablet()
      signedIn()
      await renderRouter(ROUTES, {
        initialUrl: link('slayzone://task/home.example/t0?segment=artifacts')
      })
      expect(
        await screen.findByText('task page home.example t0 artifacts main wide')
      ).toBeOnTheScreen()
      expect(screen).toHavePathname('/')
      expect(tab('board').getByTestId('open-tab-task-t0')).toBeOnTheScreen()
    })

    it('a task link to a hub the app is not signed in to says so', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: link('slayzone://task/other.example/t0') })
      expect(await screen.findByText('Not signed in to other.example')).toBeOnTheScreen()
    })
  })

  it('on an iPad, a tapped card opens its task as a tab beside the board', async () => {
    tablet()
    signedIn()
    await renderRouter(ROUTES, { initialUrl: '/' })
    await userEvent.setup().press(await tab('board').findByText('Write spec'))
    expect(await screen.findByText('task page home.example t0 details main wide')).toBeOnTheScreen()
    await userEvent.setup().press(tab('board').getByTestId('open-tab-board'))
    expect(tab('board').queryByText(/task page/)).toBeNull()
  })

  // A session whose hub is gone must never trap the user (fix of 2026-10-29): before
  // its board fails (no banner yet), Settings still signs out of it.
  it('while a hub is still loading, Settings signs out of it', async () => {
    signedIn({ ...homeFeed, board: { ...homeFeed.board, data: undefined, pending: true } })
    await renderRouter(ROUTES, { initialUrl: '/settings' })
    await userEvent.setup().press(await tab('settings').findByText('Sign out'))
    await act(async () => undefined)
    expect(await screen.findByText('Sign in to a hub')).toBeOnTheScreen()
  })

  it('signing out of the last hub (Settings) returns to sign-in', async () => {
    signedIn()
    await renderRouter(ROUTES, { initialUrl: '/settings' })
    await userEvent.setup().press(await screen.findByText('Sign out'))
    await act(async () => undefined)
    expect(await screen.findByText('Sign in to a hub')).toBeOnTheScreen()
  })
})
