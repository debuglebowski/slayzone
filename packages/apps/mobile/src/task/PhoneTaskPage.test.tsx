/**
 * The phone's task page around its agent (`TaskPageLayout`): the floating top bar and
 * status island, the agent card (the agent's controls, the task's actions), the tab
 * bar, and the Details and Artifacts tabs — the task's fields, sub-tasks, tags,
 * blockers — every write to the hub that owns the task. The agent panel has a suite of
 * its own (`AgentPanel.test.tsx`): here it is a stand-in handing the page an agent.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  userEvent,
  waitFor,
  within
} from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { Alert, type AlertButton } from 'react-native'
import type { AgentNav, AgentPanelProps } from '../agents/AgentPanel'
import type { BoardData, HubFeed, TaskRow } from '../hub-board'
import { hubEntryOf } from '../hub-session'
import {
  boardOf,
  createFakeHubs,
  feedOf,
  homeHub,
  projectOf,
  taskOf,
  workHub
} from '../hubs/testing'
import { serveTaskHub, writes } from '../task-edit/testing'
import { TaskPage, type TaskPageProps, type TaskSegment } from './TaskPage'

const mockHubs = createFakeHubs()
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  HubScope: (props: { hubId: string; fallback?: ReactNode; children: ReactNode }) =>
    mockHubs.HubScope(props)
}))
const mockFeeds: { list: HubFeed[] } = { list: [] }
jest.mock('../hub-connections', () => ({ useHubFeeds: () => ({ feeds: mockFeeds.list }) }))
const mockRouter = { push: jest.fn(), back: jest.fn(), canGoBack: () => true }
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }))
// The artifact list has a suite of its own.
jest.mock('../artifacts/ArtifactsScreen', () => ({
  ArtifactsScreen: () => {
    const { Text } = jest.requireActual('react-native')
    return <Text>artifact list</Text>
  }
}))
jest.mock('../artifacts/use-task-artifacts', () => ({
  useTaskArtifacts: () => ({ artifacts: [{ id: 'a1' }, { id: 'a2' }] })
}))
jest.mock('../computers/TaskComputer', () => ({ TaskComputer: () => null }))

/** The agent the stand-in panel hands the page, and how often the panel mounted. */
const mockAgent = { nav: null as AgentNav | null, mounts: 0 }
function agentNav(fields: Partial<AgentNav> = {}): AgentNav {
  return {
    provider: 'Claude Chat',
    status: 'Idle · Unread',
    stateLabel: 'Idle',
    dot: 'attention',
    working: false,
    waiting: false,
    busy: false,
    start: null,
    stop: null,
    actions: [
      { name: 'Restart', label: 'Restart', kind: 'lifecycle', onPress: jest.fn() },
      { name: 'Reset', label: 'New conversation', kind: 'lifecycle', onPress: jest.fn() },
      {
        name: 'Stop',
        label: 'Stop agent',
        kind: 'lifecycle',
        destructive: true,
        onPress: jest.fn()
      }
    ],
    providers: [
      { id: 'claude-chat', label: 'Claude Chat' },
      { id: 'codex-chat', label: 'Codex Chat' }
    ],
    providerId: 'claude-chat',
    switchProvider: jest.fn(),
    controls: null,
    onOpen: jest.fn(),
    problems: null,
    ...fields
  }
}
jest.mock('../agents/AgentPanel', () => ({
  AgentPanel: (props: AgentPanelProps) => {
    const { useEffect } = jest.requireActual('react')
    const { Text } = jest.requireActual('react-native')
    useEffect(() => {
      mockAgent.mounts++
    }, [])
    const { useTaskChrome } = jest.requireActual('./task-chrome')
    // The agent's body: what the page's chrome tells it, and its timeline's scroll.
    function Body() {
      const chrome = useTaskChrome()
      const { Pressable } = jest.requireActual('react-native')
      return (
        <>
          <Text>agent body</Text>
          <Text testID="chrome">
            {`top ${chrome.top} bottom ${chrome.bottom} composer ${chrome.composer.start}/${chrome.composer.bottom}`}
          </Text>
          {[0, 400, 300, 100].map((offset) => (
            <Pressable key={offset} onPress={() => chrome.onTimelineScroll(offset)}>
              <Text>{`scroll ${offset}`}</Text>
            </Pressable>
          ))}
        </>
      )
    }
    return props.phone?.(mockAgent.nav!, <Body />) ?? null
  }
}))
jest.mock('../chat/ChatControls', () => ({
  ChatControls: (props: { variant?: string; mode: string }) => {
    const { Text } = jest.requireActual('react-native')
    return <Text>{`chat controls ${props.variant} ${props.mode}`}</Text>
  }
}))

