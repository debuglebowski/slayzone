import type { TerminalState } from '@slayzone/terminal-contracts'
import { EMPTY_TERMINAL_STATE } from '@slayzone/terminal/terminal-state'
import type { HubConnection } from '@slayzone/transport/client'
import { render, screen, userEvent, within } from '@testing-library/react-native'
import { type HubAgentSessions, NO_AGENT_SESSIONS } from './agents/hub-agents'
import type { BoardData, BoardTask, HubFeed } from './hub-board'
import { hubEntryOf } from './hub-session'
import { TaskBrowser, type TaskBrowserProps } from './TaskBrowser'

// The task's computer card and artifacts link read their hub (their own suites test them).
jest.mock('./computers/TaskComputer', () => ({ TaskComputer: () => null }))
jest.mock('./artifacts/TaskArtifactsLink', () => ({ TaskArtifactsLink: () => null }))

const home = hubEntryOf('home.example')
const work = hubEntryOf('work.example')

const OPEN: HubConnection = { status: 'open', error: null }
const FAILED: HubConnection = { status: 'connecting', error: new Error('WebSocket closed') }

function boardOf(projectName: string, ...titles: string[]): BoardData {
  return {
    tasks: titles.map(
      (title, i) =>
        ({
          id: `t${i}`,
          title,
          status: 'todo',
          priority: 2,
          project_id: 'p1',
          parent_id: null,
          description: `About ${title}`,
          // A title ending in "!" is unread (needs_attention).
          needs_attention: title.endsWith('!')
        }) as BoardTask
    ),
    projects: [{ id: 'p1', name: projectName, color: null }],
    tags: [],
    taskTags: {},
    blockedTaskIds: []
  } as unknown as BoardData
}

const loading = (hub: typeof home): HubFeed => ({
  hub,
  connection: OPEN,
  stalled: false,
  board: { data: undefined, pending: true, error: null, refreshing: false },
  agents: NO_AGENT_SESSIONS
})
const loaded = (
  hub: typeof home,
  data: BoardData,
  agents: HubAgentSessions = NO_AGENT_SESSIONS
): HubFeed => ({
  hub,
  connection: OPEN,
  stalled: false,
  board: { data, pending: false, error: null, refreshing: false },
  agents
})
const unreachable = (hub: typeof home): HubFeed => ({
  hub,
  connection: FAILED,
  stalled: true,
  board: { data: undefined, pending: true, error: null, refreshing: false },
  agents: NO_AGENT_SESSIONS
})
/** Agent sessions by session id (`t0:t0` = task t0's main tab). */
const agentsOf = (byId: Record<string, TerminalState>, jobs: Record<string, number> = {}) => ({
  state: { ...EMPTY_TERMINAL_STATE, byId, jobsById: jobs },
  loaded: true,
  error: null
})

function props(fields: Partial<TaskBrowserProps>): TaskBrowserProps {
  return {
    feeds: [],
    layout: 'list',
    selected: null,
    onSelect: jest.fn(),
    onRetry: jest.fn(),
    onSignOut: jest.fn(),
    onManageHubs: jest.fn(),
    onShowProjects: jest.fn(),
    onSearchArtifacts: jest.fn(),
    onOpenAgent: jest.fn(),
    onShowAgents: jest.fn(),
    ...fields
  }
}

