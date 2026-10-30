import { act, render } from '@testing-library/react-native'
import type { TaskBrowserProps } from './TaskBrowser'

const mockRouter = { push: jest.fn(), replace: jest.fn() }
const mockBrowser: { props: TaskBrowserProps | null } = { props: null }
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }))
jest.mock('./hub-connections', () => ({
  useHubFeeds: () => ({ feeds: [], retry: () => undefined, clientFor: () => null })
}))
jest.mock('./hub-sessions', () => ({
  useHubSessions: () => ({ sessions: [], signOut: jest.fn() })
}))
jest.mock('./board/board-prefs-file', () => ({
  boardPrefsFile: {
    load: () => ({ project: null, view: 'kanban', filters: {} }),
    save: () => undefined
  }
}))
jest.mock('./TaskBrowser', () => ({
  ...jest.requireActual('./TaskBrowser'),
  TaskBrowser: (props: TaskBrowserProps) => {
    mockBrowser.props = props
    return null
  }
}))

const { TasksScreen } = jest.requireActual('./TasksScreen') as typeof import('./TasksScreen')

describe('TasksScreen', () => {
  it('"+" opens the create-task screen (new-task) for the project, with the column status', async () => {
    await render(
      <TasksScreen selectedHub={undefined} selectedTask={undefined} select={jest.fn()} />
    )
    await act(async () =>
      mockBrowser.props?.onNewTask({ hub: 'work.example:8788', project: 'p', status: 'doing' })
    )
    expect(mockRouter.push).toHaveBeenCalledWith(
      '/new-task?hub=work.example%3A8788&project=p&status=doing'
    )
    await act(async () => mockBrowser.props?.onNewTask({ hub: 'h', project: 'p' }))
    expect(mockRouter.push).toHaveBeenLastCalledWith('/new-task?hub=h&project=p')
  })

  it('closing the task beside the board goes back to the plain board by default', async () => {
    await render(<TasksScreen selectedHub="h" selectedTask="t" select={jest.fn()} />)
    await act(async () => mockBrowser.props?.onDeselect())
    expect(mockRouter.replace).toHaveBeenCalledWith('/tasks')
  })
})
