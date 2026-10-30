/**
 * The artifact routes as Expo Router mounts them (the real `src/app` routes and root
 * layout): which screen a deep link opens, with which hub, task, artifact and version, on
 * a phone and on a wide screen. The screens themselves are stand-ins (their own suites
 * test them); sessions and feeds are faked at the module boundary, so no socket opens.
 */
import { renderRouter, screen } from 'expo-router/testing-library'
import type { ReactNode } from 'react'
import { Dimensions } from 'react-native'
import type { HubSession } from '../hub-session'
import { redirectSystemPath } from '../app/+native-intent'

const mockSessions: { kept: HubSession[] } = { kept: [] }

jest.mock('../hub-session', () => {
  const actual = jest.requireActual('../hub-session')
  return {
    ...actual,
    hubSessions: {
      restore: async () => mockSessions.kept,
      save: async () => undefined,
      forget: async () => undefined
    }
  }
})
jest.mock('../hub-connections', () => ({
  HubConnections: ({ children }: { children: ReactNode }) => children,
  useHubFeeds: () => ({ feeds: [], retry: () => undefined, clientFor: () => null })
}))
jest.mock('../hub-theme', () => ({
  HubThemeProvider: ({ children }: { children: ReactNode }) => children
}))
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  HubScope: ({ hubId, children }: { hubId: string; children: ReactNode }) => {
    const { Text: T, View } = require('react-native')
    return (
      <View>
        <T>scope {hubId}</T>
        {children}
      </View>
    )
  }
}))
jest.mock('../trpc', () => ({
  ...jest.requireActual('../trpc'),
  useTRPCClient: () => null
}))
jest.mock('./ArtifactsScreen', () => ({
  ArtifactsScreen: (p: { taskId: string; layout: string; selected: unknown }) => {
    const { Text: T } = require('react-native')
    return <T>{`list ${p.taskId} ${p.layout} ${JSON.stringify(p.selected)}`}</T>
  }
}))
jest.mock('./ArtifactViewer', () => ({
  ArtifactViewer: (p: { taskId: string; artifactId: string; version: number | null }) => {
    const { Text: T } = require('react-native')
    return <T>{`viewer ${p.taskId} ${p.artifactId} ${p.version}`}</T>
  }
}))
jest.mock('./ArtifactSearchScreen', () => ({
  ArtifactSearchScreen: (p: { sessions: HubSession[] }) => {
    const { Text: T } = require('react-native')
    return <T>{`search ${p.sessions.length}`}</T>
  }
}))

const { hubEntryOf } = jest.requireActual('../hub-session') as typeof import('../hub-session')
const home: HubSession = { entry: hubEntryOf('home.example'), token: 't' }
const PHONE = { width: 390, height: 844, scale: 3, fontScale: 1 }
const TABLET = { width: 1024, height: 1366, scale: 2, fontScale: 1 }
// Expo Router's first mount loads every route; under a full parallel run that can pass 1 s.
const MOUNT = { timeout: 10_000 }

function setWindow(size: typeof PHONE) {
  jest.spyOn(Dimensions, 'get').mockReturnValue(size)
}

beforeEach(() => {
  mockSessions.kept = [home]
  setWindow(PHONE)
})
afterEach(() => jest.restoreAllMocks())

describe('artifact routes', () => {
  it('/artifacts searches every signed-in hub', async () => {
    await renderRouter('src/app', { initialUrl: '/artifacts' })
    expect(await screen.findByText('search 1', undefined, MOUNT)).toBeOnTheScreen()
  })

  it("/artifacts/<hub>/<task>: the task's list, in that hub's scope (phone)", async () => {
    await renderRouter('src/app', { initialUrl: '/artifacts/home.example/t1' })
    expect(await screen.findByText('list t1 list null', undefined, MOUNT)).toBeOnTheScreen()
    expect(screen.getByText(`scope ${home.entry.id}`)).toBeOnTheScreen()
  })

  it('/artifacts/<hub>/<task>/<id>?version=: that version of the artifact (phone)', async () => {
    await renderRouter('src/app', { initialUrl: '/artifacts/home.example/t1/a1?version=3' })
    expect(await screen.findByText('viewer t1 a1 3', undefined, MOUNT)).toBeOnTheScreen()
  })

  it('wide screen: the list with the named artifact beside it', async () => {
    setWindow(TABLET)
    await renderRouter('src/app', { initialUrl: '/artifacts/home.example/t1/a1' })
    expect(
      await screen.findByText('list t1 split {"artifactId":"a1","version":null}', undefined, MOUNT)
    ).toBeOnTheScreen()
  })

  it("a link to a task's artifacts opens them in the Search tab", async () => {
    await renderRouter('src/app', {
      initialUrl: redirectSystemPath({
        path: 'slayzone://artifacts/home.example/t1',
        initial: true
      })
    })
    expect(await screen.findByText('list t1 list null', undefined, MOUNT)).toBeOnTheScreen()
    expect(screen).toHaveSegments(['(tabs)', '(search)', 'artifacts', '[hub]', '[task]'])
  })

  it('a hub the app is not signed in to says so', async () => {
    await renderRouter('src/app', { initialUrl: '/artifacts/other.example/t1/a1' })
    expect(
      await screen.findByText('Not signed in to other.example', undefined, MOUNT)
    ).toBeOnTheScreen()
    expect(screen.queryByText(/^viewer/)).toBeNull()
  })
})
