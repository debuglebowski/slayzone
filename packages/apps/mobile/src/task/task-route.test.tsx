/**
 * The task route (`/task/<hub>/<id>`) as Expo Router mounts it: an iPad opening a task
 * wide shows it as a tab on the board; a task opened narrow stays a page when the
 * window widens or rotates (a resize never navigates). Hub data is faked at the module
 * boundary, as in `routing.test.tsx`; the page itself is a stand-in.
 */
import { act, renderRouter, screen } from 'expo-router/testing-library'
import type { ReactNode } from 'react'
import { Dimensions, Platform } from 'react-native'
import type { BoardData, HubFeed } from '../hub-board'
import type { HubSession } from '../hub-session'

const mockSessions: { kept: HubSession[] } = { kept: [] }
const mockFeeds: { list: HubFeed[] } = { list: [] }

jest.mock('../hub-session', () => ({
  ...jest.requireActual('../hub-session'),
  hubSessions: {
    restore: async () => mockSessions.kept,
    save: async () => undefined,
    forget: async () => undefined
  }
}))
jest.mock('../hub-connections', () => ({
  HubConnections: ({ children }: { children: ReactNode }) => children,
  useHubFeeds: () => ({ feeds: mockFeeds.list, retry: () => undefined, clientFor: () => null })
}))
jest.mock('./TaskPage', () => ({
  ...jest.requireActual('./TaskPage'),
  TaskPage: (p: import('./TaskPage').TaskPageProps) => {
    const { Text } = jest.requireActual('react-native')
    return <Text>{`task page ${p.row.task.id}${p.wide ? ' wide' : ''}`}</Text>
  }
}))
jest.mock('../artifacts/ArtifactSearchScreen', () => ({ ArtifactSearchScreen: () => null }))
jest.mock('../hub-theme', () => ({
  HubThemeProvider: ({ children }: { children: ReactNode }) => children
}))
// A hub scope with no hub behind it: whatever asks the hub fails, so the iPad's tab bar
// keeps the tabs opened on this device (a hub without shared open tabs).
let mockEmptyHub: { wrapper: (p: { children: ReactNode }) => ReactNode } | null = null
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  HubScope: ({ children }: { children: ReactNode }) => {
    mockEmptyHub ??= jest.requireActual('../testing').trpcTest({})
    const Wrapper = mockEmptyHub!.wrapper
    return <Wrapper>{children}</Wrapper>
  }
}))
jest.mock('../hubs/HubDetails', () => ({ HubDetails: () => null }))
// The board's columns write to its hub (`board/*.test.tsx`); here only the task's route.
jest.mock('../board/ProjectBoard', () => ({
  ...jest.requireActual('../board/ProjectBoard'),
  ProjectBoard: () => null
}))
jest.mock('../board/use-board-moves', () => ({ useBoardMoves: () => async () => undefined }))
jest.mock('../board/use-archive-all', () => ({ useArchiveAll: () => async () => undefined }))
jest.mock('../board/use-scratch-task', () => ({
  useScratchTask: () => ({ creating: false, create: () => undefined })
}))

const { hubEntryOf } = jest.requireActual('../hub-session') as typeof import('../hub-session')
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
      description: '',
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

function windowOf(width: number, height: number) {
  const window = { width, height, scale: 2, fontScale: 1 }
  Dimensions.set({ window, screen: window })
}

beforeEach(() => {
  jest.spyOn(Platform as { readonly isPad: boolean }, 'isPad', 'get').mockReturnValue(true)
  mockSessions.kept = [home]
  mockFeeds.list = [homeFeed]
})
afterEach(() => jest.restoreAllMocks())

describe('the task route', () => {
  it('a task opened narrow stays a page when the iPad window widens or rotates', async () => {
    windowOf(500, 1024) // Split View, narrow
    await renderRouter('src/app', { initialUrl: '/task/home.example/t0' })
    expect(await screen.findByText('task page t0')).toBeOnTheScreen()
    await act(async () => windowOf(1366, 1024)) // full width, landscape
    expect(await screen.findByText('task page t0 wide')).toBeOnTheScreen()
    expect(screen).toHavePathname('/task/home.example/t0')
  })

  it('opened wide, the task becomes a tab on the board', async () => {
    windowOf(1024, 1366)
    await renderRouter('src/app', { initialUrl: '/task/home.example/t0' })
    expect(await screen.findByTestId('open-tab-task-t0')).toBeOnTheScreen()
    expect(screen).toHavePathname('/')
  })
})
