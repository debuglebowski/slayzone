/**
 * The board (home) through the app's real data layer: `HubConnections` (one feed per
 * signed-in hub, each hub's board query in that hub's cache) → `BoardHome` → the board
 * inside its project's `HubScope`. Two hubs are signed in, each an in-memory tRPC
 * backend behind a stand-in for `HubScope` (`createFakeHubs`); both have a project `p`
 * (ids are per hub), so a write that went to the wrong hub shows in that hub's calls.
 */
import { act, fireEvent, render, screen, userEvent, within } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { ActionSheetIOS, Alert, Dimensions } from 'react-native'
import { createBoardPrefs } from '../board/board-prefs'
import type { Rect } from '../board/drag'
import type { Measure } from '../board/ProjectBoard'
import type { BoardData } from '../hub-board'
import { rowKey } from '../hub-board'
import { HubConnections, useHubFeeds } from '../hub-connections'
import type { HubSession } from '../hub-session'
import {
  boardOf,
  createFakeHubs,
  feedOf,
  homeHub,
  projectOf,
  taskOf,
  workHub
} from '../hubs/testing'
import { BoardHome, type BoardHomeProps } from './BoardHome'
import { OpenTasksProvider } from './OpenTasksProvider'

// A task opened on an iPad: the task page has suites of its own.
jest.mock('../task/TaskPage', () => ({
  ...jest.requireActual('../task/TaskPage'),
  TaskPage: (p: import('../task/TaskPage').TaskPageProps) => {
    const { Text } = jest.requireActual('react-native')
    return <Text>{`task page ${p.row.task.id} ${p.segment}`}</Text>
  }
}))

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
  create: unknown[]
  createTask: unknown[]
  update: unknown[]
  reorder: unknown[]
  setBlockers: unknown[]
  archiveMany: unknown[]
}

