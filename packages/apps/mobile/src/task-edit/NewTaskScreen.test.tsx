import {
  act,
  fireEvent,
  render,
  screen,
  userEvent,
  waitFor,
  within
} from '@testing-library/react-native'
import type { TaskTemplate } from '@slayzone/task-contracts'
import type { ReactNode } from 'react'
import { Alert, type AlertButton } from 'react-native'
import type { HubFeed } from '../hub-board'
import {
  boardOf,
  createFakeHubs,
  feedOf,
  homeHub,
  projectOf,
  taskOf,
  workHub
} from '../hubs/testing'
import { NewTaskScreen } from './NewTaskScreen'
import { serveTaskHub, writes } from './testing'

const mockHubs = createFakeHubs()
jest.mock('@slayzone/transport/client', () => ({
  ...jest.requireActual('@slayzone/transport/client'),
  HubScope: (props: { hubId: string; fallback?: ReactNode; children: ReactNode }) =>
    mockHubs.HubScope(props)
}))
const mockFeeds: { list: HubFeed[] } = { list: [] }
jest.mock('../hub-connections', () => ({ useHubFeeds: () => ({ feeds: mockFeeds.list }) }))

const COLUMNS = [
  { id: 'later', label: 'Later', color: 'col-gray', position: 0, category: 'backlog' as const },
  { id: 'next', label: 'Next', color: 'col-blue', position: 1, category: 'unstarted' as const },
  { id: 'doing', label: 'Doing', color: 'col-yellow', position: 2, category: 'started' as const },
  { id: 'done', label: 'Done', color: 'col-green', position: 3, category: 'completed' as const }
]

const template = (id: string, fields: Partial<TaskTemplate> = {}) =>
  ({
    id,
    name: id,
    is_default: false,
    default_status: null,
    default_priority: null,
    ...fields
  }) as TaskTemplate

function hubs(templates: { work?: TaskTemplate[]; home?: TaskTemplate[] } = {}) {
  mockFeeds.list = [
    feedOf(homeHub, boardOf({ projects: [projectOf('hp', { name: 'Chores' })] })),
    feedOf(
      workHub,
      boardOf({
        projects: [projectOf('wp', { name: 'Launch', columns_config: COLUMNS })],
        tasks: [taskOf('parent', { project_id: 'wp', title: 'Big thing' })]
      })
    )
  ]
  const work = serveTaskHub(mockHubs, workHub.id, {
    'template.getByProject': () => templates.work ?? []
  })
  const home = serveTaskHub(mockHubs, homeHub.id, {
    'template.getByProject': () => templates.home ?? []
  })
  return { work, home }
}

async function open(
  params: { status?: string; parentId?: string; priority?: number; dueDate?: string } = {}
) {
  const onCreated = jest.fn()
  const onCancel = jest.fn()
  await render(
    <NewTaskScreen
      hubAddress={workHub.label}
      projectId="wp"
      status={params.status}
      parentId={params.parentId}
      priority={params.priority}
      dueDate={params.dueDate}
      onCreated={onCreated}
      onCancel={onCancel}
    />
  )
  return { onCreated, onCancel }
}

const user = () => userEvent.setup()
const creates = (calls: ReturnType<typeof serveTaskHub>) =>
  writes(calls).filter((c) => c.path === 'task.create')

async function pick(chip: string, choice: string) {
  await user().press(screen.getByTestId(chip))
  await user().press(within(screen.getByTestId('choice-sheet')).getByText(choice))
}

