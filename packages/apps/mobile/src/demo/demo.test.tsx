/**
 * The demo, end to end: the app's real routes and root layout, its real hub
 * connections (`HubConnections` → `FederationProvider` → `HubScope`, the client runtime,
 * React Query) and the demo hub behind them — nothing between the screens and the demo
 * hub is mocked. "Try demo" on the sign-in screen opens the app (Board · Search · Settings) on the sample data;
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
const tab = (name: 'board' | 'search' | 'settings') => within(screen.getByTestId(`tab-${name}`))

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
const openTab = (href: '/' | '/artifacts' | '/settings') =>
  act(async () => {
    router.navigate(href)
  })

const press = (element: Parameters<ReturnType<typeof userEvent.setup>['press']>[0]) =>
  userEvent.setup().press(element)

/** The board's 🔔 sheet (desktop's agent status panel): open a task by its agent's row. */
async function openFromBell(title: string) {
  const board = tab('board')
  await press(await board.findByTestId('bell'))
  const sheet = within(await screen.findByTestId('attention-sheet'))
  await press(await sheet.findByText(title))
  await board.findByTestId('task-page')
  return board
}

describe('the demo', () => {
  it('opens from the sign-in screen on the Board, its agents behind the 🔔', async () => {
    await enterDemo()
    expect(screen).toHaveSegments(['(tabs)', '(board)'])
    const board = tab('board')
    expect(board.getByTestId('demo-banner')).toBeOnTheScreen()
    expect(await board.findByText('API v2')).toBeOnTheScreen()
    // A running terminal agent, a finished chat agent waiting for review, an idle one.
    await press(board.getByTestId('bell'))
    const sheet = within(await screen.findByTestId('attention-sheet'))
    expect(await sheet.findByText('Search endpoint')).toBeOnTheScreen()
    expect(sheet.getByText('Auth refactor: session middleware')).toBeOnTheScreen()
    expect(sheet.getByText('Dark mode')).toBeOnTheScreen()
    // Each row: its project and its agent's state.
    expect(sheet.getAllByText(/API v2 · Active/).length).toBeGreaterThan(0)
    expect(mockKeychain.save).not.toHaveBeenCalled()
  })

  it('shows the banner on every tab, and Exit demo goes back to sign-in', async () => {
    await enterDemo()
    for (const name of ['board', 'search', 'settings'] as const) {
      expect(tab(name).getByTestId('demo-banner')).toBeOnTheScreen()
    }
    await press(tab('board').getByTestId('exit-demo'))
    expect(await screen.findByText('Sign in to a hub')).toBeOnTheScreen()
    expect(screen).toHavePathname('/sign-in')
    expect(screen.queryByTestId('demo-banner')).toBeNull()
    expect(mockKeychain.save).not.toHaveBeenCalled()
    expect(mockKeychain.forget).not.toHaveBeenCalled()
  })

  it('Board: the first project’s columns and tasks', async () => {
    await enterDemo()
    const board = tab('board')
    expect(await board.findByText('API v2')).toBeOnTheScreen()
    // Kanban: a column per status, with its count; a chip shows its column.
    await press(await board.findByTestId('column-chip-in_progress'))
    expect(await board.findByText('Search endpoint')).toBeOnTheScreen()
    await press(board.getByTestId('column-chip-todo'))
    expect(await board.findByText('Rate limiting')).toBeOnTheScreen()
    await press(board.getByTestId('column-chip-review'))
    expect(await board.findByText('Auth refactor: session middleware')).toBeOnTheScreen()
  })

  it('Settings: the demo hub, signed in as the demo account, with its computer', async () => {
    await enterDemo()
    await openTab('/settings')
    const settings = tab('settings')
    expect(await settings.findByText('SlayZone demo')).toBeOnTheScreen()
    // The banner's and the card's.
    expect(settings.getAllByText('Exit demo')).toHaveLength(2)
    expect(await settings.findByText('Signed in as demo@slay.zone')).toBeOnTheScreen()
    expect(await settings.findByText('MacBook Pro')).toBeOnTheScreen()
  })

  it('a task: its subtasks, tags and artifacts; a markdown artifact with a diagram', async () => {
    await enterDemo()
    const board = await openFromBell('Search endpoint')
    await press(board.getByTestId('segment-details'))
    expect(await board.findByTestId(`subtask-${DEMO_IDS.searchIndex}`)).toBeOnTheScreen()
    expect(board.getByText('Ranking tests')).toBeOnTheScreen()
    // Under the title and in the Tags section.
    expect(board.getAllByText('feature').length).toBeGreaterThan(0)

    await press(board.getByTestId('segment-artifacts'))
    expect(await board.findByTestId(`artifact-row-${DEMO_IDS.planArtifact}`)).toBeOnTheScreen()
    expect(board.getByTestId(`artifact-row-${DEMO_IDS.screenshotArtifact}`)).toBeOnTheScreen()
    expect(board.getByTestId(`artifact-folder-${DEMO_IDS.notesFolder}`)).toBeOnTheScreen()

    await press(board.getByTestId(`artifact-row-${DEMO_IDS.planArtifact}`))
    // The page the web view shows: the markdown, its diagram drawn by mermaid.
    await board.findByTestId('artifact-page-markdown')
    expect(markdownPage()).toContain('Search endpoint — plan')
    expect(markdownPage()).toContain('class="mermaid-block"')
    expect(markdownPage()).toContain('sequenceDiagram')
  })

  it('an agent’s chat: its conversation, and a message sent in the demo gets the demo’s answer', async () => {
    await enterDemo()
    const board = await openFromBell('Auth refactor: session middleware')
    expect(
      await board.findByText(
        'Move the session checks out of the route handlers into one middleware. Keep the 401 body exactly as it is.'
      )
    ).toBeOnTheScreen()

    await userEvent
      .setup()
      .type(board.getByTestId('chat-input'), 'Also add a test for expired cookies')
    await press(board.getByLabelText('Send'))
    expect(await board.findByText('Also add a test for expired cookies')).toBeOnTheScreen()
    await act(async () => {
      jest.advanceTimersByTime(2000)
    })
    await waitFor(() => expect(board.getAllByText(/no agent runs here/).length).toBeGreaterThan(0))
  })

  it('a terminal agent: its recorded output, and typed input echoed with the demo’s note', async () => {
    await enterDemo()
    const board = await openFromBell('Search endpoint')
    await waitFor(() =>
      expect(mockDom.written()).toContain('add full-text search to /api/v2/search')
    )
    expect(mockDom.written()).toContain('Running the rest of the suite')

    await userEvent.setup().type(board.getByLabelText('Message to the agent'), 'run lint too')
    await press(board.getByLabelText('Send'))
    await waitFor(() => expect(mockDom.written()).toContain('No agent runs in the demo'))
  })

  it('writes stay in the demo: a new sub-task is gone after Exit demo and Try demo again', async () => {
    await enterDemo()
    let board = await openFromBell('Search endpoint')
    await press(board.getByTestId('segment-details'))
    await press(await board.findByTestId('add-subtask'))
    await userEvent.setup().type(board.getByTestId('new-subtask-title'), 'Benchmark on prod copy', {
      submitEditing: true
    })
    expect(await board.findByText('Benchmark on prod copy')).toBeOnTheScreen()

    await press(board.getByTestId('exit-demo'))
    await press(await screen.findByText('Try demo'))
    board = await openFromBell('Search endpoint')
    await press(board.getByTestId('segment-details'))
    expect(await board.findByTestId(`subtask-${DEMO_IDS.searchIndex}`)).toBeOnTheScreen()
    expect(board.queryByText('Benchmark on prod copy')).toBeNull()
    expect(mockKeychain.save).not.toHaveBeenCalled()
  })
})
