import { render, screen, userEvent, waitFor, within } from '@testing-library/react-native'
import type { TaskTemplate } from '@slayzone/task-contracts'
import type { ReactNode } from 'react'
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

async function open(params: { status?: string; parentId?: string } = {}) {
  const onCreated = jest.fn()
  const onCancel = jest.fn()
  await render(
    <NewTaskScreen
      hubAddress={workHub.label}
      projectId="wp"
      status={params.status}
      parentId={params.parentId}
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
    await pick('new-task-due', 'Pick a date…')
    await user().type(screen.getByTestId('due-date-input'), '2027-01-02')
    await user().press(screen.getByText('Set'))
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
