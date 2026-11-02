/**
 * The demo, end to end: the app's real routes and root layout, its real hub
 * connections (`HubConnections` → `FederationProvider` → `HubScope`, the client runtime,
 * React Query) and the demo hub behind them — nothing between the screens and the demo
 * hub is mocked. "Try demo" on the sign-in screen opens every tab on the sample data;
 * "Exit demo" goes back to sign-in; the keychain is never touched.
 */
import { userEvent } from '@testing-library/react-native'
import { router } from 'expo-router'
import { act, renderRouter, screen, waitFor, within } from 'expo-router/testing-library'
import { Dimensions } from 'react-native'
import { DEMO_IDS } from './seed'

/** What the terminal's web view was sent (a DOM component cannot run in Node). */
const mockDom = {
  ops: [] as string[],
  written: () => mockDom.ops.join('')
}
jest.mock('../terminal/TerminalDom', () => {
  const { useEffect, useImperativeHandle, useState } = jest.requireActual('react')
  function FakeTerminalDom(props: { ref: unknown; onReady: () => Promise<void> }) {
    useImperativeHandle(
      props.ref,
      () => ({
        write: (data: string) => mockDom.ops.push(data),
        reset: () => undefined,
        resize: () => undefined
      }),
      []
    )
    const [onReady] = useState(() => props.onReady)
    useEffect(() => {
      void onReady()
    }, [onReady])
    return null
  }
  return { __esModule: true, default: FakeTerminalDom }
})
// mermaid's build ships inside the app bundle (prebuild), not in Node.
jest.mock('../artifacts/page-assets', () => ({
  MERMAID_BUNDLE_FILE: 'mermaid.min.js',
  loadMermaidScript: jest.fn(async () => 'globalThis.mermaid={}')
}))

/** The HTML of the markdown artifact page on screen (the web view stand-in keeps its props). */
const markdownPage = (): string =>
  (screen.getByTestId('artifact-page-markdown').props as { source: { html: string } }).source.html

// The keychain's sessions: the demo must never read past `restore` or write to it.
const mockKeychain = {
  restore: jest.fn(async () => []),
  save: jest.fn(async () => undefined),
  forget: jest.fn(async () => undefined)
}
jest.mock('../hub-session', () => ({
  ...jest.requireActual('../hub-session'),
  hubSessions: mockKeychain
}))

const ROUTES = 'src/app'

/** Queries inside one tab's stack (every tab stays mounted). */
const tab = (name: 'agents' | 'tasks' | 'search' | 'hubs') =>
  within(screen.getByTestId(`tab-${name}`))

beforeEach(() => {
  const window = { width: 390, height: 844, scale: 3, fontScale: 1 }
  Dimensions.set({ window, screen: window })
  jest.clearAllMocks()
  mockDom.ops = []
})

async function enterDemo() {
  await renderRouter(ROUTES, { initialUrl: '/' })
  await userEvent.setup().press(await screen.findByText('Try demo'))
  await screen.findAllByTestId('demo-banner')
}

/** Switch tabs (the native tab bar is not in the test renderer; an unfocused tab takes no presses). */
const openTab = (href: '/' | '/tasks' | '/artifacts' | '/hubs') =>
  act(async () => {
    router.navigate(href)
  })

const press = (element: Parameters<ReturnType<typeof userEvent.setup>['press']>[0]) =>
  userEvent.setup().press(element)

