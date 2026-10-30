/**
 * Removing a hub (Sign out) through the app's real data layer: `HubSessionsProvider`
 * (the sessions) → `HubConnections` (one feed per signed-in hub) → the merged lists.
 * The federation is faked at its module boundary (each hub's tRPC is an in-memory
 * backend, sockets "open"); what the federation does with a hub that leaves its list —
 * close the socket, clear its cache — is the transport's own test (`federation.test.tsx`,
 * "removal"). Here: the hub leaves that list, and everything shown of it goes.
 */
import { act, render, screen, userEvent, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { Pressable, Text } from 'react-native'
import { mergeHubAgents } from '../agents/hub-agents'
import { mergeHubTasks } from '../hub-board'
import { HubConnections, useHubFeeds } from '../hub-connections'
import type { HubSession, HubSessionStore } from '../hub-session'
import { HubSessionsProvider, useHubSessions } from '../hub-sessions'
import { mergeHubProjects } from '../projects/hub-projects'
import { boardOf, createFakeHubs, homeHub, projectOf, taskOf, workHub } from './testing'

const mockHubs = createFakeHubs()
const mockFederated: { hubs: string[][] } = { hubs: [] }
jest.mock('@slayzone/transport/client', () => {
  const actual = jest.requireActual('@slayzone/transport/client')
  // One object, as the real hook's snapshot is: a new one per render would re-report the
  // feed on every render.
  const open = { status: 'open', error: null }
  return {
    ...actual,
    FederationProvider: ({
      hubs,
      children
    }: {
      hubs: Array<{ id: string }>
      children: ReactNode
    }) => {
      mockFederated.hubs.push(hubs.map((h) => h.id))
      return children
    },
    useFederation: () => ({ hubs: [], defaultHubId: 'local', resolve: () => null }),
    useHubConnection: () => open,
    HubScope: (props: { hubId: string; fallback?: ReactNode; children: ReactNode }) =>
      mockHubs.HubScope(props)
  }
})

const home: HubSession = { entry: homeHub, token: 't-home' }
const work: HubSession = { entry: workHub, token: 't-work' }

function serve(hub: typeof homeHub, name: string) {
  mockHubs.serve(hub.id, {
    procedures: {
      'task.loadBoardData': () =>
        boardOf({
          projects: [projectOf('p', { name: `${name} project` })],
          tasks: [taskOf('t', { title: `${name} task`, project_id: 'p' })]
        }),
      // The task's agent runs (the feed's agent half asks every hub).
      'pty.sessionList': () => [{ sessionId: 't:t', state: 'running', kind: 'pty' }],
      'taskTerminals.listHibernatedSessions': () => []
    },
    subscriptions: {
      'notify.onTasksChanged': () => undefined,
      'pty.onStateChange': () => undefined,
      'pty.onExit': () => undefined,
      'pty.onBackgroundJobs': () => undefined,
      'pty.onHibernated': () => undefined
    }
  })
}

/** Every merged list the app shows, as text; and a Sign out for hub `work`. */
function Lists() {
  const { feeds } = useHubFeeds()
  const { signOut } = useHubSessions()
  const tasks = mergeHubTasks(feeds).map((r) => r.task.title)
  const projects = mergeHubProjects(feeds).flatMap((g) => g.projects.map((r) => r.project.name))
  const agents = mergeHubAgents(feeds).map((r) => `${r.task.title} agent`)
  return (
    <>
      <Text testID="hubs">{feeds.map((f) => f.hub.label).join(',')}</Text>
      <Text testID="tasks">{tasks.join(',')}</Text>
      <Text testID="agents">{agents.join(',')}</Text>
      <Text testID="projects">{projects.join(',')}</Text>
      <Pressable onPress={() => signOut(workHub.id)}>
        <Text>Sign out of work</Text>
      </Pressable>
    </>
  )
}

function Signed() {
  const { sessions } = useHubSessions()
  if (!sessions) return null
  return (
    <HubConnections sessions={sessions}>
      <Lists />
    </HubConnections>
  )
}

describe('removing a hub', () => {
  it('drops its tasks, agents and projects from every merged list, forgets its bearer, kept theme and downloaded files', async () => {
    serve(homeHub, 'home')
    serve(workHub, 'work')
    const store: HubSessionStore = {
      restore: jest.fn(async () => [home, work]),
      save: jest.fn(async () => undefined),
      forget: jest.fn(async () => undefined)
    }
    const themeCache = { forget: jest.fn() }
    const artifactFiles = { forget: jest.fn() }
    await render(
      <HubSessionsProvider store={store} themeCache={themeCache} artifactFiles={artifactFiles}>
        <Signed />
      </HubSessionsProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('tasks')).toHaveTextContent('home task,work task')
    )
    expect(screen.getByTestId('projects')).toHaveTextContent('home project,work project')
    await waitFor(() =>
      expect(screen.getByTestId('agents')).toHaveTextContent('home task agent,work task agent')
    )

    await userEvent.setup().press(screen.getByText('Sign out of work'))
    await act(async () => undefined)

    expect(screen.getByTestId('hubs')).toHaveTextContent(homeHub.label)
    expect(screen.getByTestId('tasks')).toHaveTextContent('home task')
    expect(screen.getByTestId('agents')).toHaveTextContent('home task agent')
    expect(screen.getByTestId('projects')).toHaveTextContent('home project')
    // The federation no longer lists it: its socket and cache go (transport's rule).
    expect(mockFederated.hubs.at(-1)).toEqual([homeHub.id])
    expect(store.forget).toHaveBeenCalledWith(workHub.id)
    expect(themeCache.forget).toHaveBeenCalledWith(workHub.id)
    expect(artifactFiles.forget).toHaveBeenCalledWith(workHub.id)
    expect(artifactFiles.forget).toHaveBeenCalledTimes(1)
  })
})
