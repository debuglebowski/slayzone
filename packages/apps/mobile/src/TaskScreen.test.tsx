import { render, screen, userEvent } from '@testing-library/react-native'
import { NO_AGENT_SESSIONS } from './agents/hub-agents'
import type { BoardData, HubFeed } from './hub-board'
import { hubEntryOf } from './hub-session'
import { TaskScreen } from './TaskScreen'

// The task's computer card and artifacts link read their hub (their own suites test them).
jest.mock('./computers/TaskComputer', () => ({ TaskComputer: () => null }))
jest.mock('./artifacts/TaskArtifactsLink', () => ({ TaskArtifactsLink: () => null }))

const home = hubEntryOf('home.example')
const session = { entry: home, token: 't' }

const feed = (data: BoardData | undefined, pending = false): HubFeed => ({
  hub: home,
  connection: { status: 'open', error: null },
  stalled: false,
  board: { data, pending, error: null, refreshing: false },
  agents: NO_AGENT_SESSIONS
})

const board = {
  tasks: [
    {
      id: 'sub',
      title: 'A subtask',
      status: 'todo',
      priority: 1,
      project_id: 'p1',
      parent_id: 'x',
      description: 'Its notes'
    }
  ],
  projects: [{ id: 'p1', name: 'Home', color: null }],
  tags: [],
  taskTags: {},
  blockedTaskIds: []
} as unknown as BoardData

describe('TaskScreen (phone)', () => {
  it('shows the task its route names, on its hub', async () => {
    await render(
      <TaskScreen
        hubAddress="home.example"
        taskId="sub"
        sessions={[session]}
        feeds={[feed(board)]}
        onBack={jest.fn()}
        onOpenAgent={jest.fn()}
      />
    )
    expect(screen.getByText('A subtask')).toBeOnTheScreen()
    expect(screen.getByText('Its notes')).toBeOnTheScreen()
  })

  it('waits for the hub’s board', async () => {
    await render(
      <TaskScreen
        hubAddress="home.example"
        taskId="sub"
        sessions={[session]}
        feeds={[feed(undefined, true)]}
        onBack={jest.fn()}
        onOpenAgent={jest.fn()}
      />
    )
    expect(screen.getByTestId('task-loading')).toBeOnTheScreen()
  })

  it('says when the task is not on that hub', async () => {
    await render(
      <TaskScreen
        hubAddress="home.example"
        taskId="gone"
        sessions={[session]}
        feeds={[feed(board)]}
        onBack={jest.fn()}
        onOpenAgent={jest.fn()}
      />
    )
    expect(screen.getByText('No such task on home.example')).toBeOnTheScreen()
  })

  it('says when the app is not signed in to the hub a link names', async () => {
    const onBack = jest.fn()
    await render(
      <TaskScreen
        hubAddress="other.example"
        taskId="sub"
        sessions={[session]}
        feeds={[feed(board)]}
        onBack={onBack}
        onOpenAgent={jest.fn()}
      />
    )
    expect(screen.getByText('Not signed in to other.example')).toBeOnTheScreen()
    await userEvent.setup().press(screen.getByText('‹ Back'))
    expect(onBack).toHaveBeenCalled()
  })

  it("opens the task's agent (where it can be started)", async () => {
    const onOpenAgent = jest.fn()
    await render(
      <TaskScreen
        hubAddress="home.example"
        taskId="sub"
        sessions={[session]}
        feeds={[feed(board)]}
        onBack={jest.fn()}
        onOpenAgent={onOpenAgent}
      />
    )
    await userEvent.setup().press(screen.getByText('Agent ›'))
    expect(onOpenAgent).toHaveBeenCalledWith('sub')
  })
})
