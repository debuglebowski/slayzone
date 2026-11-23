import { act, render, screen, userEvent, waitFor, within } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { Alert, type AlertButton } from 'react-native'
import type { AgentPanelProps } from '../agents/AgentPanel'
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
// The panels have suites of their own (`AgentPanel.test.tsx`, `PhoneTaskPage.test.tsx`:
// the phone's page around the agent).
/** How often the agent panel mounted (a remount loses its draft, terminal, uploads), and the props it got last. */
const mockAgent = { mounts: 0, props: null as AgentPanelProps | null }
jest.mock('../agents/AgentPanel', () => ({
  AgentPanel: (props: AgentPanelProps) => {
    const { useEffect } = jest.requireActual('react')
    const { Text } = jest.requireActual('react-native')
    mockAgent.props = props
    useEffect(() => {
      mockAgent.mounts++
    }, [])
    const body = <Text>agent panel</Text>
    return props.renderWide ? props.renderWide(body) : body
  }
}))
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
async function show({
  wide = false,
  segment = 'agent',
  board = boardWith()
}: {
  wide?: boolean
  segment?: TaskSegment
  board?: BoardData
} = {}) {
  const work = serveTaskHub(mockHubs, workHub.id)
  serveTaskHub(mockHubs, homeHub.id)
  mockFeeds.list = [feedOf(homeHub, boardOf({})), feedOf(workHub, board)]
  const handlers = {
    onSegment: jest.fn(),
    onBack: jest.fn(),
    onDeleted: jest.fn()
  }
  const props = (shown: TaskSegment, isWide = wide): TaskPageProps => ({
    row: rowFrom(workHub, board),
    feed: feedOf(workHub, board),
    session: { entry: hubEntryOf(workHub.label), token: 't' } as never,
    showHub: true,
    wide: isWide,
    segment: shown,
    onOpenTask: jest.fn(),
    onOpenArtifact: jest.fn(),
    ...handlers
  })
  const view = await render(<TaskPage {...props(segment)} />)
  if (wide) await waitFor(() => expect(work.some((c) => c.path === 'task.getBlockers')).toBe(true))
  await act(async () => undefined)
  const showSegment = async (next: TaskSegment) => {
    await view.rerender(<TaskPage {...props(next)} />)
  }
  const resizeWide = async () => view.rerender(<TaskPage {...props(segment, true)} />)
  return { work, showSegment, resizeWide, ...handlers }
}

const user = () => userEvent.setup()

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
  mockAgent.props = null
})

describe('TaskPage on a phone', () => {
  it('the page lays itself out around the agent (`PhoneTaskPage`), with the task as edited', async () => {
    await show()
    expect(mockAgent.props?.phone).toBeInstanceOf(Function)
    expect(mockAgent.props?.row.task.title).toBe('Write spec')
  })
})

describe('TaskPage on an iPad (wide): Agent and Details side by side', () => {
  it('the header (back, ⋯, the title and its fields), the agent pane, Details | Artifacts', async () => {
    const { onSegment } = await show({ wide: true, segment: 'details' })
    expect(screen.getByText('‹ Home')).toBeOnTheScreen()
    expect(screen.getByDisplayValue('Write spec')).toBeOnTheScreen()
    expect(screen.getByLabelText('Priority: Medium')).toBeOnTheScreen()
    expect(screen.getByTestId('pane-agent')).toBeOnTheScreen()
    expect(screen.getByTestId('task-details')).toBeOnTheScreen()
    expect(mockAgent.props?.phone).toBeUndefined()
    expect(screen.getByTestId('segment-artifacts')).toHaveTextContent('Artifacts 2')
    await user().press(screen.getByTestId('segment-artifacts'))
    expect(onSegment).toHaveBeenCalledWith('artifacts')
  })

  it('keeps Details mounted while Artifacts shows', async () => {
    const { showSegment } = await show({ wide: true, segment: 'details' })
    await showSegment('artifacts')
    expect(screen.getByText('artifact list')).toBeOnTheScreen()
    expect(screen.queryByTestId('task-details')).toBeNull()
    expect(screen.getByTestId('task-details', { includeHiddenElements: true })).toBeTruthy()
    expect(mockAgent.mounts).toBe(1)
  })

  it('⋯ archives after asking', async () => {
    const { work } = await show({ wide: true, segment: 'details' })
    answerAlert('Archive')
    await user().press(screen.getByTestId('task-menu'))
    await user().press(within(screen.getByTestId('task-menu-sheet')).getByText('Archive'))
    await waitFor(() =>
      expect(writes(work)).toEqual([{ path: 'task.archive', input: { id: 't1' } }])
    )
  })
})

it('iPad width change keeps the agent panel and its in-memory draft mounted', async () => {
  const { resizeWide } = await show()
  expect(mockAgent.mounts).toBe(1)
  await resizeWide()
  expect(mockAgent.mounts).toBe(1)
})