describe('TaskBrowser', () => {
  // A session whose hub is gone must still be able to sign out: Sign out stays while
  // the board loads and when it fails (fix of 2026-10-29).
  it('offers Sign out while the board is loading', async () => {
    const p = props({ feeds: [loading(home)] })
    await render(<TaskBrowser {...p} />)

    await userEvent.setup().press(screen.getByText('Sign out'))
    expect(p.onSignOut).toHaveBeenCalledWith(home.id)
  })

  it("says when a hub can't be reached, with Retry and Sign out", async () => {
    const p = props({ feeds: [unreachable(home)] })
    await render(<TaskBrowser {...p} />)

    const banner = within(screen.getByTestId(`hub-banner-${home.id}`))
    expect(banner.getByText("Can't reach home.example")).toBeOnTheScreen()
    const user = userEvent.setup()
    await user.press(banner.getByText('Retry'))
    expect(p.onRetry).toHaveBeenCalledWith(home.id)
    await user.press(banner.getByText('Sign out'))
    expect(p.onSignOut).toHaveBeenCalledWith(home.id)
  })

  it('offers Sign out when a connected hub refuses the board', async () => {
    const refused: HubFeed = {
      ...loaded(home, boardOf('Home')),
      board: {
        data: undefined,
        pending: false,
        error: 'hub requires authentication',
        refreshing: false
      }
    }
    const p = props({ feeds: [refused] })
    await render(<TaskBrowser {...p} />)

    const banner = within(screen.getByTestId(`hub-banner-${home.id}`))
    expect(banner.getByText('hub requires authentication')).toBeOnTheScreen()
    await userEvent.setup().press(banner.getByText('Sign out'))
    expect(p.onSignOut).toHaveBeenCalledWith(home.id)
  })

  it("lists every hub's tasks in one list, each tagged with its hub", async () => {
    const p = props({
      feeds: [loaded(home, boardOf('Home', 'Write spec')), loaded(work, boardOf('Work', 'Ship'))]
    })
    await render(<TaskBrowser {...p} />)

    expect(screen.getByText('Write spec')).toBeOnTheScreen()
    expect(screen.getByText('Ship')).toBeOnTheScreen()
    expect(screen.getByText('Home · todo · home.example')).toBeOnTheScreen()
    expect(screen.getByText('Work · todo · work.example')).toBeOnTheScreen()
  })

  it("keeps showing the reachable hubs' tasks while another can't be reached", async () => {
    const p = props({ feeds: [unreachable(home), loaded(work, boardOf('Work', 'Ship'))] })
    await render(<TaskBrowser {...p} />)

    expect(screen.getByText('Ship')).toBeOnTheScreen()
    expect(screen.getByText("Can't reach home.example")).toBeOnTheScreen()
  })

  it('opens a task with its hub (two hubs may share task ids)', async () => {
    const p = props({
      feeds: [loaded(home, boardOf('Home', 'Same')), loaded(work, boardOf('Work', 'Same'))]
    })
    await render(<TaskBrowser {...p} />)

    await userEvent.setup().press(screen.getAllByText('Same')[1])
    expect(p.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ hubId: work.id, task: expect.objectContaining({ id: 't0' }) })
    )
  })

  it('on a wide screen shows the selected task beside the list', async () => {
    const p = props({
      layout: 'split',
      feeds: [loaded(home, boardOf('Home', 'First', 'Second'))],
      selected: { hubId: home.id, taskId: 't1' }
    })
    await render(<TaskBrowser {...p} />)

    expect(screen.getByText('About Second')).toBeOnTheScreen()
    expect(screen.queryByText('About First')).toBeNull()
  })

  it('on a wide screen shows the first task until one is picked', async () => {
    const p = props({ layout: 'split', feeds: [loaded(home, boardOf('Home', 'First', 'Second'))] })
    await render(<TaskBrowser {...p} />)
    expect(screen.getByText('About First')).toBeOnTheScreen()
  })

  it('opens the hubs screen', async () => {
    const p = props({ feeds: [loaded(home, boardOf('Home'))] })
    await render(<TaskBrowser {...p} />)
    await userEvent.setup().press(screen.getByText('Hubs'))
    expect(p.onManageHubs).toHaveBeenCalled()
  })

  it('opens the projects screen and artifact search', async () => {
    const p = props({ feeds: [loaded(home, boardOf('Home'))] })
    await render(<TaskBrowser {...p} />)
    const user = userEvent.setup()
    await user.press(screen.getByText('Projects'))
    expect(p.onShowProjects).toHaveBeenCalled()
    await user.press(screen.getByText('Search'))
    expect(p.onSearchArtifacts).toHaveBeenCalled()
  })

  it("lists every hub's agents above the tasks, what needs the user first", async () => {
    const p = props({
      feeds: [
        loaded(
          home,
          boardOf('Home', 'Busy', 'Asks you!'),
          agentsOf({ 't0:t0': 'running', 't1:t1': 'idle' })
        ),
        loaded(work, boardOf('Work', 'Remote'), agentsOf({ 't0:t0': 'error' }, { 't0:t0': 2 }))
      ]
    })
    await render(<TaskBrowser {...p} />)

    const agents = within(screen.getByTestId('agents-section'))
    const titles = agents
      .getAllByTestId(/^agent-row-/)
      .map((row) => within(row).getByTestId('agent-title').props.children)
    expect(titles).toEqual(['Asks you!', 'Remote', 'Busy'])
    expect(agents.getByText('Waiting for you')).toBeOnTheScreen()
    expect(agents.getByText('Idle · Unread · Home · home.example')).toBeOnTheScreen()
    expect(agents.getByText('Error · 2 jobs · Work · work.example')).toBeOnTheScreen()
  })

  it('opens an agent with its hub', async () => {
    const p = props({
      feeds: [loaded(home, boardOf('Home', 'Busy'), agentsOf({ 't0:t0': 'running' }))]
    })
    await render(<TaskBrowser {...p} />)
    await userEvent.setup().press(within(screen.getByTestId('agents-section')).getByText('Busy'))
    expect(p.onOpenAgent).toHaveBeenCalledWith(
      expect.objectContaining({ hubId: home.id, task: expect.objectContaining({ id: 't0' }) })
    )
  })

  it('says when no agent has a session', async () => {
    const p = props({ feeds: [loaded(home, boardOf('Home', 'Quiet'))] })
    await render(<TaskBrowser {...p} />)
    expect(within(screen.getByTestId('agents-section')).getByText('No agents')).toBeOnTheScreen()
  })

  it('shows the first agents and a link to all of them', async () => {
    const titles = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
    const p = props({
      feeds: [
        loaded(
          home,
          boardOf('Home', ...titles),
          agentsOf(Object.fromEntries(titles.map((_, i) => [`t${i}:t${i}`, 'running'])))
        )
      ]
    })
    await render(<TaskBrowser {...p} />)
    const agents = within(screen.getByTestId('agents-section'))
    expect(agents.getAllByTestId(/^agent-row-/)).toHaveLength(5)
    await userEvent.setup().press(agents.getByText('All agents (7)'))
    expect(p.onShowAgents).toHaveBeenCalled()
  })
})
