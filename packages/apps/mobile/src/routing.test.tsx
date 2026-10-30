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
// The agent screen talks to its hub (tRPC); here only which one a route opens matters.
jest.mock('./agents/AgentScreen', () => ({
  AgentScreen: (props: { feed: HubFeed; taskId: string; tabId?: string }) => {
    const { Text } = jest.requireActual('react-native')
    return (
      <Text>{`agent screen ${props.feed.hub.label} ${props.taskId} ${props.tabId ?? 'main'}`}</Text>
    )
  }
}))
// The task screen's computer card and artifacts link read their hub (own suites test them).
jest.mock('./computers/TaskComputer', () => ({
  TaskComputer: ({ row }: { row: { task: { id: string } } }) => {
    const { Text } = jest.requireActual('react-native')
    return <Text>{`computer of ${row.task.id}`}</Text>
  }
}))
jest.mock('./artifacts/TaskArtifactsLink', () => ({
  TaskArtifactsLink: (p: { hubAddress: string; taskId: string }) => {
    const { Text } = jest.requireActual('react-native')
    return <Text>{`artifacts of ${p.hubAddress} ${p.taskId}`}</Text>
  }
}))
// The task editor writes to its hub (its own suites test it): here its title, notes and
// the cards it is handed.
jest.mock('./task-edit/TaskEditor', () => ({
  TaskEditor: (p: import('./task-edit/TaskEditor').TaskEditorProps) => {
    const { Text } = jest.requireActual('react-native')
    return (
      <>
        <Text>{p.row.task.title}</Text>
        <Text>{p.row.task.description}</Text>
        {p.children}
      </>
    )
  }
}))
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
const tab = (name: 'agents' | 'tasks' | 'search' | 'hubs') =>
  within(screen.getByTestId(`tab-${name}`))

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
    it('the app opens on the Agents tab', async () => {
      signedIn(homeWithAgent)
      await renderRouter(ROUTES, { initialUrl: '/' })
      expect(await screen.findByText('Running')).toBeOnTheScreen()
      expect(screen).toHaveSegments(['(tabs)', '(agents)'])
    })

    it('the old /agents link opens the Agents tab', async () => {
      signedIn(homeWithAgent)
      await renderRouter(ROUTES, { initialUrl: '/agents' })
      expect(await screen.findByText('Running')).toBeOnTheScreen()
      expect(screen).toHavePathname('/')
    })

    it("Tasks: every hub's tasks", async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/tasks' })
      expect(await screen.findByText('Write spec')).toBeOnTheScreen()
      expect(screen).toHaveSegments(['(tabs)', '(tasks)', 'tasks'])
    })

    it('Search: artifact search', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/artifacts' })
      expect(await screen.findByText('artifact search')).toBeOnTheScreen()
      expect(screen).toHaveSegments(['(tabs)', '(search)', 'artifacts'])
    })

    it('Hubs: the signed-in hubs', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/hubs' })
      expect(await screen.findByText('Add a hub')).toBeOnTheScreen()
      expect(screen).toHaveSegments(['(tabs)', '(hubs)', 'hubs'])
    })

    it('a tab root has no back button', async () => {
      signedIn(homeWithAgent)
      await renderRouter(ROUTES, { initialUrl: '/' })
      await screen.findByText('Running')
      expect(screen.queryByText('‹ Home')).toBeNull()
    })
  })

  describe('the connection banner', () => {
    it.each([
      ['agents', '/'],
      ['tasks', '/tasks']
    ] as const)('shows in the %s tab', async (name, url) => {
      signedIn(homeUnreachable)
      await renderRouter(ROUTES, { initialUrl: url })
      await screen.findAllByTestId(`hub-banner-${home.entry.id}`)
      expect(tab(name).getByTestId(`hub-banner-${home.entry.id}`)).toBeOnTheScreen()
    })
  })

  // Each layout names the screen its stack starts at with `anchor`;
  // `initialRouteName` is deprecated and warns once per layout.
  it('the layouts use no deprecated settings', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    signedIn()
    await renderRouter(ROUTES, { initialUrl: link('slayzone://task/home.example/t0') })
    await screen.findByText('Spec notes')
    const deprecated = warn.mock.calls.filter((args) => String(args[0]).includes('deprecated'))
    warn.mockRestore()
    expect(deprecated).toEqual([])
  })

  describe('pushes stay in their tab', () => {
    it('Agents: an agent opens in the Agents tab', async () => {
      signedIn(homeWithAgent)
      await renderRouter(ROUTES, { initialUrl: '/' })
      await screen.findByText('Running')
      await userEvent.setup().press(tab('agents').getByText('Write spec'))
      expect(screen).toHavePathname('/agent/home.example/t0')
      expect(screen).toHaveSegments(['(tabs)', '(agents)', 'agent', '[hub]', '[id]'])
      expect(tab('agents').getByText('agent screen home.example t0 main')).toBeOnTheScreen()
    })

    it('Tasks: a task opens in the Tasks tab (phone)', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/tasks' })
      await userEvent.setup().press(await screen.findByText('Write spec'))
      expect(screen).toHavePathname('/task/home.example/t0')
      expect(screen).toHaveSegments(['(tabs)', '(tasks)', 'task', '[hub]', '[id]'])
    })

    it('Tasks: Projects opens in the Tasks tab', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/tasks' })
      await userEvent.setup().press(await screen.findByText('Projects'))
      expect(screen).toHavePathname('/projects')
      expect(screen).toHaveSegments(['(tabs)', '(tasks)', 'projects'])
    })

    it('Tasks: new-task opens in the Tasks tab with its params; created, the task replaces it', async () => {
      signedIn()
      await renderRouter(ROUTES, {
        initialUrl: '/new-task?hub=home.example&project=p&status=todo&parent=t0'
      })
      expect(await screen.findByText('new task home.example p todo t0')).toBeOnTheScreen()
      expect(screen).toHaveSegments(['(tabs)', '(tasks)', 'new-task'])
      await userEvent.setup().press(screen.getByText('stand-in create'))
      expect(screen).toHavePathname('/task/home.example/new1')
      expect(screen).toHaveSegments(['(tabs)', '(tasks)', 'task', '[hub]', '[id]'])
    })

    it('Tasks: new-task without status or parent; Cancel leaves it', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/new-task?hub=home.example&project=p' })
      expect(await screen.findByText('new task home.example p - -')).toBeOnTheScreen()
      await userEvent.setup().press(screen.getByText('stand-in cancel'))
      expect(screen).toHavePathname('/tasks')
    })

    it('Tasks: a task’s agent opens in the Tasks tab', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/tasks' })
      const user = userEvent.setup()
      await user.press(await screen.findByText('Write spec'))
      await user.press(tab('tasks').getByText('Agent ›'))
      expect(screen).toHavePathname('/agent/home.example/t0')
      expect(screen).toHaveSegments(['(tabs)', '(tasks)', 'agent', '[hub]', '[id]'])
      expect(tab('tasks').getByText('agent screen home.example t0 main')).toBeOnTheScreen()
    })

    it('Hubs: Add a hub opens in the Hubs tab; back returns to the list', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/hubs' })
      await userEvent.setup().press(await screen.findByText('Add a hub'))
      expect(screen).toHavePathname('/add-hub')
      expect(screen).toHaveSegments(['(tabs)', '(hubs)', 'add-hub'])
      expect(screen.getByText('Sign in to another hub')).toBeOnTheScreen()
      await userEvent.setup().press(screen.getByText('Cancel'))
      expect(screen).toHavePathname('/hubs')
    })
  })

  describe('deep links', () => {
    it('a task opens in the Tasks tab, above the list (phone)', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: link('slayzone://task/home.example/t0') })
      expect(await screen.findByText('Spec notes')).toBeOnTheScreen()
      expect(screen).toHavePathname('/task/home.example/t0')
      expect(screen).toHaveSegments(['(tabs)', '(tasks)', 'task', '[hub]', '[id]'])
      // With the computer it runs on and its artifacts.
      expect(tab('tasks').getByText('computer of t0')).toBeOnTheScreen()
      expect(tab('tasks').getByText('artifacts of home.example t0')).toBeOnTheScreen()
      await userEvent.setup().press(tab('tasks').getByText('‹ Back'))
      expect(screen).toHavePathname('/tasks')
    })

    it('a task on an iPad shows it beside the list', async () => {
      tablet()
      signedIn()
      await renderRouter(ROUTES, { initialUrl: link('slayzone://task/home.example/t0') })
      expect(await screen.findByText('Spec notes')).toBeOnTheScreen()
      // The row in the list, and the title of the detail beside it.
      expect(tab('tasks').getAllByText('Write spec')).toHaveLength(2)
    })

    it("a task's agents open in the Agents tab, on its hub", async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: link('slayzone://agent/home.example/t0') })
      expect(await screen.findByText('agent screen home.example t0 main')).toBeOnTheScreen()
      expect(screen).toHaveSegments(['(tabs)', '(agents)', 'agent', '[hub]', '[id]'])
    })

    it('opens the agent tab an agent link names (?tab=)', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: link('slayzone://agent/home.example/t0?tab=side') })
      expect(await screen.findByText('agent screen home.example t0 side')).toBeOnTheScreen()
    })

    it('a path without its tab still opens the screen', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: '/task/home.example/t0' })
      expect(await screen.findAllByText('Spec notes')).not.toHaveLength(0)
      expect(screen).toHavePathname('/task/home.example/t0')
    })

    it('an agent link to a hub the app is not signed in to says so', async () => {
      signedIn()
      await renderRouter(ROUTES, { initialUrl: link('slayzone://agent/other.example/t0') })
      expect(await screen.findByText('Not signed in to other.example')).toBeOnTheScreen()
    })
  })

  it('on an iPad, a tapped task shows beside the list', async () => {
    tablet()
    signedIn()
    await renderRouter(ROUTES, { initialUrl: '/tasks' })
    await screen.findAllByText('Write spec')
    await userEvent.setup().press(tab('tasks').getAllByText('Write spec')[0])
    expect(screen).toHavePathnameWithParams('/tasks?hub=home.example&task=t0')
  })

  // A session whose hub is gone must never trap the user (fix of 2026-10-29): before
  // its board fails (no banner yet), the Hubs tab still signs out of it.
  it('while a hub is still loading, the Hubs tab signs out of it', async () => {
    signedIn({ ...homeFeed, board: { ...homeFeed.board, data: undefined, pending: true } })
    await renderRouter(ROUTES, { initialUrl: '/hubs' })
    await userEvent.setup().press(await tab('hubs').findByText('Sign out'))
    await act(async () => undefined)
    expect(await screen.findByText('Sign in to a hub')).toBeOnTheScreen()
  })

  it('signing out of the last hub (Hubs tab) returns to sign-in', async () => {
    signedIn()
    await renderRouter(ROUTES, { initialUrl: '/hubs' })
    await userEvent.setup().press(await screen.findByText('Sign out'))
    await act(async () => undefined)
    expect(await screen.findByText('Sign in to a hub')).toBeOnTheScreen()
  })
})
