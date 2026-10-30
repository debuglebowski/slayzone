import type { TerminalState } from '@slayzone/terminal-contracts'
import { EMPTY_TERMINAL_STATE } from '@slayzone/terminal/terminal-state'
import type { HubConnection } from '@slayzone/transport/client'
import { render, screen, userEvent, within } from '@testing-library/react-native'
import type { BoardData, BoardTask, HubFeed } from '../hub-board'
import { hubEntryOf } from '../hub-session'
import { AgentsScreen } from './AgentsScreen'
import { NO_AGENT_SESSIONS } from './hub-agents'

const home = hubEntryOf('home.example')
const work = hubEntryOf('work.example')
const OPEN: HubConnection = { status: 'open', error: null }

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

/** Agent sessions by session id (`t0:t0` = task t0's main tab). */
const agentsOf = (byId: Record<string, TerminalState>, jobs: Record<string, number> = {}) => ({
  state: { ...EMPTY_TERMINAL_STATE, byId, jobsById: jobs },
  loaded: true,
  error: null
})

const feed = (
  hub: typeof home,
  data: BoardData,
  agents: HubFeed['agents'] = NO_AGENT_SESSIONS
): HubFeed => ({
  hub,
  connection: OPEN,
  stalled: false,
  board: { data, pending: false, error: null, refreshing: false },
  agents
})

const handlers = () => ({ onRetry: jest.fn(), onSignOut: jest.fn(), onOpen: jest.fn() })

describe('AgentsScreen', () => {
  it("lists every hub's agents, what needs the user first", async () => {
    await render(
      <AgentsScreen
        feeds={[
          feed(
            home,
            boardOf('Home', 'Busy', 'Asks you!'),
            agentsOf({ 't0:t0': 'running', 't1:t1': 'idle' })
          ),
          feed(work, boardOf('Work', 'Remote'), agentsOf({ 't0:t0': 'error' }, { 't0:t0': 2 }))
        ]}
        {...handlers()}
      />
    )
    const titles = screen
      .getAllByTestId(/^agent-row-/)
      .map((row) => within(row).getByTestId('agent-title').props.children)
    expect(titles).toEqual(['Asks you!', 'Remote', 'Busy'])
    expect(screen.getByText('Waiting for you')).toBeOnTheScreen()
    expect(screen.getByText('Idle · Unread · Home · home.example')).toBeOnTheScreen()
    expect(screen.getByText('Error · 2 jobs · Work · work.example')).toBeOnTheScreen()
    expect(screen.getByText('2 hubs')).toBeOnTheScreen()
  })

  it('opens an agent with its hub', async () => {
    const h = handlers()
    await render(
      <AgentsScreen
        feeds={[feed(home, boardOf('Home', 'Busy'), agentsOf({ 't0:t0': 'running' }))]}
        {...h}
      />
    )
    await userEvent.setup().press(screen.getByText('Busy'))
    expect(h.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ hubId: home.id, task: expect.objectContaining({ id: 't0' }) })
    )
  })

  it('says when no agent has a session', async () => {
    await render(<AgentsScreen feeds={[feed(home, boardOf('Home', 'Quiet'))]} {...handlers()} />)
    expect(screen.getByText('No agents')).toBeOnTheScreen()
    expect(screen.getByText('home.example')).toBeOnTheScreen()
  })

  it("says when a hub can't be reached, with Retry and Sign out", async () => {
    const h = handlers()
    const unreachable: HubFeed = {
      ...feed(home, boardOf('Home')),
      board: { data: undefined, pending: false, error: 'connect ECONNREFUSED', refreshing: false },
      connection: { status: 'connecting', error: null }
    }
    await render(<AgentsScreen feeds={[unreachable]} {...h} />)
    const banner = within(screen.getByTestId(`hub-banner-${home.id}`))
    expect(banner.getByText("Can't reach home.example")).toBeOnTheScreen()
    const user = userEvent.setup()
    await user.press(banner.getByText('Retry'))
    expect(h.onRetry).toHaveBeenCalledWith(home.id)
    await user.press(banner.getByText('Sign out'))
    expect(h.onSignOut).toHaveBeenCalledWith(home.id)
  })
})
