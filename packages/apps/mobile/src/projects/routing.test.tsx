/**
 * The projects routes as Expo Router mounts them (the real `src/app` routes and root
 * layout), like `../routing.test.tsx`: sessions, feeds and the hub theme are faked at
 * the module boundary; each hub's tRPC is an in-memory backend (`createFakeHubs`).
 */
import { userEvent } from '@testing-library/react-native'
import { renderRouter, screen, within } from 'expo-router/testing-library'
import type { ReactNode } from 'react'
import { Dimensions } from 'react-native'
import { redirectSystemPath } from '../app/+native-intent'
import type { HubFeed } from '../hub-board'
import type { HubSession } from '../hub-session'
import { boardOf, createFakeHubs, feedOf, homeHub, projectOf, taskOf } from '../hubs/testing'

const mockSessions: { kept: HubSession[] } = { kept: [] }
const mockFeeds: { list: HubFeed[] } = { list: [] }
const mockHubs = createFakeHubs()

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
jest.mock('../hub-theme', () => ({
  HubThemeProvider: ({ children }: { children: ReactNode }) => children
}))
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  HubScope: (props: { hubId: string; fallback?: ReactNode; children: ReactNode }) =>
    mockHubs.HubScope(props)
}))

// A task's agent (a terminal web view) has suites of its own.
jest.mock('../agents/AgentPanel', () => ({ AgentPanel: () => null }))

const home: HubSession = { entry: homeHub, token: 't' }
const homeFeed = feedOf(
  homeHub,
  boardOf({
    projects: [projectOf('p', { name: 'Website' }), projectOf('q', { name: 'Docs' })],
    tasks: [taskOf('t0', { title: 'Write spec', project_id: 'p', description: 'Spec notes' })]
  })
)

function phone() {
  const window = { width: 390, height: 844, scale: 3, fontScale: 1 }
  Dimensions.set({ window, screen: window })
}
function tablet() {
  const window = { width: 1024, height: 1366, scale: 2, fontScale: 1 }
  Dimensions.set({ window, screen: window })
}

beforeEach(() => {
  mockSessions.kept = [home]
  mockFeeds.list = [homeFeed]
  mockHubs.serve(homeHub.id, {
    procedures: { 'computers.list': () => [] },
    subscriptions: { 'computers.onStatusChange': () => undefined }
  })
  phone()
})

const ROUTES = 'src/app'

describe('projects routing', () => {
  it('/projects (the old projects list) opens the board, whose switcher lists them', async () => {
    await renderRouter(ROUTES, { initialUrl: '/projects' })
    expect(screen).toHavePathname('/')
  })

  it('a deep link to a project opens it (phone: its own screen)', async () => {
    await renderRouter(ROUTES, { initialUrl: '/projects/home.example/p' })
    const detail = within(await screen.findByTestId('project-detail-p'))
    expect(detail.getByText('Write spec')).toBeOnTheScreen()
  })

  it('a deep link to a project on an iPad opens it too', async () => {
    tablet()
    await renderRouter(ROUTES, { initialUrl: '/projects/home.example/q' })
    expect(await screen.findByTestId('project-detail-q')).toBeOnTheScreen()
  })

  it('opens a task of the project on its task screen', async () => {
    await renderRouter(ROUTES, { initialUrl: '/projects/home.example/p' })
    await userEvent.setup().press(await screen.findByText('Write spec'))
    expect(screen).toHavePathname('/task/home.example/t0')
  })

  it('a link to a project opens it in the Board tab; its tasks push there too', async () => {
    await renderRouter(ROUTES, {
      initialUrl: redirectSystemPath({ path: 'slayzone://projects/home.example/p', initial: true })
    })
    const detail = within(await screen.findByTestId('project-detail-p'))
    expect(screen).toHaveSegments(['(tabs)', '(board)', 'projects', '[hub]', '[id]'])
    await userEvent.setup().press(detail.getByText('Write spec'))
    expect(screen).toHaveSegments(['(tabs)', '(board)', 'task', '[hub]', '[id]'])
  })

  it('a project link to a hub the app is not signed in to says so', async () => {
    await renderRouter(ROUTES, { initialUrl: '/projects/other.example/p' })
    expect(await screen.findByText('Not signed in to other.example')).toBeOnTheScreen()
  })

  it('a project the hub does not have says so', async () => {
    await renderRouter(ROUTES, { initialUrl: '/projects/home.example/nope' })
    expect(await screen.findByText('No such project on home.example')).toBeOnTheScreen()
  })
})