const COLUMNS = [
  { id: 'todo', label: 'To do', color: 'col-blue', position: 0, category: 'unstarted' as const },
  { id: 'doing', label: 'Doing', color: 'col-yellow', position: 1, category: 'started' as const },
  { id: 'done', label: 'Done', color: 'col-green', position: 2, category: 'completed' as const }
]
const tag = (id: string, project_id = 'p') => ({
  id,
  project_id,
  name: `#${id}`,
  color: 'tag-bg',
  text_color: 'tag-fg',
  sort_order: 0,
  created_at: ''
})

function boardWith(fields: Partial<ReturnType<typeof taskOf>> = {}): BoardData {
  const b = boardOf({
    projects: [projectOf('p', { name: 'Home', columns_config: COLUMNS })],
    tasks: [
      taskOf('t1', { title: 'Write spec', status: 'todo', priority: 3, due_date: null, ...fields }),
      taskOf('sub1', { title: 'Outline', parent_id: 't1', status: 'doing' }),
      taskOf('other', { title: 'Other work' }),
      taskOf('closed', { title: 'Closed one', status: 'done' })
    ]
  })
  return {
    ...b,
    tags: [tag('red'), tag('blue'), tag('elsewhere', 'q')],
    taskTags: { t1: ['red'] },
    blockedTaskIds: []
  } as BoardData
}

function rowFrom(hub: typeof workHub, board: BoardData): TaskRow {
  const task = board.tasks.find((t) => t.id === 't1')!
  return {
    key: `${hub.id}\nt1`,
    hubId: hub.id,
    hubLabel: hub.label,
    task,
    project: board.projects[0]!
  }
}

/** The task on `work`, with `home` signed in too (it must never see a write). */
async function show(
  answers: Parameters<typeof serveTaskHub>[2] = {},
  board = boardWith(),
  segment: TaskSegment = 'details',
  agent: Partial<AgentNav> = {}
) {
  const work = serveTaskHub(mockHubs, workHub.id, answers)
  const home = serveTaskHub(mockHubs, homeHub.id)
  mockFeeds.list = [feedOf(homeHub, boardOf({})), feedOf(workHub, board)]
  mockAgent.nav = agentNav(agent)
  const onDeleted = jest.fn()
  const onOpenTask = jest.fn()
  const onSegment = jest.fn()
  const onBack = jest.fn()
  const props = (b: BoardData, shown: TaskSegment = segment): TaskPageProps => ({
    row: rowFrom(workHub, b),
    feed: feedOf(workHub, b),
    session: { entry: hubEntryOf(workHub.label), token: 't' } as never,
    showHub: true,
    wide: false,
    segment: shown,
    onSegment,
    onBack,
    onDeleted,
    onOpenTask,
    onOpenArtifact: jest.fn()
  })
  const view = await render(<TaskPage {...props(board)} />)
  // The blockers load (`task.getBlockers`) settles before the test acts.
  if (segment === 'details')
    await waitFor(() => expect(work.some((c) => c.path === 'task.getBlockers')).toBe(true))
  await act(async () => undefined)
  const rerender = async (next: BoardData) => {
    mockFeeds.list = [feedOf(homeHub, boardOf({})), feedOf(workHub, next)]
    await view.rerender(<TaskPage {...props(next)} />)
  }
  const showSegment = async (next: TaskSegment) => {
    await view.rerender(<TaskPage {...props(board, next)} />)
  }
  return { work, home, onDeleted, onOpenTask, onSegment, onBack, rerender, showSegment }
}

