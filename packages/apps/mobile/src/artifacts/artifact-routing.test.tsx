/**
 * The artifact routes as Expo Router mounts them (the real `src/app` routes and root
 * layout): which screen a deep link opens, with which hub, task, artifact and version, on
 * a phone and on a wide screen. The screens themselves are stand-ins (their own suites
 * test them); sessions and feeds are faked at the module boundary, so no socket opens.
 */
import { renderRouter, screen } from 'expo-router/testing-library'
import type { ReactNode } from 'react'
import { act, userEvent, waitFor } from '@testing-library/react-native'
import { router } from 'expo-router'
import { Dimensions, Platform } from 'react-native'
import type { HubSession } from '../hub-session'
import { redirectSystemPath } from '../app/+native-intent'
import { artifactBackLabel } from './ArtifactRoutes'

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
  ArtifactsScreen: (p: {
    taskId: string
    layout: string
    selected: unknown
    artifactBackLabel?: string
  }) => {
    const { Text: T } = require('react-native')
    return (
      <>
        <T>{`list ${p.taskId} ${p.layout} ${JSON.stringify(p.selected)}`}</T>
        {p.layout === 'artifact' ? <T>{`back: ${p.artifactBackLabel}`}</T> : null}
      </>
    )
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
  // Desktop's split is an iPad's (`useWide`), never an iPhone's.
  jest
    .spyOn(Platform as { readonly isPad: boolean }, 'isPad', 'get')
    .mockReturnValue(size === TABLET)
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
    expect(
      await screen.findByText('list t1 artifact {"artifactId":"a1","version":3}', undefined, MOUNT)
    ).toBeOnTheScreen()
    // Opened by a link: Back goes to the tab's root (the board), and says so.
    expect(screen.getByText('back: Board')).toBeOnTheScreen()
  })

  it("an artifact's Back names the screen it was opened from", async () => {
    await renderRouter('src/app', { initialUrl: '/artifacts/home.example/t1' })
    await screen.findByText('list t1 list null', undefined, MOUNT)
    await act(async () => router.push('/artifacts/home.example/t1/a1'))
    expect(await screen.findByText('back: Artifacts', undefined, MOUNT)).toBeOnTheScreen()
    await act(async () => router.push('/task/home.example/t1'))
    await act(async () => router.push('/artifacts/home.example/t1/a2'))
    expect(await screen.findByText('back: Task', undefined, MOUNT)).toBeOnTheScreen()
  })

  it('an iPhone in landscape keeps the phone layout (no split)', async () => {
    setWindow({ width: 932, height: 430, scale: 3, fontScale: 1 })
    await renderRouter('src/app', { initialUrl: '/artifacts/home.example/t1/a1' })
    expect(
      await screen.findByText(
        'list t1 artifact {"artifactId":"a1","version":null}',
        undefined,
        MOUNT
      )
    ).toBeOnTheScreen()
  })

  it('wide screen: the list with the named artifact beside it', async () => {
    setWindow(TABLET)
    await renderRouter('src/app', { initialUrl: '/artifacts/home.example/t1/a1' })
    expect(
      await screen.findByText('list t1 split {"artifactId":"a1","version":null}', undefined, MOUNT)
    ).toBeOnTheScreen()
  })

  it("a link to a task's artifacts opens them in the Board tab (where the task lives)", async () => {
    await renderRouter('src/app', {
      initialUrl: redirectSystemPath({
        path: 'slayzone://artifacts/home.example/t1',
        initial: true
      })
    })
    expect(await screen.findByText('list t1 list null', undefined, MOUNT)).toBeOnTheScreen()
    expect(screen).toHaveSegments(['(tabs)', '(board)', 'artifacts', '[hub]', '[task]'])
  })

  it('a hub the app is not signed in to says so', async () => {
    await renderRouter('src/app', { initialUrl: '/artifacts/other.example/t1/a1' })
    expect(
      await screen.findByText('Not signed in to other.example', undefined, MOUNT)
    ).toBeOnTheScreen()
    expect(screen.queryByText(/^list/)).toBeNull()
  })
})

describe('artifactBackLabel', () => {
  it('names the screen below the artifact by its route', () => {
    expect(artifactBackLabel('artifacts/[hub]/[task]/index')).toBe('Artifacts')
    expect(artifactBackLabel('task/[hub]/[id]')).toBe('Task')
    expect(artifactBackLabel('artifacts/index')).toBe('Search')
    expect(artifactBackLabel('index')).toBe('Board')
    expect(artifactBackLabel('artifacts/[hub]/[task]/[id]')).toBe('Back')
    expect(artifactBackLabel('something/else')).toBe('Back')
    expect(artifactBackLabel(undefined)).toBe('Artifacts')
  })
})

const mockTabVisibility: boolean[] = []
jest.mock('../tab-bar', () => {
  const actual = jest.requireActual('../tab-bar')
  return {
    ...actual,
    useTabBarHiding: () => {
      const value = actual.useTabBarHiding()
      mockTabVisibility.push(value.hidden)
      return value
    }
  }
})

it('task-origin artifact keeps the global bar hidden', async () => {
  await renderRouter('src/app', { initialUrl: '/task/home.example/t1' })
  await waitFor(() => expect(mockTabVisibility.at(-1)).toBe(true))
  await act(async () => router.push('/artifacts/home.example/t1/a1'))
  expect(await screen.findByText('back: Task', undefined, MOUNT)).toBeOnTheScreen()
  expect(mockTabVisibility.at(-1)).toBe(true)
  await userEvent.setup().press(screen.getByTestId('tab-details'))
  expect(screen).toHavePathnameWithParams('/task/home.example/t1?segment=details')
  await act(async () => router.back())
  expect(screen).toHavePathname('/')
})