describe('the demo', () => {
  it('opens from the sign-in screen on the Agents tab, with its agents', async () => {
    await enterDemo()
    expect(screen).toHaveSegments(['(tabs)', '(agents)'])
    const agents = tab('agents')
    expect(agents.getByTestId('demo-banner')).toBeOnTheScreen()
    // A running terminal agent, a finished chat agent waiting for review, an idle one.
    expect(await agents.findByText('Search endpoint')).toBeOnTheScreen()
    expect(agents.getByText('Auth refactor: session middleware')).toBeOnTheScreen()
    expect(agents.getByText('Dark mode')).toBeOnTheScreen()
    expect(agents.getAllByText(/Running/).length).toBeGreaterThan(0)
    expect(mockKeychain.save).not.toHaveBeenCalled()
  })

  it('shows the banner on every tab, and Exit demo goes back to sign-in', async () => {
    await enterDemo()
    for (const name of ['agents', 'tasks', 'search', 'hubs'] as const) {
      expect(tab(name).getByTestId('demo-banner')).toBeOnTheScreen()
    }
    await press(tab('agents').getByTestId('exit-demo'))
    expect(await screen.findByText('Sign in to a hub')).toBeOnTheScreen()
    expect(screen).toHavePathname('/sign-in')
    expect(screen.queryByTestId('demo-banner')).toBeNull()
    expect(mockKeychain.save).not.toHaveBeenCalled()
    expect(mockKeychain.forget).not.toHaveBeenCalled()
  })

  it('Tasks: the first project’s board, its columns and tasks', async () => {
    await enterDemo()
    await openTab('/tasks')
    expect(screen).toHavePathname('/tasks')
    const tasks = tab('tasks')
    expect(await tasks.findByText('API v2 ▾')).toBeOnTheScreen()
    // Kanban: the columns with their counts, the first non-empty one shown.
    expect(tasks.getByText(/^In Progress/)).toBeOnTheScreen()
    expect(tasks.getByText('Upgrade to Node 24')).toBeOnTheScreen()
    // List: every task of the project.
    await press(tasks.getByTestId('view-list'))
    expect(await tasks.findByText('Search endpoint')).toBeOnTheScreen()
    expect(tasks.getByText('Rate limiting')).toBeOnTheScreen()
    expect(tasks.getByText('Auth refactor: session middleware')).toBeOnTheScreen()
  })

  it('Hubs: the demo hub, signed in as the demo account, with its computer', async () => {
    await enterDemo()
    const hubs = tab('hubs')
    expect(await hubs.findByText('SlayZone demo')).toBeOnTheScreen()
    // The banner's and the card's.
    expect(hubs.getAllByText('Exit demo')).toHaveLength(2)
    expect(await hubs.findByText('Signed in as demo@slay.zone')).toBeOnTheScreen()
    expect(await hubs.findByText('MacBook Pro')).toBeOnTheScreen()
  })

  it('a task: its subtasks, tags and artifacts; a markdown artifact with a diagram', async () => {
    await enterDemo()
    await openTab('/tasks')
    const tasks = tab('tasks')
    await press(await tasks.findByTestId('view-list'))
    await press(await tasks.findByText('Search endpoint'))
    expect(await tasks.findByTestId(`subtask-${DEMO_IDS.searchIndex}`)).toBeOnTheScreen()
    expect(tasks.getByText('Ranking tests')).toBeOnTheScreen()
    expect(tasks.getByText('feature')).toBeOnTheScreen()

    await press(await tasks.findByTestId('task-artifacts-link'))
    expect(await tasks.findByTestId(`artifact-row-${DEMO_IDS.planArtifact}`)).toBeOnTheScreen()
    expect(tasks.getByTestId(`artifact-row-${DEMO_IDS.screenshotArtifact}`)).toBeOnTheScreen()
    expect(tasks.getByTestId(`artifact-folder-${DEMO_IDS.notesFolder}`)).toBeOnTheScreen()

    await press(tasks.getByTestId(`artifact-row-${DEMO_IDS.planArtifact}`))
    // The page the web view shows: the markdown, its diagram drawn by mermaid.
    await tasks.findByTestId('artifact-page-markdown')
    expect(markdownPage()).toContain('Search endpoint — plan')
    expect(markdownPage()).toContain('class="mermaid-block"')
    expect(markdownPage()).toContain('sequenceDiagram')
  })

  it('an agent’s chat: its conversation, and a message sent in the demo gets the demo’s answer', async () => {
    await enterDemo()
    const agents = tab('agents')
    await press(await agents.findByText('Auth refactor: session middleware'))
    expect(
      await agents.findByText(
        'Move the session checks out of the route handlers into one middleware. Keep the 401 body exactly as it is.'
      )
    ).toBeOnTheScreen()

    await userEvent
      .setup()
      .type(agents.getByTestId('chat-input'), 'Also add a test for expired cookies')
    await press(agents.getByLabelText('Send'))
    expect(await agents.findByText('Also add a test for expired cookies')).toBeOnTheScreen()
    await act(async () => {
      jest.advanceTimersByTime(2000)
    })
    await waitFor(() => expect(agents.getAllByText(/no agent runs here/).length).toBeGreaterThan(0))
  })

  it('a terminal agent: its recorded output, and typed input echoed with the demo’s note', async () => {
    await enterDemo()
    const agents = tab('agents')
    await press(await agents.findByText('Search endpoint'))
    await waitFor(() =>
      expect(mockDom.written()).toContain('add full-text search to /api/v2/search')
    )
    expect(mockDom.written()).toContain('Running the rest of the suite')

    await userEvent.setup().type(agents.getByLabelText('Message to the agent'), 'run lint too')
    await press(agents.getByLabelText('Send'))
    await waitFor(() => expect(mockDom.written()).toContain('No agent runs in the demo'))
  })

  it('writes stay in the demo: a new task is gone after Exit demo and Try demo again', async () => {
    await enterDemo()
    await openTab('/tasks')
    const tasks = tab('tasks')
    await press(await tasks.findByTestId('view-list'))
    await press(await tasks.findByText('Search endpoint'))
    await press(await tasks.findByText('Add subtask'))
    await userEvent
      .setup()
      .type(tasks.getByTestId('new-subtask-title'), 'Benchmark on prod copy', {
        submitEditing: true
      })
    expect(await tasks.findByText('Benchmark on prod copy')).toBeOnTheScreen()

    await press(tasks.getByTestId('exit-demo'))
    await press(await screen.findByText('Try demo'))
    await openTab('/tasks')
    const again = tab('tasks')
    expect(await again.findByText('Search endpoint')).toBeOnTheScreen()
    expect(again.queryByText('Benchmark on prod copy')).toBeNull()
    expect(mockKeychain.save).not.toHaveBeenCalled()
  })
})