const user = () => userEvent.setup()

async function pick(chipTestId: string, choice: string) {
  await user().press(screen.getByTestId(chipTestId))
  await user().press(within(screen.getByTestId('choice-sheet')).getByText(choice))
}

/** Presses the Alert button labelled `label` the next time an alert opens. */
function answerAlert(label: string) {
  return jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons?: AlertButton[]) => {
    buttons?.find((b) => b.text === label)?.onPress?.()
  })
}

beforeEach(() => {
  jest.restoreAllMocks()
  mockRouter.push.mockClear()
  mockAgent.mounts = 0
})

describe("the Details tab: the task's fields", () => {
  it("shows the task's fields: title, status in its project's words, priority, due date, project, hub", async () => {
    await show({}, boardWith({ due_date: '2999-01-02' }))
    expect(screen.getByDisplayValue('Write spec')).toBeOnTheScreen()
    expect(screen.getByTestId('task-status')).toHaveTextContent('StatusTo do ▾')
    expect(screen.getByTestId('task-priority')).toHaveTextContent('PriorityMedium ▾')
    expect(screen.getByTestId('task-due')).toHaveTextContent('DueDue Jan 2, 2999 ▾')
    expect(screen.getByLabelText('Status: To do')).toBeOnTheScreen()
    expect(screen.getByLabelText('Priority: Medium')).toBeOnTheScreen()
    expect(screen.getByText(workHub.label)).toBeOnTheScreen()
  })

  it('the status icon in the header changes the status too', async () => {
    const { work } = await show()
    await user().press(screen.getByTestId('task-status-icon'))
    await user().press(within(screen.getByTestId('choice-sheet')).getByText('Doing'))
    await waitFor(() =>
      expect(writes(work)).toEqual([{ path: 'task.update', input: { id: 't1', status: 'doing' } }])
    )
  })

  it('keeps Details mounted while Artifacts shows (an edit in progress survives)', async () => {
    const { showSegment } = await show()
    await showSegment('artifacts')
    expect(screen.getByText('artifact list')).toBeOnTheScreen()
    // Hidden, not unmounted: off screen to touch and to VoiceOver.
    expect(screen.queryByTestId('task-details')).toBeNull()
    expect(screen.getByTestId('task-details', { includeHiddenElements: true })).toBeTruthy()
    await showSegment('details')
    expect(screen.getByTestId('task-details')).toBeOnTheScreen()
  })

  it('mounts a part only once it is first shown', async () => {
    await show({}, boardWith(), 'artifacts')
    expect(screen.getByText('artifact list')).toBeOnTheScreen()
    expect(screen.queryByTestId('task-details', { includeHiddenElements: true })).toBeNull()
  })

  it('the due date under the title reads as a day, not a raw date', async () => {
    await show({}, boardWith({ due_date: '2999-01-02' }))
    expect(screen.getByLabelText('Due Jan 2, 2999')).toHaveTextContent('Due Jan 2, 2999')
    expect(screen.queryByText('2999-01-02')).toBeNull()
  })

  it('changes the status on the hub that owns the task, nowhere else', async () => {
    const { work, home } = await show()
    await pick('task-status', 'Doing')
    await waitFor(() =>
      expect(writes(work)).toEqual([{ path: 'task.update', input: { id: 't1', status: 'doing' } }])
    )
    expect(writes(home)).toEqual([])
    expect(screen.getByTestId('task-status')).toHaveTextContent('StatusDoing ▾')
  })

  it('changes the priority', async () => {
    const { work } = await show()
    await pick('task-priority', 'Urgent')
    await waitFor(() =>
      expect(writes(work)).toEqual([{ path: 'task.update', input: { id: 't1', priority: 1 } }])
    )
  })

  it('sets and clears the due date', async () => {
    const { work } = await show({}, boardWith({ due_date: '2999-01-02' }))
    await pick('task-due', 'No due date')
    await waitFor(() =>
      expect(writes(work)).toEqual([{ path: 'task.update', input: { id: 't1', dueDate: null } }])
    )
  })

  it('picks a due date on the calendar', async () => {
    const { work } = await show()
    await user().press(screen.getByTestId('task-due'))
    await act(async () =>
      fireEvent(
        within(screen.getByTestId('choice-sheet')).getByTestId('due-date-calendar'),
        'change',
        { nativeEvent: { timestamp: new Date(2027, 2, 4).getTime() } }
      )
    )
    await waitFor(() =>
      expect(writes(work)).toEqual([
        { path: 'task.update', input: { id: 't1', dueDate: '2027-03-04' } }
      ])
    )
  })

  it('renames the task when editing ends; an empty title is not saved', async () => {
    const { work } = await show()
    const title = screen.getByDisplayValue('Write spec')
    await user().clear(title)
    await act(() => title.props.onEndEditing())
    expect(writes(work)).toEqual([])
    expect(screen.getByDisplayValue('Write spec')).toBeOnTheScreen()
    await user().type(title, ' v2')
    await act(() => title.props.onEndEditing())
    await waitFor(() =>
      expect(writes(work)).toEqual([
        { path: 'task.update', input: { id: 't1', title: 'Write spec v2' } }
      ])
    )
  })

  it("a refused change goes back to the hub's value, and says why", async () => {
    await show({
      'task.update': () => {
        throw new Error('Unknown status')
      }
    })
    await pick('task-status', 'Doing')
    expect(await screen.findByText("Couldn't save: Unknown status")).toBeOnTheScreen()
    expect(screen.getByTestId('task-status')).toHaveTextContent('StatusTo do ▾')
  })
})