function serve(hubId: string, board: () => BoardData, fail?: string): Calls {
  const calls: Calls = {
    create: [],
    createTask: [],
    update: [],
    reorder: [],
    setBlockers: [],
    archiveMany: []
  }
  const write = (kind: Exclude<keyof Calls, 'create' | 'createTask'>) => (input: unknown) => {
    calls[kind].push(input)
    if (fail === kind) throw new Error('hub said no')
    return null
  }
  mockHubs.serve(hubId, {
    procedures: {
      'task.loadBoardData': board,
      'task.update': write('update'),
      'task.create': (input: { title: string }) => {
        calls.createTask.push(input)
        if (fail === 'createTask') throw new Error('hub said no')
        return taskOf('new-t', { title: input.title, is_temporary: true })
      },
      'task.reorder': write('reorder'),
      'task.setBlockers': write('setBlockers'),
      'task.archiveMany': write('archiveMany'),
      'pty.sessionList': () => [],
      'projects.create': (input: unknown) => {
        calls.create.push(input)
        return { id: 'new-p' }
      },
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

type BoardProps = Partial<BoardHomeProps> & { prefs: BoardHomeProps['prefs'] }

function Board(props: BoardProps) {
  const { feeds, retry } = useHubFeeds()
  return (
    <BoardHome
      feeds={feeds}
      sessions={sessions}
      wide={false}
      onRetry={retry}
      onSignOut={jest.fn()}
      onOpenTask={jest.fn()}
      onNewTask={jest.fn()}
      onOpenProject={jest.fn()}
      onOpenArtifact={jest.fn()}
      measure={measure}
      {...props}
    />
  )
}

const app = (props: BoardProps) => (
  <HubConnections sessions={sessions}>
    <OpenTasksProvider>
      <Board {...props} />
    </OpenTasksProvider>
  </HubConnections>
)

async function renderBoard(props: BoardProps) {
  await render(app(props))
  expect(await screen.findByText('Site')).toBeOnTheScreen()
}

/** Switch to work's project (same id as home's). */
async function pickWork() {
  const user = userEvent.setup()
  await user.press(screen.getByTestId('project-switcher'))
  await user.press(within(screen.getByTestId('project-switcher-sheet')).getByText('API'))
  await screen.findByText('API')
}

/**
 * ⋯ (the board's menu, iOS's own action sheet): opens it and returns its entries;
 * with `label`, picks the entry that starts with it (else Cancel).
 */
async function menu(label?: string): Promise<string[]> {
  let shown: string[] = []
  let pick: ((index: number) => void) | null = null
  let cancel = -1
  const spy = jest
    .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
    .mockImplementation((options, callback) => {
      shown = options.options
      cancel = options.cancelButtonIndex ?? -1
      pick = callback
    })
  await userEvent.setup().press(screen.getByTestId('board-menu'))
  spy.mockRestore()
  expect(pick).not.toBeNull()
  const index = label === undefined ? cancel : shown.findIndex((s) => s.startsWith(label))
  if (label !== undefined) expect([label, index >= 0]).toEqual([label, true])
  await act(async () => pick?.(index))
  return shown
}

/** Writes answered and React Query's batched notifications (a 0 ms timer) delivered. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
  })

/** The cards of one column, in order (a phone keeps every column's page mounted). */
const cardOrder = (column: string) =>
  within(screen.getByTestId(`column-${column}`))
    .queryAllByTestId(/^task-[a-z0-9]+$/)
    .map((el) => el.props.testID.replace('task-', ''))

function phone() {
  const window = { width: 390, height: 844, scale: 3, fontScale: 1 }
  Dimensions.set({ window, screen: window })
}

let home: Calls
let work: Calls
beforeEach(() => {
  phone()
  home = serve(homeHub.id, homeBoard)
  work = serve(workHub.id, workBoard)
  for (const k of Object.keys(rects)) delete rects[k]
})

describe('BoardHome: the board (phone)', () => {
  it("shows the first hub's first project; the switcher switches to a project of another hub", async () => {
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    expect(screen.getByText('Home task')).toBeOnTheScreen()
    await pickWork()
    // The project's own columns, with their counts; the first with tasks is shown.
    expect(screen.getByTestId('column-chip-queued')).toHaveTextContent('Queued 3')
    expect(screen.getByTestId('column-chip-doing')).toHaveTextContent('Doing 1')
    expect(screen.getByTestId('column-chip-queued')).toBeSelected()
    expect(cardOrder('queued')).toEqual(['a', 'b', 'c'])
    await userEvent.setup().press(screen.getByTestId('column-chip-doing'))
    expect(screen.getByTestId('column-chip-doing')).toBeSelected()
  })

  it('swiping the board sideways shows the next column', async () => {
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    await fireEvent(screen.getByTestId('column-pager'), 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: 390, y: 0 } }
    })
    expect(screen.getByTestId('column-chip-doing')).toBeSelected()
  })

  it("draws desktop's card: priority, agent dot, sub-task ring, tags, Blocked, overdue due date", async () => {
    const rich = (): BoardData =>
      ({
        ...workBoard(),
        tasks: workBoard().tasks.map((t) =>
          t.id === 'a' ? { ...t, due_date: '2000-01-01', needs_attention: true } : t
        ),
        tags: [{ id: 'g', name: 'design', color: 'tag-bg', text_color: 'tag-fg' }],
        taskTags: { a: ['g'] },
        blockedTaskIds: ['a']
      }) as BoardData
    work = serve(workHub.id, rich)
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    const card = within(screen.getByTestId('task-a'))
    expect(card.getByTestId('priority-urgent')).toBeOnTheScreen()
    expect(card.getByLabelText('0 of 1 subtasks done')).toBeOnTheScreen()
    expect(card.getByText('design')).toBeOnTheScreen()
    expect(card.getByText('Blocked')).toBeOnTheScreen()
    expect(card.getByTestId('card-due')).toHaveTextContent('2000-01-01')
  })

  it('remembers the project, the view and its filters on the device', async () => {
    const storage = memory()
    await renderBoard({ prefs: createBoardPrefs(storage) })
    await pickWork()
    const user = userEvent.setup()
    expect(screen.queryByTestId('board-menu-dot')).toBeNull()
    await menu('List view')
    await menu('Filter…')
    await user.press(screen.getByTestId('priority-1'))
    await user.press(screen.getByText('Done'))
    // An active filter is never invisible: a dot on ⋯.
    expect(screen.getByTestId('board-menu-dot')).toBeOnTheScreen()
    expect(cardOrder('queued')).toEqual(['a'])

    // A new board (the next launch) reads what this one kept.
    await screen.rerender(
      <HubConnections sessions={sessions}>
        <OpenTasksProvider>
          <Board key="next launch" prefs={createBoardPrefs(storage)} />
        </OpenTasksProvider>
      </HubConnections>
    )
    expect(await screen.findByText('API')).toBeOnTheScreen()
    expect(await menu()).toContain('List view ✓')
    expect(cardOrder('queued')).toEqual(['a'])
    expect(createBoardPrefs(storage).load().filters[rowKey(workHub.id, 'p')]?.priority).toBe(1)
  })

  it('list shows every column as a section; a phone has no tree (a kept tree shows the board)', async () => {
    const storage = memory()
    createBoardPrefs(storage).save({ project: null, view: 'tree', filters: {} })
    await renderBoard({ prefs: createBoardPrefs(storage) })
    const entries = await menu()
    expect(entries).toContain('Board view ✓')
    expect(entries.some((e) => e.startsWith('Tree'))).toBe(false)
    await pickWork()
    await menu('List view')
    expect(cardOrder('queued')).toEqual(['a', 'b', 'c'])
    expect(cardOrder('doing')).toEqual(['d'])
    expect(within(screen.getByTestId('column-shipped')).getByText('Shipped')).toBeOnTheScreen()
    // The list groups by itself: no column strip.
    expect(screen.queryByTestId('column-chip-queued')).toBeNull()
    await menu('Display…')
    expect(screen.queryByTestId('display-view-tree')).toBeNull()
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
    expect(cardOrder('queued')).toEqual(['a', 'c', 'b'])
  })

  it("a phone drag dropped on a column's pill moves the card there", async () => {
    Object.assign(rects, {
      'project-board': { x: 0, y: 100, width: 390, height: 700 },
      'column-queued': { x: 0, y: 140, width: 390, height: 600 },
      'column-drop-doing': { x: 120, y: 100, width: 80, height: 30 },
      'task-b': { x: 0, y: 230, width: 390, height: 50 }
    })
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    await fireEvent(screen.getByTestId('task-b'), 'longPress', {
      nativeEvent: { pageX: 50, pageY: 250 }
    })
    await settle()
    const board = screen.getByTestId('project-board')
    await fireEvent(board, 'responderMove', { nativeEvent: { pageX: 150, pageY: 110 } })
    await fireEvent(board, 'responderRelease', { nativeEvent: { pageX: 150, pageY: 110 } })
    await settle()
    expect(work.update).toEqual([{ id: 'b', status: 'doing' }])
    expect(screen.getByTestId('column-chip-doing')).toHaveTextContent('Doing 2')
  })

  it("dragging a card to the screen's edge turns to the next column", async () => {
    Object.assign(rects, {
      'project-board': { x: 0, y: 100, width: 390, height: 700 },
      'column-queued': { x: 0, y: 140, width: 390, height: 600 },
      'task-b': { x: 0, y: 230, width: 390, height: 50 }
    })
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    await fireEvent(screen.getByTestId('task-b'), 'longPress', {
      nativeEvent: { pageX: 50, pageY: 250 }
    })
    await settle()
    await fireEvent(screen.getByTestId('project-board'), 'responderMove', {
      nativeEvent: { pageX: 385, pageY: 300 }
    })
    expect(screen.getByTestId('column-chip-doing')).toBeSelected()
    await fireEvent(screen.getByTestId('project-board'), 'responderTerminate', {})
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
    expect(cardOrder('queued')).toEqual(['a', 'b', 'c'])
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

  it('a tap on the floating "＋" starts a temporary task in the shown project and opens it', async () => {
    const onNewTask = jest.fn()
    const onOpenTask = jest.fn()
    await renderBoard({ prefs: createBoardPrefs(memory()), onNewTask, onOpenTask })
    await pickWork()
    await userEvent.setup().press(screen.getByLabelText('New session'))
    await settle()
    expect(work.createTask).toEqual([
      {
        projectId: 'p',
        title: 'Terminal 1',
        status: 'queued',
        isTemporary: true,
        openAfterCreate: true
      }
    ])
    expect(onOpenTask).toHaveBeenCalledWith(
      expect.objectContaining({ hubId: workHub.id, task: expect.objectContaining({ id: 'new-t' }) })
    )
    expect(onNewTask).not.toHaveBeenCalled()
  })

  it('a temporary task the hub refuses: an alert, and the ＋ is back', async () => {
    work = serve(workHub.id, workBoard, 'createTask')
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    const onOpenTask = jest.fn()
    await renderBoard({ prefs: createBoardPrefs(memory()), onOpenTask })
    await pickWork()
    await userEvent.setup().press(screen.getByTestId('new-task'))
    await settle()
    expect(alert).toHaveBeenCalledWith("Couldn't start a session", 'hub said no')
    expect(onOpenTask).not.toHaveBeenCalled()
    expect(screen.queryByTestId('new-session-creating')).toBeNull()
    alert.mockRestore()
  })

  it('a long-press on the floating "＋" creates a task in the shown project and column; no other "＋"', async () => {
    const onNewTask = jest.fn()
    await renderBoard({ prefs: createBoardPrefs(memory()), onNewTask })
    await pickWork()
    const user = userEvent.setup()
    expect(screen.queryByTestId('new-task-queued')).toBeNull()
    expect(screen.getByHintText('Long-press: New task in Queued')).toBeOnTheScreen()
    await user.longPress(screen.getByTestId('new-task'))
    expect(onNewTask).toHaveBeenLastCalledWith({
      hub: workHub.label,
      project: 'p',
      status: 'queued'
    })
    await user.press(screen.getByTestId('column-chip-doing'))
    await user.longPress(screen.getByTestId('new-task'))
    expect(onNewTask).toHaveBeenLastCalledWith({
      hub: workHub.label,
      project: 'p',
      status: 'doing'
    })
    // The list has no current column: the project's default status.
    await menu('List view')
    await user.longPress(screen.getByTestId('new-task'))
    expect(onNewTask).toHaveBeenLastCalledWith({
      hub: workHub.label,
      project: 'p',
      status: undefined
    })
  })

  it('the strip is the only column navigation: chips with icon, name, count; no column header row', async () => {
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    expect(screen.getByLabelText('Queued, 3 tasks')).toBeOnTheScreen()
    expect(
      within(screen.getByTestId('column-chip-queued')).getByTestId('status-icon')
    ).toBeOnTheScreen()
    expect(within(screen.getByTestId('column-queued')).queryByText('Queued')).toBeNull()
  })

  it('⋯ "Clear filters" clears an active filter (offered only while one is)', async () => {
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    expect((await menu()).includes('Clear filters')).toBe(false)
    await menu('Filter…')
    await userEvent.setup().press(screen.getByTestId('priority-1'))
    await userEvent.setup().press(screen.getByText('Done'))
    expect(cardOrder('queued')).toEqual(['a'])
    await menu('Clear filters')
    expect(screen.queryByTestId('board-menu-dot')).toBeNull()
    expect(cardOrder('queued')).toEqual(['a', 'b', 'c'])
  })

  it('Display "Show empty columns" (on by default, as desktop) hides empty columns from the strip', async () => {
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    expect(screen.getByTestId('column-chip-backlog')).toBeOnTheScreen()
    await menu('Display…')
    await fireEvent(screen.getByTestId('show-empty'), 'valueChange', false)
    await userEvent.setup().press(screen.getByText('Done'))
    expect(screen.queryByTestId('column-chip-backlog')).toBeNull()
    expect(screen.getByTestId('column-chip-todo')).toBeOnTheScreen()
  })

  it('⋯ "Archive all in <done column>" archives its tasks on the owning hub, after asking', async () => {
    const withDone = (): BoardData =>
      ({
        ...workBoard(),
        tasks: [...workBoard().tasks, taskOf('e', { title: 'Echo', status: 'shipped', order: 0 })]
      }) as BoardData
    work = serve(workHub.id, withDone)
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_t, _m, buttons) =>
        buttons?.find((b) => b.text === 'Archive')?.onPress?.()
      )
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    expect((await menu()).some((e) => e.startsWith('Archive all in Queued'))).toBe(false)
    await menu('Archive all in Shipped (1)')
    await settle()
    expect(work.archiveMany).toEqual([{ ids: ['e'] }])
    expect(home.archiveMany).toEqual([])
    expect(screen.queryByText('Echo')).toBeNull()
    alert.mockRestore()
  })

  /** ⋯ → Display…, then `act` on the open sheet, then Done. */
  async function display(act: () => Promise<void>) {
    await menu('Display…')
    await act()
    await userEvent.setup().press(screen.getByText('Done'))
  }
  const press = (testID: string) => userEvent.setup().press(screen.getByTestId(testID))

  it('Display "Group by: Priority": the strip shows priority groups; a drop on one sets the priority', async () => {
    const onNewTask = jest.fn()
    const storage = memory()
    Object.assign(rects, {
      'project-board': { x: 0, y: 100, width: 390, height: 700 },
      'column-p3': { x: 0, y: 140, width: 390, height: 600 },
      'column-drop-p1': { x: 120, y: 100, width: 80, height: 30 },
      'task-b': { x: 0, y: 230, width: 390, height: 50 }
    })
    await renderBoard({ prefs: createBoardPrefs(storage), onNewTask })
    await pickWork()
    await display(async () => {
      expect(screen.queryByTestId('display-group-none')).toBeNull()
      await press('display-group-priority')
    })
    expect(screen.getByLabelText('Urgent, 1 task')).toBeOnTheScreen()
    expect(
      within(screen.getByTestId('column-chip-p1')).getByTestId('priority-urgent')
    ).toBeOnTheScreen()
    expect(screen.queryByTestId('column-chip-queued')).toBeNull()
    // Saved per project, like the other board prefs.
    expect(createBoardPrefs(storage).load().filters[rowKey(workHub.id, 'p')]?.groupBy).toBe(
      'priority'
    )

    // The ＋ creates in the shown group: its priority (desktop's column ＋).
    await press('column-chip-p3')
    await userEvent.setup().longPress(screen.getByTestId('new-task'))
    expect(onNewTask).toHaveBeenLastCalledWith({ hub: workHub.label, project: 'p', priority: 3 })

    // Bravo (Medium) onto the Urgent pill.
    await fireEvent(screen.getByTestId('task-b'), 'longPress', {
      nativeEvent: { pageX: 50, pageY: 250 }
    })
    await settle()
    const board = screen.getByTestId('project-board')
    await fireEvent(board, 'responderMove', { nativeEvent: { pageX: 150, pageY: 110 } })
    await fireEvent(board, 'responderRelease', { nativeEvent: { pageX: 150, pageY: 110 } })
    await settle()
    expect(work.update).toEqual([{ id: 'b', priority: 1 }])
    expect(work.reorder).toEqual([{ taskIds: ['a', 'b'] }])
    expect(cardOrder('p1')).toEqual(['a', 'b'])
    // Archive all is about completed status columns: none while grouped by priority.
    expect((await menu()).some((e) => e.startsWith('Archive all'))).toBe(false)
  })

  it('Display "Group by: Due date" groups by due date and turns drag off (desktop)', async () => {
    Object.assign(rects, {
      'project-board': { x: 0, y: 100, width: 390, height: 700 },
      'column-no_date': { x: 0, y: 140, width: 390, height: 600 },
      'task-b': { x: 0, y: 230, width: 390, height: 50 },
      'task-a': { x: 0, y: 180, width: 390, height: 50 }
    })
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    await display(() => press('display-group-due_date'))
    expect(screen.getByLabelText('No Date, 4 tasks')).toBeOnTheScreen()
    await fireEvent(screen.getByTestId('task-b'), 'longPress', {
      nativeEvent: { pageX: 50, pageY: 250 }
    })
    await settle()
    const board = screen.getByTestId('project-board')
    await fireEvent(board, 'responderMove', { nativeEvent: { pageX: 50, pageY: 190 } })
    await fireEvent(board, 'responderRelease', { nativeEvent: { pageX: 50, pageY: 190 } })
    await settle()
    expect(work.reorder).toEqual([])
    expect(work.update).toEqual([])
  })

  it('Display "Sort": sorts every column; reorder only with Manual or Priority (desktop)', async () => {
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    await display(() => press('display-sort-title'))
    expect(cardOrder('queued')).toEqual(['a', 'b', 'c'])
    // No "Move up/down" where a reorder would not stick; status moves stay.
    const actions = (id: string) =>
      (screen.getByTestId(id).props.accessibilityActions ?? []).map((a: { name: string }) => a.name)
    expect(actions('task-b')).not.toContain('up')
    expect(actions('task-b')).toContain('next')
    await display(() => press('display-sort-manual'))
    expect(actions('task-b')).toContain('up')
  })

  it('Display "Show archived" and "Show sub-tasks" add those tasks as cards', async () => {
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    await display(async () => {
      await fireEvent(screen.getByTestId('show-archived'), 'valueChange', true)
      await fireEvent(screen.getByTestId('show-subtasks'), 'valueChange', true)
    })
    expect(cardOrder('queued')).toEqual(['a', 'a1', 'b', 'z', 'c'])
  })

  it('the list also groups by "No groups" and "Activity"', async () => {
    await renderBoard({ prefs: createBoardPrefs(memory()) })
    await pickWork()
    await menu('List view')
    await display(() => press('display-group-none'))
    expect(cardOrder('all')).toEqual(['a', 'd', 'b', 'c'])
    await display(() => press('display-group-active'))
    expect(cardOrder('inactive')).toEqual(['a', 'd', 'b', 'c'])
  })

  it("a link's ?sheet=menu opens ⋯", async () => {
    const spy = jest
      .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation(() => {})
    await renderBoard({ prefs: createBoardPrefs(memory()), sheetParam: 'menu' })
    await settle()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0].options).toContain('Filter…')
    spy.mockRestore()
  })

  it("a link's ?sheet=display opens Display, ?sheet=filter Filter", async () => {
    await renderBoard({ prefs: createBoardPrefs(memory()), sheetParam: 'display' })
    expect(await screen.findByTestId('display-group-priority')).toBeOnTheScreen()
    await screen.rerender(app({ prefs: createBoardPrefs(memory()), sheetParam: 'filter' }))
    expect(await screen.findByTestId('priority-any')).toBeOnTheScreen()
  })

  it('opens a tapped card with its hub (both hubs have a project p)', async () => {
    const onOpenTask = jest.fn()
    await renderBoard({ prefs: createBoardPrefs(memory()), onOpenTask })
    await pickWork()
    await userEvent.setup().press(screen.getByText('Bravo'))
    expect(onOpenTask).toHaveBeenCalledWith(
      expect.objectContaining({
        hubId: workHub.id,
        hubLabel: workHub.label,
        task: expect.objectContaining({ id: 'b' })
      })
    )
  })
})

