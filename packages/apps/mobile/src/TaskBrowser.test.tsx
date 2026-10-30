/**
 * The Tasks tab's board through the app's real data layer: `HubConnections` (one feed
 * per signed-in hub, each hub's board query in that hub's cache) → `TaskBrowser` → the
 * board inside its project's `HubScope`. Two hubs are signed in, each an in-memory tRPC
 * backend behind a stand-in for `HubScope` (`createFakeHubs`); both have a project `p`
 * (ids are per hub), so a write that went to the wrong hub shows in that hub's calls.
 */
import { act, fireEvent, render, screen, userEvent, within } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { Alert } from 'react-native'
import { createBoardPrefs } from './board/board-prefs'
import type { Rect } from './board/drag'
import type { Measure } from './board/ProjectBoard'
import type { BoardData } from './hub-board'
import { rowKey } from './hub-board'
import { HubConnections, useHubFeeds } from './hub-connections'
import type { HubSession } from './hub-session'
import {
  boardOf,
  createFakeHubs,
  feedOf,
  homeHub,
  projectOf,
  taskOf,
  workHub
} from './hubs/testing'
import { TaskBrowser, type TaskBrowserProps } from './TaskBrowser'

// The task's computer card and artifacts link read their hub (their own suites test them).
jest.mock('./computers/TaskComputer', () => ({ TaskComputer: () => null }))
jest.mock('./artifacts/TaskArtifactsLink', () => ({ TaskArtifactsLink: () => null }))

const mockHubs = createFakeHubs()
jest.mock('@slayzone/transport/client', () => {
  const actual = jest.requireActual('@slayzone/transport/client')
  const open = { status: 'open', error: null }
  return {
    ...actual,
    FederationProvider: ({ children }: { children: ReactNode }) => children,
    useFederation: () => ({ hubs: [], defaultHubId: 'local', resolve: () => null }),
    useHubConnection: () => open,
    HubScope: (props: { hubId: string; fallback?: ReactNode; children: ReactNode }) =>
      mockHubs.HubScope(props)
  }
})

/** A workflow column (its tone is a workflow token, not a colour the app paints). */
const TONE = 'slate'
const statusColumn = (id: string, label: string, position: number, category: string) => ({
  id,
  label,
  color: TONE,
  position,
  category
})

const COLUMNS = [
  statusColumn('queued', 'Queued', 0, 'unstarted'),
  statusColumn('doing', 'Doing', 1, 'started'),
  statusColumn('shipped', 'Shipped', 2, 'completed')
]

/** Work's project `p` ("API"): queued = a, (a1 subtask of a), b, (z archived), c; doing = d. */
function workBoard(): BoardData {
  return boardOf({
    projects: [projectOf('p', { name: 'API', columns_config: COLUMNS } as never)],
    tasks: [
      taskOf('a', { title: 'Alpha', status: 'queued', order: 0, priority: 1 }),
      taskOf('a1', { title: 'Alpha child', status: 'queued', order: 1, parent_id: 'a' }),
      taskOf('b', { title: 'Bravo', status: 'queued', order: 2 }),
      taskOf('z', { title: 'Zulu', status: 'queued', order: 3, archived_at: '2026-10-01' }),
      taskOf('c', { title: 'Charlie', status: 'queued', order: 4 }),
      taskOf('d', { title: 'Delta', status: 'doing', order: 0 })
    ]
  })
}
/** Home's project `p` ("Site", default columns), same id as work's. */
function homeBoard(): BoardData {
  return boardOf({
    projects: [projectOf('p', { name: 'Site' })],
    tasks: [taskOf('h1', { title: 'Home task', status: 'todo' })]
  })
}

interface Calls {
  update: unknown[]
  reorder: unknown[]
  setBlockers: unknown[]
}