/** Opens the agent card from the status island, then presses `label` in it. */
async function menu(label: string) {
  await user().press(screen.getByTestId('status-island'))
  await user().press(within(screen.getByTestId('agent-card')).getByText(label))
}

describe("the agent card: the task's actions (archive, delete …)", () => {
  it('archives after asking', async () => {
    const { work } = await show()
    const alert = answerAlert('Archive')
    await menu('Archive')
    expect(alert).toHaveBeenCalled()
    await waitFor(() =>
      expect(writes(work)).toEqual([{ path: 'task.archive', input: { id: 't1' } }])
    )
  })

  it('an archived task can be unarchived', async () => {
    const { work } = await show({}, boardWith({ archived_at: '2026-10-01' }))
    expect(screen.getByText('Archived')).toBeOnTheScreen()
    answerAlert('Unarchive')
    await menu('Unarchive')
    await waitFor(() =>
      expect(writes(work)).toEqual([{ path: 'task.unarchive', input: { id: 't1' } }])
    )
  })

  it('a temporary task: Keep as task makes it a regular, started task', async () => {
    const { work } = await show({}, boardWith({ is_temporary: true }))
    await menu('Keep as task')
    await waitFor(() =>
      expect(writes(work)).toEqual([
        {
          path: 'task.update',
          input: { id: 't1', title: 'Untitled task', status: 'doing', isTemporary: false }
        }
      ])
    )
  })

  it('a regular task has no Keep as task', async () => {
    await show()
    await user().press(screen.getByTestId('status-island'))
    expect(within(screen.getByTestId('agent-card')).queryByText('Keep as task')).toBeNull()
  })

  it('deletes after asking, then leaves', async () => {
    const { work, onDeleted } = await show()
    answerAlert('Delete')
    await menu('Delete')
    await waitFor(() =>
      expect(writes(work)).toEqual([{ path: 'task.delete', input: { id: 't1' } }])
    )
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
  })

  it('cancelled: nothing is deleted', async () => {
    const { work } = await show()
    answerAlert('Cancel')
    await menu('Delete')
    expect(writes(work)).toEqual([])
  })

  it("says why the hub won't delete a task linked to an integration", async () => {
    const { onDeleted } = await show({
      'task.delete': () => ({ blocked: true, reason: 'linked_to_provider' })
    })
    answerAlert('Delete')
    await menu('Delete')
    expect(await screen.findByText(/linked to an integration/)).toBeOnTheScreen()
    expect(onDeleted).not.toHaveBeenCalled()
  })
})