describe('BoardHome: iPad', () => {
  it('drag between columns side by side: status + full list of the new column', async () => {
    Object.assign(rects, {
      'project-board': { x: 0, y: 100, width: 1000, height: 700 },
      'column-queued': { x: 0, y: 140, width: 290, height: 600 },
      'column-doing': { x: 300, y: 140, width: 290, height: 600 },
      'column-shipped': { x: 600, y: 140, width: 290, height: 600 },
      'task-a': { x: 0, y: 180, width: 290, height: 50 },
      'task-d': { x: 300, y: 180, width: 290, height: 50 }
    })
    await render(app({ prefs: createBoardPrefs(memory()), wide: true }))
    await screen.findAllByTestId('rail-p')
    await userEvent.setup().press(screen.getAllByTestId('rail-p')[1])
    // The board tab says the project (no title row of its own).
    await screen.findByText('⌂ API')
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
    await render(app({ prefs: createBoardPrefs(memory()), wide: true }))
    await screen.findAllByTestId('rail-p')
    const user = userEvent.setup()
    await user.press(screen.getAllByTestId('rail-p')[1])
    // The board tab says the project (no title row of its own).
    await screen.findByText('⌂ API')
    await menu('Display…')
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

  it('the Display menu offers the tree: subtasks nested under their parent', async () => {
    await render(app({ prefs: createBoardPrefs(memory()), wide: true }))
    await screen.findAllByTestId('rail-p')
    const user = userEvent.setup()
    await user.press(screen.getAllByTestId('rail-p')[1])
    // The board tab says the project (no title row of its own).
    await screen.findByText('⌂ API')
    expect(await menu()).toContain('Tree view')
    await menu('Display…')
    await user.press(screen.getByTestId('display-view-tree'))
    await user.press(screen.getByText('Done'))
    expect(cardOrder('queued')).toEqual(['a', 'a1', 'b', 'c'])
    // A subtask says its own status.
    expect(within(screen.getByTestId('task-a1')).getByText('Queued')).toBeOnTheScreen()
  })

  it('a tapped card opens its task as a tab (desktop tab bar); ✕ closes it, the board shows again', async () => {
    await render(app({ prefs: createBoardPrefs(memory()), wide: true }))
    await screen.findByText('Home task')
    const user = userEvent.setup()
    await user.press(screen.getByText('Home task'))
    expect(screen.getByText('task page h1 details')).toBeOnTheScreen()
    expect(screen.getByTestId('open-tab-task-h1')).toBeSelected()
    await user.press(screen.getByTestId('open-tab-board'))
    expect(screen.queryByText(/task page/)).toBeNull()
    await user.press(screen.getByTestId('open-tab-task-h1'))
    await user.press(screen.getByLabelText('Close Home task'))
    expect(screen.queryByTestId('open-tab-task-h1')).toBeNull()
    expect(screen.getByTestId('project-board')).toBeOnTheScreen()
  })
})

describe('BoardHome: 🔔 and the project switcher', () => {
  /** Work's Alpha waits for the user (its agent is idle, the task unread). */
  const waiting = (): BoardData =>
    ({
      ...workBoard(),
      tasks: workBoard().tasks.map((t) => (t.id === 'a' ? { ...t, needs_attention: true } : t))
    }) as BoardData

  it('the bell counts the agents waiting for you on every hub; a row opens its task', async () => {
    work = serve(workHub.id, waiting)
    const onOpenTask = jest.fn()
    await render(
      <OpenTasksProvider>
        <BoardHome
          feeds={[
            feedOf(homeHub, homeBoard()),
            feedOf(workHub, waiting(), {
              agents: {
                state: {
                  byId: { 'a:a': 'idle', 'd:d': 'running' },
                  hibernated: {},
                  lastPushedAt: {},
                  jobsById: {}
                },
                loaded: true,
                error: null
              } as never
            })
          ]}
          sessions={sessions}
          wide={false}
          onRetry={jest.fn()}
          onSignOut={jest.fn()}
          onOpenTask={onOpenTask}
          onNewTask={jest.fn()}
          onOpenProject={jest.fn()}
          onOpenArtifact={jest.fn()}
          prefs={createBoardPrefs(memory())}
          sheetParam="attention"
        />
      </OpenTasksProvider>,
      { wrapper: ({ children }) => <HubConnections sessions={[]}>{children}</HubConnections> }
    )
    expect(screen.getByLabelText('Agents, 1')).toBeOnTheScreen()
    const sheet = within(screen.getByTestId('attention-sheet'))
    expect(sheet.getByText(`API · ${workHub.label} · Waiting for you`)).toBeOnTheScreen()
    await userEvent.setup().press(sheet.getByTestId('attention-row-a'))
    expect(onOpenTask).toHaveBeenCalledWith(
      expect.objectContaining({ hubId: workHub.id, task: expect.objectContaining({ id: 'a' }) }),
      'agent'
    )
  })

  it('creates a project on the chosen hub, switches to it and opens its settings', async () => {
    const onOpenProject = jest.fn()
    await renderBoard({ prefs: createBoardPrefs(memory()), onOpenProject })
    const user = userEvent.setup()
    await user.press(screen.getByTestId('project-switcher'))
    await user.press(screen.getByTestId('new-project'))
    await user.type(screen.getByTestId('new-project-name'), 'Docs')
    await user.press(screen.getByText(workHub.label))
    await user.press(screen.getByTestId('new-project-create'))
    await settle()
    expect(work.create).toEqual([{ name: 'Docs', color: expect.any(String) }])
    expect(home.create).toEqual([])
    expect(onOpenProject).toHaveBeenCalledWith(workHub.label, 'new-p')
  })

  it('⋯ of a project opens its settings', async () => {
    const onOpenProject = jest.fn()
    await renderBoard({ prefs: createBoardPrefs(memory()), onOpenProject })
    const user = userEvent.setup()
    await user.press(screen.getByTestId('project-switcher'))
    await user.press(
      within(screen.getByTestId('project-switcher-sheet')).getByLabelText('API settings')
    )
    expect(onOpenProject).toHaveBeenCalledWith(workHub.label, 'p')
  })
})

describe('BoardHome: hubs', () => {
  const base = (fields: Partial<BoardHomeProps>): BoardHomeProps => ({
    feeds: [],
    sessions: [],
    wide: false,
    onRetry: jest.fn(),
    onSignOut: jest.fn(),
    onOpenTask: jest.fn(),
    onNewTask: jest.fn(),
    onOpenProject: jest.fn(),
    onOpenArtifact: jest.fn(),
    prefs: createBoardPrefs(memory()),
    ...fields
  })

  // The sheets read every hub themselves.
  const inApp = (ui: ReactNode) =>
    render(
      <HubConnections sessions={[]}>
        <OpenTasksProvider>{ui}</OpenTasksProvider>
      </HubConnections>
    )

  it('shows the first load under way', async () => {
    await inApp(<BoardHome {...base({ feeds: [feedOf(homeHub, undefined)] })} />)
    expect(screen.getByTestId('board-loading')).toBeOnTheScreen()
    expect(screen.queryByText('No projects yet')).toBeNull()
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
    await inApp(<BoardHome {...base({ feeds, onRetry, onSignOut })} />)
    expect(screen.getByText('No projects yet')).toBeOnTheScreen()
    const user = userEvent.setup()
    await user.press(screen.getByText('Retry'))
    expect(onRetry).toHaveBeenCalledWith(homeHub.id)
    await user.press(screen.getByText('Sign out'))
    expect(onSignOut).toHaveBeenCalledWith(homeHub.id)
  })
})
