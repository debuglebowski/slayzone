/**
 * The phone's Details / Artifacts sheet (the task page's ⓘ): the task's fields, its ⋯
 * actions, sub-tasks, tags, blockers — every write to the hub that owns the task.
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
import { type InfoSegment, TaskInfoSheet, type TaskInfoSheetProps } from './TaskInfoSheet'

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
  segment: InfoSegment = 'details'
) {
  const work = serveTaskHub(mockHubs, workHub.id, answers)
  const home = serveTaskHub(mockHubs, homeHub.id)
  mockFeeds.list = [feedOf(homeHub, boardOf({})), feedOf(workHub, board)]
  const onDeleted = jest.fn()
  const onOpenTask = jest.fn()
  const onSegment = jest.fn()
  const onClose = jest.fn()
  const props = (b: BoardData, shown: InfoSegment = segment): TaskInfoSheetProps => ({
    row: rowFrom(workHub, b),
    feed: feedOf(workHub, b),
    session: { entry: hubEntryOf(workHub.label), token: 't' } as never,
    showHub: true,
    segment: shown,
    onSegment,
    onClose,
    onDeleted,
    onOpenTask,
    onOpenArtifact: jest.fn()
  })
  const view = await render(<TaskInfoSheet {...props(board)} />)
  // The blockers load (`task.getBlockers`) settles before the test acts.
  if (segment === 'details')
    await waitFor(() => expect(work.some((c) => c.path === 'task.getBlockers')).toBe(true))
  await act(async () => undefined)
  const rerender = async (next: BoardData) => {
    mockFeeds.list = [feedOf(homeHub, boardOf({})), feedOf(workHub, next)]
    await view.rerender(<TaskInfoSheet {...props(next)} />)
  }
  const showSegment = async (next: InfoSegment) => {
    await view.rerender(<TaskInfoSheet {...props(board, next)} />)
  }
  return { work, home, onDeleted, onOpenTask, onSegment, onClose, rerender, showSegment }
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
})

describe('TaskInfoSheet fields', () => {
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

  it('switches between Details and Artifacts (with how many)', async () => {
    const { onSegment } = await show()
    expect(screen.queryByTestId('segment-agent')).toBeNull()
    expect(screen.getByTestId('segment-artifacts')).toHaveTextContent('Artifacts 2')
    await user().press(screen.getByTestId('segment-artifacts'))
    expect(onSegment).toHaveBeenCalledWith('artifacts')
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

  it("mounts as one native view, so the sheet can't find (and resize) the Details scroll view", async () => {
    // react-native-screens' formSheet resizes a scroll view it finds among the sheet
    // content's top native views to the whole sheet — over the title and segments.
    await show()
    expect(screen.getByTestId('task-info-sheet')).toHaveProp('collapsable', false)
  })

  it('Done closes the sheet', async () => {
    const { onClose } = await show()
    await user().press(screen.getByLabelText('Done'))
    expect(onClose).toHaveBeenCalled()
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

/** Opens the ⋯ menu, then presses `label` in it. */
async function menu(label: string) {
  await user().press(screen.getByTestId('task-menu'))
  await user().press(within(screen.getByTestId('task-menu-sheet')).getByText(label))
}

describe('TaskInfoSheet ⋯: archive and delete', () => {
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
    await user().press(screen.getByTestId('task-menu'))
    expect(within(screen.getByTestId('task-menu-sheet')).queryByText('Keep as task')).toBeNull()
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

describe('TaskInfoSheet sub-tasks', () => {
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

describe('TaskInfoSheet tags', () => {
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

describe('TaskInfoSheet blockers', () => {
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