describe('the Details tab: sub-tasks', () => {
  it('lists the sub-tasks and opens one', async () => {
    const { onOpenTask } = await show()
    expect(screen.getByText('Sub-tasks · 0/1')).toBeOnTheScreen()
    await user().press(screen.getByText('Outline'))
    expect(onOpenTask).toHaveBeenCalledWith('sub1')
  })

  it("ticks a sub-task done (the project's completed status) and opens it again", async () => {
    const { work, rerender } = await show()
    await user().press(screen.getByTestId('subtask-check-sub1'))
    await waitFor(() =>
      expect(writes(work)).toEqual([{ path: 'task.update', input: { id: 'sub1', status: 'done' } }])
    )
    const b = boardWith()
    await rerender({
      ...b,
      tasks: b.tasks.map((t) => (t.id === 'sub1' ? { ...t, status: 'done' } : t))
    })
    expect(screen.getByText('Sub-tasks · 1/1')).toBeOnTheScreen()
    await user().press(screen.getByTestId('subtask-check-sub1'))
    await waitFor(() =>
      expect(writes(work).at(-1)).toEqual({
        path: 'task.update',
        input: { id: 'sub1', status: 'todo' }
      })
    )
  })

  it("adds a subtask: same project, the project's default status", async () => {
    const { work } = await show()
    await user().press(screen.getByTestId('add-subtask'))
    await user().type(screen.getByTestId('new-subtask-title'), 'Draft', { submitEditing: true })
    await waitFor(() =>
      expect(writes(work)).toEqual([
        {
          path: 'task.create',
          input: { projectId: 'p', parentId: 't1', title: 'Draft', status: 'todo' }
        }
      ])
    )
  })
})

describe('the Details tab: tags', () => {
  it("offers the project's tags and toggles one", async () => {
    const { work } = await show()
    // In the sheet's header and in the Details list.
    expect(screen.getAllByText('#red')).toHaveLength(2)
    await user().press(screen.getByTestId('edit-tags'))
    const sheet = screen.getByTestId('tag-sheet')
    expect(within(sheet).queryByText('#elsewhere')).toBeNull()
    await user().press(within(sheet).getByText('#blue'))
    await waitFor(() =>
      expect(writes(work)).toEqual([
        { path: 'tags.setForTask', input: { taskId: 't1', tagIds: ['red', 'blue'] } }
      ])
    )
  })
})

describe('the Details tab: blockers', () => {
  it('lists blockers, removes one', async () => {
    const { work } = await show({
      'task.getBlockers': () => [taskOf('other', { title: 'Other work' })]
    })
    expect(await screen.findByTestId('blocker-other')).toBeOnTheScreen()
    await user().press(screen.getByTestId('remove-blocker-other'))
    await waitFor(() =>
      expect(writes(work)).toEqual([
        { path: 'task.removeBlocker', input: { taskId: 't1', blockerTaskId: 'other' } }
      ])
    )
  })

  it('adds a blocker from the open tasks of the same hub', async () => {
    const { work } = await show()
    await user().press(screen.getByText('Add blocker'))
    const sheet = screen.getByTestId('blocker-sheet')
    expect(within(sheet).queryByText('Closed one')).toBeNull()
    expect(within(sheet).queryByText('Write spec')).toBeNull()
    await user().type(within(sheet).getByTestId('blocker-search'), 'other')
    await user().press(within(sheet).getByText('Other work'))
    await waitFor(() =>
      expect(writes(work)).toEqual([
        { path: 'task.addBlocker', input: { taskId: 't1', blockerTaskId: 'other' } }
      ])
    )
  })

  it('marks it blocked with a comment, and unblocks', async () => {
    const { work, rerender } = await show()
    await user().press(screen.getByText('Mark blocked'))
    await user().type(screen.getByTestId('blocked-comment'), 'Waiting on legal')
    await user().press(screen.getByText('Block'))
    await waitFor(() =>
      expect(writes(work)).toEqual([
        {
          path: 'task.update',
          input: { id: 't1', isBlocked: true, blockedComment: 'Waiting on legal' }
        }
      ])
    )
    const blocked = boardWith({ is_blocked: true, blocked_comment: 'Waiting on legal' })
    await rerender({ ...blocked, blockedTaskIds: ['t1'] })
    expect(screen.getByText('Waiting on legal')).toBeOnTheScreen()
    await user().press(screen.getByText('Unblock'))
    await waitFor(() =>
      expect(writes(work).at(-1)).toEqual({
        path: 'task.update',
        input: { id: 't1', isBlocked: false, blockedComment: null }
      })
    )
  })
})

