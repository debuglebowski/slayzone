import { act, render, screen, userEvent, waitFor, within } from '@testing-library/react-native'
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
// The panels have suites of their own (`AgentPanel.test.tsx`, `TaskInfoSheet.test.tsx`).
/**
 * How often the agent panel mounted (a remount loses its draft, terminal, uploads), the
 * props it got last, and what it hands the phone's nav bar.
 */
const mockAgent = {
  mounts: 0,
  props: null as AgentPanelProps | null,
  nav: {
    provider: 'Claude Chat',
    status: 'Idle · Unread',
    dot: 'idle',
    busy: false,
    openMenu: jest.fn(),
    start: null
  } as AgentNav
}
jest.mock('../agents/AgentPanel', () => ({
  AgentPanel: (props: AgentPanelProps) => {
    const { useEffect } = jest.requireActual('react')
    const { Text } = jest.requireActual('react-native')
    mockAgent.props = props
    useEffect(() => {
      mockAgent.mounts++
    }, [])
    return (
      <>
        {props.nav?.(mockAgent.nav)}
        <Text>agent panel</Text>
      </>
    )
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
    onOpenInfo: jest.fn(),
    onBack: jest.fn(),
    onDeleted: jest.fn()
  }
  const props = (shown: TaskSegment): TaskPageProps => ({
    row: rowFrom(workHub, board),
    feed: feedOf(workHub, board),
    session: { entry: hubEntryOf(workHub.label), token: 't' } as never,
    showHub: true,
    wide,
    segment: shown,
    agentTabId: undefined,
    onSelectAgentTab: jest.fn(),
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
  return { work, showSegment, ...handlers }
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
  mockAgent.nav = { ...mockAgent.nav, busy: false, start: null, openMenu: jest.fn() }
})

describe('TaskPage on a phone: the page is the conversation', () => {
  it('a nav bar (back, the title, the agent under it), then the agent — no segments, no field line', async () => {
    await show()
    expect(screen.getByLabelText('Back to Home')).toBeOnTheScreen()
    expect(screen.getByTestId('task-title')).toHaveTextContent('Write spec')
    expect(screen.getByTestId('task-agent-line')).toHaveTextContent('Claude Chat · Idle · Unread')
    expect(screen.getByText('agent panel')).toBeOnTheScreen()
    expect(screen.queryByTestId('segment-agent')).toBeNull()
    expect(screen.queryByTestId('segment-details')).toBeNull()
    expect(screen.queryByLabelText('Priority: Medium')).toBeNull()
    expect(screen.queryByDisplayValue('Write spec')).toBeNull()
  })

  it('the title is one line', async () => {
    await show()
    expect(screen.getByTestId('task-title').props.numberOfLines).toBe(1)
  })

  it("the agent's bar is the nav bar; a chat's controls are its composer's model pill", async () => {
    await show()
    expect(mockAgent.props?.nav).toBeInstanceOf(Function)
  })

  it('tapping the title opens the agent menu', async () => {
    await show()
    const title = screen.getByLabelText('Write spec, Claude Chat · Idle · Unread')
    expect(title.props.accessibilityHint).toBe('Opens the agent menu.')
    await user().press(title)
    expect(mockAgent.nav.openMenu).toHaveBeenCalled()
  })

  it('Start stays up front while the agent offers it', async () => {
    const start = jest.fn()
    mockAgent.nav = { ...mockAgent.nav, start }
    await show()
    await user().press(screen.getByLabelText('Start the agent'))
    expect(start).toHaveBeenCalled()
  })

  it('ⓘ opens Details and Artifacts as a sheet', async () => {
    const { onOpenInfo } = await show()
    await user().press(screen.getByLabelText('Details and artifacts'))
    expect(onOpenInfo).toHaveBeenCalledWith('details')
  })

  it('back goes back', async () => {
    const { onBack } = await show()
    await user().press(screen.getByLabelText('Back to Home'))
    expect(onBack).toHaveBeenCalled()
  })

  it('the agent stays mounted (its draft and terminal survive)', async () => {
    const { showSegment } = await show()
    await showSegment('details')
    await showSegment('agent')
    expect(screen.getByText('agent panel')).toBeOnTheScreen()
    expect(mockAgent.mounts).toBe(1)
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
    expect(mockAgent.props?.nav).toBeUndefined()
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