function serve(hubId: string, board: () => BoardData, fail?: string): Calls {
  const calls: Calls = { update: [], reorder: [], setBlockers: [] }
  const write = (kind: keyof Calls) => (input: unknown) => {
    calls[kind].push(input)
    if (fail === kind) throw new Error('hub said no')
    return null
  }
  mockHubs.serve(hubId, {
    procedures: {
      'task.loadBoardData': board,
      'task.update': write('update'),
      'task.reorder': write('reorder'),
      'task.setBlockers': write('setBlockers'),
      'pty.sessionList': () => [],
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
  return calls
}

function memory() {
  let text: string | null = null
  return { read: () => text, write: (t: string) => void (text = t) }
}

const sessions: HubSession[] = [
  { entry: homeHub, token: 't-home' },
  { entry: workHub, token: 't-work' }
]

/** Window rects for drop targets, by testID (what `measureInWindow` reports on a device). */
const rects: Record<string, Rect> = {}
const measure: Measure = async (node) =>
  rects[(node as unknown as { props: { testID?: string } }).props.testID ?? ''] ?? null

function Board(props: Partial<TaskBrowserProps> & { prefs: TaskBrowserProps['prefs'] }) {
  const { feeds, retry } = useHubFeeds()
  return (
    <TaskBrowser
      feeds={feeds}
      layout="list"
      selected={null}
      onSelect={jest.fn()}
      onDeselect={jest.fn()}
      onRetry={retry}
      onSignOut={jest.fn()}
      onShowProjects={jest.fn()}
      onOpenAgent={jest.fn()}
      onNewTask={jest.fn()}
      measure={measure}
      {...props}
    />
  )
}

async function renderBoard(
  props: Partial<TaskBrowserProps> & { prefs: TaskBrowserProps['prefs'] }
) {
  await render(
    <HubConnections sessions={sessions}>
      <Board {...props} />
    </HubConnections>
  )
  await screen.findByText('Site ▾')
}

/** Switch to work's project (same id as home's). */
async function pickWork() {
  const user = userEvent.setup()
  await user.press(screen.getByTestId('project-switcher'))
  await user.press(within(screen.getByTestId('project-picker')).getByText('API'))
  await screen.findByText('API ▾')
}

/** Writes answered and React Query's batched notifications (a 0 ms timer) delivered. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
  })

const cardOrder = () =>
  screen.queryAllByTestId(/^task-card-/).map((el) => el.props.testID.replace('task-card-', ''))

let home: Calls
let work: Calls
beforeEach(() => {
  home = serve(homeHub.id, homeBoard)
  work = serve(workHub.id, workBoard)
  for (const k of Object.keys(rects)) delete rects[k]
})

describe('TaskBrowser: the board', () => {
  it("shows the first hub's first project; the picker switches to a project of another hub", async () => {
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    expect(screen.getByText('Home task')).toBeOnTheScreen()
    await pickWork()
    // The project's own columns; the phone shows the first column with tasks.
    expect(screen.getByTestId('column-chip-queued')).toHaveTextContent('Queued 3')
    expect(screen.getByTestId('column-chip-doing')).toHaveTextContent('Doing 1')
    expect(cardOrder()).toEqual(['a', 'b', 'c'])
    await userEvent.setup().press(screen.getByTestId('column-chip-doing'))
    expect(cardOrder()).toEqual(['d'])
  })

  it('remembers the project, the view and its filters on the device', async () => {
    const storage = memory()
    await renderBoard({ prefs: createBoardPrefs(storage) })
    await pickWork()
    const user = userEvent.setup()
    await user.press(screen.getByTestId('view-list'))
    await user.press(screen.getByTestId('filter-button'))
    await user.press(screen.getByTestId('priority-1'))
    await user.press(screen.getByText('Done'))
    expect(screen.getByText('Filter •')).toBeOnTheScreen()
    expect(cardOrder()).toEqual(['a'])

    // A new board (the next launch) reads what this one kept.
    await screen.rerender(
      <HubConnections sessions={sessions}>
        <Board key="next launch" prefs={createBoardPrefs(storage)} />
      </HubConnections>
    )
    expect(await screen.findByText('API ▾')).toBeOnTheScreen()
    expect(screen.getByTestId('view-list')).toBeSelected()
    expect(cardOrder()).toEqual(['a'])
    expect(createBoardPrefs(storage).load().filters[rowKey(workHub.id, 'p')]?.priority).toBe(1)
  })

  it('list shows every column as a section; tree nests subtasks under their parent', async () => {
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    const user = userEvent.setup()
    await user.press(screen.getByTestId('view-list'))
    expect(cardOrder()).toEqual(['a', 'b', 'c', 'd'])
    expect(within(screen.getByTestId('column-shipped')).getByText('Shipped')).toBeOnTheScreen()
    await user.press(screen.getByTestId('view-tree'))
    expect(cardOrder()).toEqual(['a', 'a1', 'b', 'c', 'd'])
    // A subtask says its own status.
    expect(
      within(screen.getByTestId('task-card-a1')).getByText(`Queued · ${workHub.label}`)
    ).toBeOnTheScreen()
  })

  it("swipe left moves a card to its project's next status, on the hub that owns it", async () => {
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    const card = screen.getByTestId('task-card-b')
    await fireEvent(card, 'touchStart', { nativeEvent: { pageX: 300, pageY: 10 } })
    await fireEvent(card, 'responderMove', { nativeEvent: { pageX: 180, pageY: 12 } })
    expect(within(card).getByText('Doing ›')).toBeOnTheScreen()
    await fireEvent(card, 'responderRelease', { nativeEvent: { pageX: 180, pageY: 12 } })
    await settle()

    expect(work.update).toEqual([{ id: 'b', status: 'doing' }])
    expect(work.reorder).toEqual([])
    expect(home.update).toEqual([])
    // At once, before the hub's reload.
    expect(screen.getByTestId('column-chip-doing')).toHaveTextContent('Doing 2')
    expect(cardOrder()).toEqual(['a', 'c'])
  })

  it('a short swipe changes nothing', async () => {
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    const card = screen.getByTestId('task-card-b')
    await fireEvent(card, 'touchStart', { nativeEvent: { pageX: 300, pageY: 10 } })
    await fireEvent(card, 'responderMove', { nativeEvent: { pageX: 260, pageY: 10 } })
    await fireEvent(card, 'responderRelease', { nativeEvent: { pageX: 260, pageY: 10 } })
    expect(work.update).toEqual([])
  })

  it('drag reorders within a column: the full ordered list (subtasks, archived) to the owning hub', async () => {
    Object.assign(rects, {
      'project-board': { x: 0, y: 100, width: 390, height: 700 },
      'column-queued': { x: 0, y: 140, width: 390, height: 600 },
      'task-a': { x: 0, y: 180, width: 390, height: 50 },
      'task-b': { x: 0, y: 230, width: 390, height: 50 },
      'task-c': { x: 0, y: 280, width: 390, height: 50 }
    })
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    // Drag Charlie above Bravo.
    await fireEvent(screen.getByTestId('task-c'), 'longPress', {
      nativeEvent: { pageX: 50, pageY: 300 }
    })
    await settle()
    const board = screen.getByTestId('project-board')
    await fireEvent(board, 'responderMove', { nativeEvent: { pageX: 50, pageY: 240 } })
    await fireEvent(board, 'responderRelease', { nativeEvent: { pageX: 50, pageY: 240 } })
    await settle()

    expect(work.reorder).toEqual([{ taskIds: ['a', 'a1', 'c', 'b', 'z'] }])
    expect(work.update).toEqual([])
    expect(home.reorder).toEqual([])
    expect(cardOrder()).toEqual(['a', 'c', 'b'])
  })

  it('drag between columns (iPad, side by side): status + full list of the new column', async () => {
    Object.assign(rects, {
      'project-board': { x: 0, y: 100, width: 1000, height: 700 },
      'column-queued': { x: 0, y: 140, width: 290, height: 600 },
      'column-doing': { x: 300, y: 140, width: 290, height: 600 },
      'column-shipped': { x: 600, y: 140, width: 290, height: 600 },
      'task-a': { x: 0, y: 180, width: 290, height: 50 },
      'task-d': { x: 300, y: 180, width: 290, height: 50 }
    })
    await renderBoard({ prefs: createBoardPrefs(memory()), layout: 'split' })
    await pickWork()
    await fireEvent(screen.getByTestId('task-a'), 'longPress', {
      nativeEvent: { pageX: 50, pageY: 200 }
    })
    await settle()
    const board = screen.getByTestId('project-board')
    // Below Delta: the end of Doing.
    await fireEvent(board, 'responderMove', { nativeEvent: { pageX: 400, pageY: 500 } })
    await fireEvent(board, 'responderRelease', { nativeEvent: { pageX: 400, pageY: 500 } })
    await settle()

    expect(work.update).toEqual([{ id: 'a', status: 'doing' }])
    expect(work.reorder).toEqual([{ taskIds: ['d', 'a'] }])
    expect(within(screen.getByTestId('column-doing')).getByText('Alpha')).toBeOnTheScreen()
  })

  it('a refused move puts the board back and says why', async () => {
    work = serve(workHub.id, workBoard, 'reorder')
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    await fireEvent(screen.getByTestId('task-b'), 'accessibilityAction', {
      nativeEvent: { actionName: 'down' }
    })
    await settle()
    expect(work.reorder).toEqual([{ taskIds: ['a', 'a1', 'z', 'c', 'b'] }])
    expect(cardOrder()).toEqual(['a', 'b', 'c'])
    expect(alert).toHaveBeenCalledWith("Couldn't move the task", 'hub said no')
    alert.mockRestore()
  })

  it('VoiceOver actions move to the next status and one place up', async () => {
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    await fireEvent(screen.getByTestId('task-c'), 'accessibilityAction', {
      nativeEvent: { actionName: 'up' }
    })
    await settle()
    expect(work.reorder).toEqual([{ taskIds: ['a', 'a1', 'c', 'b', 'z'] }])
    await fireEvent(screen.getByTestId('task-a'), 'accessibilityAction', {
      nativeEvent: { actionName: 'next' }
    })
    await settle()
    expect(work.update).toEqual([{ id: 'a', status: 'doing' }])
  })

  it('shows blocked tasks in a Blocked column; dragging one out unblocks it and clears its blockers', async () => {
    const blocked = () => ({ ...workBoard(), blockedTaskIds: ['b'] })
    work = serve(workHub.id, blocked)
    Object.assign(rects, {
      'project-board': { x: 0, y: 100, width: 1000, height: 700 },
      'column-queued': { x: 0, y: 140, width: 290, height: 600 },
      'column-doing': { x: 300, y: 140, width: 290, height: 600 },
      'column-__blocked__': { x: 600, y: 140, width: 290, height: 600 },
      'task-b': { x: 600, y: 180, width: 290, height: 50 }
    })
    await renderBoard({ prefs: createBoardPrefs(memory()), layout: 'split' })
    await pickWork()
    const user = userEvent.setup()
    await user.press(screen.getByTestId('filter-button'))
    await fireEvent(screen.getByTestId('show-blocked'), 'valueChange', true)
    await user.press(screen.getByText('Done'))
    expect(within(screen.getByTestId('column-__blocked__')).getByText('Bravo')).toBeOnTheScreen()

    await fireEvent(screen.getByTestId('task-b'), 'longPress', {
      nativeEvent: { pageX: 650, pageY: 200 }
    })
    await settle()
    const board = screen.getByTestId('project-board')
    await fireEvent(board, 'responderMove', { nativeEvent: { pageX: 50, pageY: 500 } })
    await fireEvent(board, 'responderRelease', { nativeEvent: { pageX: 50, pageY: 500 } })
    await settle()
    expect(work.update).toEqual([{ id: 'b', isBlocked: false, blockedComment: null }])
    expect(work.reorder).toEqual([{ taskIds: ['a', 'a1', 'z', 'c', 'b'] }])
    expect(work.setBlockers).toEqual([{ taskId: 'b', blockerTaskIds: [] }])
  })

  it('"+" creates a task in the shown project; a column\'s "+" with its status', async () => {
    const onNewTask = jest.fn()
    await renderBoard({ prefs: createBoardPrefs(memory()), onNewTask })
    await pickWork()
    const user = userEvent.setup()
    await user.press(screen.getByTestId('new-task'))
    expect(onNewTask).toHaveBeenLastCalledWith({
      hub: workHub.label,
      project: 'p',
      status: undefined
    })
    await user.press(screen.getByTestId('new-task-queued'))
    expect(onNewTask).toHaveBeenLastCalledWith({
      hub: workHub.label,
      project: 'p',
      status: 'queued'
    })
  })

  it('opens a tapped task with its hub (both hubs have a project p)', async () => {
    const onSelect = jest.fn()
    await renderBoard({ prefs: createBoardPrefs(memory()), onSelect })
    await pickWork()
    await userEvent.setup().press(screen.getByText('Bravo'))
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        hubId: workHub.id,
        hubLabel: workHub.label,
        task: expect.objectContaining({ id: 'b' })
      })
    )
  })

  it('on a wide screen shows the selected task beside the board; Agent and Close', async () => {
    const onOpenAgent = jest.fn()
    const onDeselect = jest.fn()
    await renderBoard({
      prefs: createBoardPrefs(memory()),
      layout: 'split',
      selected: { hubId: workHub.id, taskId: 'b' },
      onOpenAgent,
      onDeselect
    })
    const beside = within(screen.getByTestId('task-beside-board'))
    expect(beside.getByText('Bravo')).toBeOnTheScreen()
    const user = userEvent.setup()
    await user.press(beside.getByText('Agent ›'))
    expect(onOpenAgent).toHaveBeenCalledWith(expect.objectContaining({ hubId: workHub.id }))
    await user.press(beside.getByText('Close'))
    expect(onDeselect).toHaveBeenCalled()
  })
})

describe('TaskBrowser: hubs', () => {
  const base = (fields: Partial<TaskBrowserProps>): TaskBrowserProps => ({
    feeds: [],
    layout: 'list',
    selected: null,
    onSelect: jest.fn(),
    onDeselect: jest.fn(),
    onRetry: jest.fn(),
    onSignOut: jest.fn(),
    onShowProjects: jest.fn(),
    onOpenAgent: jest.fn(),
    onNewTask: jest.fn(),
    prefs: createBoardPrefs(memory()),
    ...fields
  })

  // The project picker reads every hub's projects itself.
  const inApp = (ui: ReactNode) => render(<HubConnections sessions={[]}>{ui}</HubConnections>)

  it('shows the first load under way', async () => {
    await inApp(<TaskBrowser {...base({ feeds: [feedOf(homeHub, undefined)] })} />)
    expect(screen.getByTestId('board-loading')).toBeOnTheScreen()
    expect(screen.queryByText('No projects')).toBeNull()
  })

  it("says when a hub can't be reached, with Retry and Sign out", async () => {
    const onRetry = jest.fn()
    const onSignOut = jest.fn()
    const feeds = [
      feedOf(homeHub, undefined, {
        connection: { status: 'connecting', error: new Error('WebSocket closed') },
        stalled: true
      }),
      feedOf(workHub, boardOf({}))
    ]
    await inApp(<TaskBrowser {...base({ feeds, onRetry, onSignOut })} />)
    expect(screen.getByText('No projects')).toBeOnTheScreen()
    const user = userEvent.setup()
    await user.press(screen.getByText('Retry'))
    expect(onRetry).toHaveBeenCalledWith(homeHub.id)
    await user.press(screen.getByText('Sign out'))
    expect(onSignOut).toHaveBeenCalledWith(homeHub.id)
  })

  it("opens every hub's projects", async () => {
    const onShowProjects = jest.fn()
    await inApp(<TaskBrowser {...base({ onShowProjects })} />)
    await userEvent.setup().press(screen.getByText('Projects'))
    expect(onShowProjects).toHaveBeenCalled()
  })
})