describe('the top bar and the status island', () => {
  it('back, the title (a tap shows Details), the island with the agent’s state', async () => {
    const { onBack, onSegment } = await show({}, boardWith(), 'agent')
    expect(screen.getByText('agent body')).toBeOnTheScreen()
    expect(screen.getByTestId('task-title')).toHaveTextContent('Write spec')
    expect(screen.getByTestId('task-title').props.numberOfLines).toBe(1)
    expect(screen.getByTestId('status-island-label')).toHaveTextContent('Idle')
    await user().press(screen.getByLabelText('Write spec'))
    expect(onSegment).toHaveBeenCalledWith('details')
    const back = screen.getByLabelText('Back to Home')
    expect(back).toHaveStyle({ width: '100%', flex: 1 })
    await user().press(back)
    expect(onBack).toHaveBeenCalled()
  })

  it('says “Needs you” while a chat waits for the user', async () => {
    await show({}, boardWith(), 'agent', { waiting: true })
    expect(screen.getByTestId('status-island-label')).toHaveTextContent('Needs you')
    expect(screen.getByTestId('status-island').props.accessibilityLabel).toBe(
      'Claude Chat: needs you'
    )
  })

  it('Start is in the island while offered; Stop while the agent works', async () => {
    const start = jest.fn()
    await show({}, boardWith(), 'agent', { start })
    expect(screen.queryByLabelText('Stop the agent')).toBeNull()
    await user().press(screen.getByLabelText('Start the agent'))
    expect(start).toHaveBeenCalled()
  })

  it('Stop is in the island while the agent works', async () => {
    const stop = jest.fn()
    await show({}, boardWith(), 'agent', { stop, working: true, stateLabel: 'Active' })
    expect(screen.queryByLabelText('Start the agent')).toBeNull()
    await user().press(screen.getByLabelText('Stop the agent'))
    expect(stop).toHaveBeenCalled()
  })

  it('says what failed under the bar', async () => {
    const { Text } = jest.requireActual('react-native')
    await show({}, boardWith(), 'agent', { problems: <Text>Couldn’t start the agent.</Text> })
    expect(screen.getByText('Couldn’t start the agent.')).toBeOnTheScreen()
  })
})

describe('the agent card (the island opened)', () => {
  it('shows the agent and everything to do with it; an action closes the card, then runs', async () => {
    await show({}, boardWith(), 'agent')
    await user().press(screen.getByTestId('status-island'))
    expect(mockAgent.nav!.onOpen).toHaveBeenCalled()
    const card = within(screen.getByTestId('agent-card'))
    expect(card.getByTestId('agent-card-provider')).toHaveTextContent('Claude Chat')
    expect(card.getByTestId('agent-card-status')).toHaveTextContent('Idle · Unread')
    for (const label of ['Restart', 'New conversation', 'Stop agent', 'Provider', 'Archive'])
      expect(card.getByText(label)).toBeOnTheScreen()
    await user().press(card.getByText('New conversation'))
    expect(mockAgent.nav!.actions[1]!.onPress).toHaveBeenCalled()
    expect(screen.queryByTestId('agent-card')).toBeNull()
  })

  it('Provider folds out the providers; one is picked', async () => {
    await show({}, boardWith(), 'agent')
    await user().press(screen.getByTestId('status-island'))
    const card = within(screen.getByTestId('agent-card'))
    expect(card.queryByTestId('agent-card-providers')).toBeNull()
    await user().press(card.getByLabelText('Provider'))
    await user().press(within(card.getByTestId('agent-card-providers')).getByText('Codex Chat'))
    expect(mockAgent.nav!.switchProvider).toHaveBeenCalledWith('codex-chat')
  })

  it("a chat's mode, model and effort are tiles in the card (none in the composer)", async () => {
    await show({}, boardWith(), 'agent', {
      controls: { mode: 'claude-chat', settings: {}, models: {}, waiting: false } as never
    })
    await user().press(screen.getByTestId('status-island'))
    expect(
      within(screen.getByTestId('agent-card')).getByText('chat controls tiles claude-chat')
    ).toBeOnTheScreen()
  })

  it("a terminal's text actions are listed apart", async () => {
    await show({}, boardWith(), 'agent', {
      controls: null,
      actions: [
        {
          name: 'Copy screen text',
          label: 'Copy screen text',
          kind: 'terminal',
          onPress: jest.fn()
        }
      ]
    })
    await user().press(screen.getByTestId('status-island'))
    const card = within(screen.getByTestId('agent-card'))
    expect(card.getByText('Terminal')).toBeOnTheScreen()
    expect(card.getByText('Copy screen text')).toBeOnTheScreen()
  })
})