describe('NewTaskScreen', () => {
  it('focuses the title first', async () => {
    hubs()
    await open()
    expect(screen.getByTestId('new-task-title').props.autoFocus).toBe(true)
  })

  it("creates on the project's hub, with the project's default status, then opens the task", async () => {
    const { work, home } = hubs()
    const { onCreated } = await open()
    expect(screen.getByTestId('new-task-project')).toHaveTextContent('Launch')
    expect(screen.getByTestId('new-task-status')).toHaveTextContent('Later')
    await user().type(screen.getByTestId('new-task-title'), '  Ship it ')
    await user().press(screen.getByText('Create'))
    await waitFor(() =>
      expect(creates(work)).toEqual([
        {
          path: 'task.create',
          input: { projectId: 'wp', title: 'Ship it', status: 'later', priority: 3 }
        }
      ])
    )
    expect(creates(home)).toEqual([])
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(workHub.label, 'created'))
  })

  it('Return in the title creates', async () => {
    const { work } = hubs()
    const { onCreated } = await open()
    await fireEvent.changeText(screen.getByTestId('new-task-title'), 'Ship it')
    await fireEvent(screen.getByTestId('new-task-title'), 'submitEditing')
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(workHub.label, 'created'))
    expect(creates(work)).toHaveLength(1)
  })

  it('Cancel with a typed title asks before discarding it; an empty form just leaves', async () => {
    hubs()
    const onDirtyChange = jest.fn()
    const onCancel = jest.fn()
    await render(
      <NewTaskScreen
        hubAddress={workHub.label}
        projectId="wp"
        onCreated={jest.fn()}
        onCancel={onCancel}
        onDirtyChange={onDirtyChange}
      />
    )
    await user().press(screen.getByText('Cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    await fireEvent.changeText(screen.getByTestId('new-task-title'), 'Half a thought')
    expect(onDirtyChange).toHaveBeenLastCalledWith(true, false)
    let answer = 'Keep editing'
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_t, _m, buttons?: AlertButton[]) =>
        buttons?.find((b) => b.text === answer)?.onPress?.()
      )
    await user().press(screen.getByText('Cancel'))
    expect(alert).toHaveBeenCalledWith('Discard this task?', expect.any(String), expect.any(Array))
    expect(onCancel).toHaveBeenCalledTimes(1)
    answer = 'Discard'
    await user().press(screen.getByText('Cancel'))
    expect(onCancel).toHaveBeenCalledTimes(2)
    alert.mockRestore()
  })

  it('fields read their name with their value (VoiceOver)', async () => {
    hubs()
    await open()
    expect(screen.getByLabelText('Status: Later')).toBeOnTheScreen()
    expect(screen.getByLabelText('Priority: Medium')).toBeOnTheScreen()
    expect(screen.getByLabelText('Due: No due date')).toBeOnTheScreen()
    expect(screen.getByLabelText('Project: Launch')).toBeOnTheScreen()
  })

  it('no title: nothing to create', async () => {
    const { work } = hubs()
    await open()
    await user().press(screen.getByText('Create'))
    expect(creates(work)).toEqual([])
  })

  it('starts with the status it was opened with (a column’s “+”)', async () => {
    const { work } = hubs()
    await open({ status: 'doing' })
    expect(screen.getByTestId('new-task-status')).toHaveTextContent('Doing')
    await user().type(screen.getByTestId('new-task-title'), 'x')
    await user().press(screen.getByText('Create'))
    await waitFor(() =>
      expect(creates(work)[0]?.input).toEqual(expect.objectContaining({ status: 'doing' }))
    )
  })

  it('sets priority and due date', async () => {
    const { work } = hubs()
    await open()
    await pick('new-task-priority', 'High')
    // Any day: iOS's calendar, in the same sheet as the quick dates.
    await user().press(screen.getByTestId('new-task-due'))
    await act(async () =>
      fireEvent(
        within(screen.getByTestId('choice-sheet')).getByTestId('due-date-calendar'),
        'change',
        { nativeEvent: { timestamp: new Date(2027, 0, 2, 0, 0).getTime() } }
      )
    )
    expect(screen.queryByTestId('choice-sheet')).toBeNull()
    expect(screen.getByTestId('new-task-due')).toHaveTextContent('Due Jan 2, 2027')
    await user().type(screen.getByTestId('new-task-title'), 'x')
    await user().press(screen.getByText('Create'))
    await waitFor(() =>
      expect(creates(work)[0]?.input).toEqual(
        expect.objectContaining({ priority: 2, dueDate: '2027-01-02' })
      )
    )
  })

  it("preselects the project's default template and applies its status and priority", async () => {
    const { work } = hubs({
      work: [
        template('Bug'),
        template('Feature', { is_default: true, default_status: 'next', default_priority: 1 })
      ]
    })
    await open()
    await waitFor(() =>
      expect(screen.getByTestId('new-task-template')).toHaveTextContent('Feature')
    )
    expect(screen.getByTestId('new-task-status')).toHaveTextContent('Next')
    expect(screen.getByTestId('new-task-priority')).toHaveTextContent('Urgent')
    await user().type(screen.getByTestId('new-task-title'), 'x')
    await user().press(screen.getByText('Create'))
    await waitFor(() =>
      expect(creates(work)[0]?.input).toEqual({
        projectId: 'wp',
        title: 'x',
        status: 'next',
        priority: 1,
        templateId: 'Feature'
      })
    )
  })

  it('starts with the priority and due date it was opened with (a group’s “+”); they win over the template’s', async () => {
    const { work } = hubs({
      work: [template('Feature', { is_default: true, default_status: 'next', default_priority: 4 })]
    })
    await open({ priority: 1, dueDate: '2027-01-02' })
    await waitFor(() =>
      expect(screen.getByTestId('new-task-template')).toHaveTextContent('Feature')
    )
    expect(screen.getByTestId('new-task-priority')).toHaveTextContent('Urgent')
    await user().type(screen.getByTestId('new-task-title'), 'x')
    await user().press(screen.getByText('Create'))
    await waitFor(() =>
      expect(creates(work)[0]?.input).toEqual(
        expect.objectContaining({ priority: 1, dueDate: '2027-01-02', status: 'next' })
      )
    )
  })

  it('a column’s status wins over the template’s', async () => {
    hubs({ work: [template('Feature', { is_default: true, default_status: 'next' })] })
    await open({ status: 'doing' })
    await waitFor(() =>
      expect(screen.getByTestId('new-task-template')).toHaveTextContent('Feature')
    )
    expect(screen.getByTestId('new-task-status')).toHaveTextContent('Doing')
  })

  it('without a default template: "No template" until one is picked', async () => {
    const { work } = hubs({ work: [template('Bug', { default_priority: 2 })] })
    await open()
    await waitFor(() =>
      expect(screen.getByTestId('new-task-template')).toHaveTextContent('No template')
    )
    await pick('new-task-template', 'Bug')
    expect(screen.getByTestId('new-task-priority')).toHaveTextContent('High')
    await user().type(screen.getByTestId('new-task-title'), 'x')
    await user().press(screen.getByText('Create'))
    await waitFor(() =>
      expect(creates(work)[0]?.input).toEqual(expect.objectContaining({ templateId: 'Bug' }))
    )
  })

  it('a project on another hub creates there', async () => {
    const { work, home } = hubs()
    await open()
    await user().press(screen.getByTestId('new-task-project'))
    await user().press(screen.getByTestId(`project-${homeHub.id}-hp`))
    expect(screen.getByTestId('new-task-project')).toHaveTextContent('Chores')
    // Home's project has the default workflow.
    expect(screen.getByTestId('new-task-status')).toHaveTextContent('Inbox')
    await user().type(screen.getByTestId('new-task-title'), 'Home thing')
    await user().press(screen.getByText('Create'))
    await waitFor(() =>
      expect(creates(home)).toEqual([
        {
          path: 'task.create',
          input: { projectId: 'hp', title: 'Home thing', status: 'inbox', priority: 3 }
        }
      ])
    )
    expect(creates(work)).toEqual([])
  })

  it("a subtask: under its parent, in the parent's project (not changeable)", async () => {
    const { work } = hubs()
    await open({ parentId: 'parent' })
    expect(screen.getByText('Subtask of Big thing')).toBeOnTheScreen()
    expect(screen.getByTestId('new-task-project')).toBeDisabled()
    await user().type(screen.getByTestId('new-task-title'), 'Piece')
    await user().press(screen.getByText('Create'))
    await waitFor(() =>
      expect(creates(work)[0]?.input).toEqual(
        expect.objectContaining({ projectId: 'wp', parentId: 'parent', title: 'Piece' })
      )
    )
  })

  it('a refused create says why and keeps what was typed', async () => {
    hubs()
    mockHubs.serve(workHub.id, {
      procedures: {
        'template.getByProject': () => [],
        'task.create': () => {
          throw new Error('Project gone')
        }
      }
    })
    const { onCreated } = await open()
    await user().type(screen.getByTestId('new-task-title'), 'x')
    await user().press(screen.getByText('Create'))
    expect(await screen.findByText("Couldn't create the task: Project gone")).toBeOnTheScreen()
    expect(screen.getByTestId('new-task-title').props.value).toBe('x')
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('names a hub it is not signed in to', async () => {
    hubs()
    await render(
      <NewTaskScreen
        hubAddress="gone.example"
        projectId="wp"
        onCreated={jest.fn()}
        onCancel={jest.fn()}
      />
    )
    expect(screen.getByText('Not signed in to gone.example')).toBeOnTheScreen()
  })
})

it('Cancel during a slow create does not later open the submitted task', async () => {
  hubs()
  let finishCreate!: (task: { id: string }) => void
  const pending = new Promise<{ id: string }>((resolve) => {
    finishCreate = resolve
  })
  const work = serveTaskHub(mockHubs, workHub.id, { 'task.create': () => pending })
  const { onCancel, onCreated } = await open()
  await fireEvent.changeText(screen.getByTestId('new-task-title'), 'Draft during slow create')
  await user().press(screen.getByText('Create'))
  await waitFor(() => expect(creates(work)).toHaveLength(1))
  jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
    buttons?.find((b) => b.text === 'Leave')?.onPress?.()
  })
  await user().press(screen.getByText('Cancel'))
  expect(onCancel).toHaveBeenCalledTimes(1)
  await act(async () => finishCreate({ id: 'slow-response' }))
  expect(onCreated).not.toHaveBeenCalled()
})
