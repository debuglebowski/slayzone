/**
 * The projects routes as Expo Router mounts them (the real `src/app` routes and root
 * layout), like `../routing.test.tsx`: sessions, feeds and the hub theme are faked at
 * the module boundary; each hub's tRPC is an in-memory backend (`createFakeHubs`).
 */
import { userEvent } from '@testing-library/react-native'
import { renderRouter, screen, within } from 'expo-router/testing-library'
import type { ReactNode } from 'react'
import { Dimensions } from 'react-native'
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
  it('lists the projects; a phone opens a tapped one on its own screen', async () => {
    await renderRouter(ROUTES, { initialUrl: '/projects' })
    await userEvent.setup().press(await screen.findByText('Website'))
    expect(screen).toHavePathname('/projects/home.example/p')
    expect(await screen.findByTestId('project-detail-p')).toBeOnTheScreen()
  })

  it('a deep link to a project opens it (phone: its own screen)', async () => {
    await renderRouter(ROUTES, { initialUrl: '/projects/home.example/p' })
    const detail = within(await screen.findByTestId('project-detail-p'))
    expect(detail.getByText('Write spec')).toBeOnTheScreen()
  })

  it('a deep link to a project on an iPad shows it beside the list', async () => {
    tablet()
    await renderRouter(ROUTES, { initialUrl: '/projects/home.example/q' })
    expect(await screen.findByTestId('project-detail-q')).toBeOnTheScreen()
    expect(screen.getByText('Website')).toBeOnTheScreen()
  })

  it('opens a task of the project on its task screen', async () => {
    await renderRouter(ROUTES, { initialUrl: '/projects/home.example/p' })
    await userEvent.setup().press(await screen.findByText('Write spec'))
    expect(screen).toHavePathname('/task/home.example/t0')
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