describe('the tab bar', () => {
  it('Agent · Details · Artifacts (with how many); a tap shows one', async () => {
    const { onSegment } = await show({}, boardWith(), 'agent')
    expect(screen.getByTestId('tab-agent')).toHaveTextContent('Agent')
    expect(screen.getByTestId('tab-agent')).toBeSelected()
    expect(screen.getByTestId('tab-artifacts')).toHaveTextContent('Artifacts 2')
    await user().press(screen.getByTestId('tab-artifacts'))
    expect(onSegment).toHaveBeenCalledWith('artifacts')
  })

  it('marks the Agent tab while the agent needs the user and another tab shows', async () => {
    await show()
    expect(screen.getByTestId('tab-agent').props.accessibilityLabel).toBe('Agent, needs you')
  })

  it('keeps the agent mounted whatever tab shows (its draft and terminal survive)', async () => {
    const { showSegment } = await show({}, boardWith(), 'agent')
    await showSegment('details')
    expect(screen.queryByText('agent body')).toBeNull()
    expect(screen.getByText('agent body', { includeHiddenElements: true })).toBeTruthy()
    await showSegment('artifacts')
    await showSegment('agent')
    expect(screen.getByText('agent body')).toBeOnTheScreen()
    expect(mockAgent.mounts).toBe(1)
  })
})

describe('compact bars while reading back', () => {
  it('reading back in the chat makes the bars compact; back at the newest they return', async () => {
    await show({}, boardWith(), 'agent')
    expect(screen.getByTestId('chrome')).toHaveTextContent('top 56 bottom 74 composer 16/74')
    await user().press(screen.getByText('scroll 400'))
    expect(screen.queryByTestId('task-title')).toBeNull()
    expect(screen.queryByTestId('task-tabs')).toBeNull()
    expect(screen.getByTestId('task-tabs-compact')).toBeOnTheScreen()
    // The composer sits beside the tab bar's one button.
    expect(screen.getByTestId('chrome')).toHaveTextContent('top 44 bottom 66 composer 78/6')
    await user().press(screen.getByText('scroll 300'))
    expect(screen.getByTestId('task-tabs-compact')).toBeOnTheScreen()
    await user().press(screen.getByText('scroll 0'))
    expect(screen.getByTestId('task-title')).toBeOnTheScreen()
    expect(screen.getByTestId('task-tabs')).toHaveStyle({ width: '100%' })
  })

  it('the compact button brings the tab bar back', async () => {
    await show({}, boardWith(), 'agent')
    await user().press(screen.getByText('scroll 400'))
    await user().press(screen.getByTestId('task-tabs-compact'))
    expect(screen.getByTestId('task-tabs')).toBeOnTheScreen()
  })

  it('scrolling back towards the newest by a good way brings them back too', async () => {
    await show({}, boardWith(), 'agent')
    await user().press(screen.getByText('scroll 400'))
    await user().press(screen.getByText('scroll 100'))
    expect(screen.getByTestId('task-tabs')).toBeOnTheScreen()
  })
})
