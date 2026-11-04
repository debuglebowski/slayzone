import type { TerminalState } from '@slayzone/terminal-contracts'
import { EMPTY_TERMINAL_STATE } from '@slayzone/terminal/terminal-state'
import { act, render, screen, userEvent, waitFor, within } from '@testing-library/react-native'
import { Alert } from 'react-native'
import { type BoardData, type BoardTask, findTaskRow, type HubFeed } from '../hub-board'
import { hubEntryOf } from '../hub-session'
import { trpcTest } from '../testing'
import { AgentPanel, type AgentPanelProps } from './AgentPanel'

/** How many times a terminal was mounted (a new process gets a fresh terminal). */
const mockTerminal = { mounts: 0 }

// The terminal (a web view) and the chat view (the chat half's) are stand-ins here.
jest.mock('../terminal/TerminalView', () => ({
  TerminalView: ({ sessionId, live }: { sessionId: string; live: boolean }) => {
    const { Text: T } = jest.requireActual('react-native')
    const { useEffect } = jest.requireActual('react')
    useEffect(() => {
      mockTerminal.mounts++
    }, [])
    return <T testID="terminal">{`terminal ${sessionId} ${live ? 'live' : 'not running'}`}</T>
  }
}))
jest.mock('../chat', () => ({
  ChatSession: (props: { hubId: string; taskId: string; tabId: string; mode: string }) => {
    const { Text: T } = jest.requireActual('react-native')
    return <T testID="chat">{`chat ${props.hubId} ${props.taskId} ${props.tabId} ${props.mode}`}</T>
  }
}))

const hub = hubEntryOf('home.example')

function taskOf(fields: Partial<BoardTask> = {}): BoardTask {
  return {
    id: 't',
    title: 'Fix login',
    status: 'in_progress',
    priority: 2,
    project_id: 'p',
    parent_id: null,
    needs_attention: false,
    agent_id: 'claude-code',
    provider_config: { 'claude-code': { conversationId: 'c1' } },
    ...fields
  } as unknown as BoardTask
}

function feedOf(
  task: BoardTask,
  byId: Record<string, TerminalState>,
  jobs: Record<string, number> = {}
): HubFeed {
  return {
    hub,
    connection: { status: 'open', error: null },
    stalled: false,
    board: {
      data: {
        tasks: [task],
        projects: [{ id: 'p', name: 'Web', color: null }],
        tags: [],
        taskTags: {},
        blockedTaskIds: []
      } as unknown as BoardData,
      pending: false,
      error: null,
      refreshing: false
    },
    agents: { state: { ...EMPTY_TERMINAL_STATE, byId, jobsById: jobs }, loaded: true, error: null }
  }
}

const tab = (id: string, mode: string, isMain: boolean, position = 0) => ({
  id,
  taskId: 't',
  groupId: id,
  label: null,
  mode,
  isMain,
  position,
  createdAt: '2026-10-30',
  agentState: 'running'
})

/** A hub that answers the screen's calls and records the writes, in order. */
function backend(tabs: unknown[] = [tab('t', 'claude-code', true)]) {
  const calls: Array<[string, unknown]> = []
  const record =
    (path: string, answer: (input: unknown) => unknown = () => null) =>
    (input: unknown) => {
      calls.push([path, input])
      return answer(input)
    }
  const started = {
    sessionId: 't:t',
    tabId: 't',
    mode: 'claude-code',
    kind: 'pty',
    cwd: '/repo',
    state: 'starting',
    started: true
  }
  const test = trpcTest({
    procedures: {
      'taskTerminals.list': () => tabs,
      'taskTerminals.ensureMain': record('taskTerminals.ensureMain', () =>
        tab('t', 'claude-code', true)
      ),
      'task.update': record('task.update'),
      'task.switchMode': record('task.switchMode'),
      'task.startMainAgent': record('task.startMainAgent', () => started),
      'task.resetConversation': record('task.resetConversation'),
      'pty.kill': record('pty.kill', () => true),
      'pty.write': record('pty.write', () => true),
      'pty.interrupt': record('pty.interrupt', () => true),
      'chat.kill': record('chat.kill'),
      'pty.agentsList': () => [
        { id: 'claude-code', label: 'Claude Code', enabled: true, order: 0 },
        { id: 'codex', label: 'Codex', enabled: true, order: 1 },
        { id: 'gemini', label: 'Gemini', enabled: false, order: 2 }
      ]
    },
    subscriptions: { 'taskTerminals.onChanged': () => undefined }
  })
  return { ...test, calls, paths: () => calls.map(([path]) => path) }
}

/** Confirms every "are you sure?" the screen asks. */
function confirmAll() {
  return jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    buttons?.find((b) => b.style === 'destructive')?.onPress?.()
  })
}

function renderScreen(
  feed: HubFeed,
  b: ReturnType<typeof backend>,
  extra: { tabId?: string; onSelectTab?: (id: string) => void } = {}
) {
  return render(
    <AgentPanel
      hubId={hub.id}
      feed={feed}
      row={findTaskRow(feed, 't')!}
      showHub={false}
      tabId={extra.tabId}
      onSelectTab={extra.onSelectTab ?? (() => undefined)}
    />,
    { wrapper: b.wrapper }
  )
}

afterEach(() => jest.restoreAllMocks())

/** Opens the ⋯ of the agent bar, then presses `label`. */
async function more(label: string) {
  const user = userEvent.setup()
  await user.press(screen.getByLabelText('More agent actions'))
  await user.press(within(screen.getByTestId('agent-menu')).getByText(label))
}

describe('AgentPanel', () => {
  it("shows the task's terminal agent, its state and its background jobs", async () => {
    const b = backend()
    await renderScreen(feedOf(taskOf(), { 't:t': 'running' }, { 't:t': 2 }), b)
    expect(screen.getByText('Active · 2 background jobs')).toBeOnTheScreen()
    expect(screen.getByTestId('agent-dot-running')).toBeOnTheScreen()
    expect(await screen.findByText('terminal t:t live')).toBeOnTheScreen()
  })

  it('shows a chat tab with the chat view, in its hub', async () => {
    const b = backend([tab('t', 'claude-chat', true)])
    await renderScreen(feedOf(taskOf({ agent_id: 'claude-chat' }), { 't:t': 'idle' }), b)
    expect(await screen.findByText(`chat ${hub.id} t t claude-chat`)).toBeOnTheScreen()
  })

  it('opening it marks the task read (once), as opening it on desktop does', async () => {
    const b = backend()
    const view = await renderScreen(feedOf(taskOf({ needs_attention: true }), { 't:t': 'idle' }), b)
    await waitFor(() =>
      expect(b.calls).toContainEqual(['task.update', { id: 't', needsAttention: false }])
    )
    const next = feedOf(taskOf({ needs_attention: true, title: 'Fix login!' }), { 't:t': 'idle' })
    await view.rerender(
      <AgentPanel
        hubId={hub.id}
        feed={next}
        row={findTaskRow(next, 't')!}
        showHub={false}
        tabId={undefined}
        onSelectTab={() => undefined}
      />
    )
    await act(async () => undefined)
    expect(b.paths().filter((p) => p === 'task.update')).toHaveLength(1)
  })

  it('leaves a read task alone', async () => {
    const b = backend()
    await renderScreen(feedOf(taskOf(), { 't:t': 'idle' }), b)
    await screen.findByText('terminal t:t live')
    expect(b.paths()).not.toContain('task.update')
  })

  it('starts a stopped agent through the hub', async () => {
    const b = backend()
    await renderScreen(feedOf(taskOf(), { 't:t': 'dead' }), b)
    expect(await screen.findByText('terminal t:t not running')).toBeOnTheScreen()
    await userEvent.setup().press(screen.getByText('Start'))
    await waitFor(() => expect(b.calls).toEqual([['task.startMainAgent', { taskId: 't' }]]))
  })

  it('gives a restarted agent a fresh terminal (its output starts over), not a mere state change', async () => {
    const b = backend()
    mockTerminal.mounts = 0
    const props = (feed: HubFeed): AgentPanelProps => ({
      hubId: hub.id,
      feed,
      row: findTaskRow(feed, 't')!,
      showHub: false,
      tabId: undefined,
      onSelectTab: () => undefined
    })
    const view = await renderScreen(feedOf(taskOf(), { 't:t': 'running' }), b)
    await view.rerender(<AgentPanel {...props(feedOf(taskOf(), { 't:t': 'idle' }))} />)
    expect(mockTerminal.mounts).toBe(1)
    await view.rerender(<AgentPanel {...props(feedOf(taskOf(), { 't:t': 'dead' }))} />)
    await view.rerender(<AgentPanel {...props(feedOf(taskOf(), { 't:t': 'starting' }))} />)
    expect(mockTerminal.mounts).toBe(2)
  })

  it('asks before stopping, then stops', async () => {
    const b = backend()
    const alert = confirmAll()
    await renderScreen(feedOf(taskOf(), { 't:t': 'running' }), b)
    await userEvent.setup().press(screen.getByText('Stop'))
    expect(alert).toHaveBeenCalled()
    await waitFor(() => expect(b.calls).toEqual([['pty.kill', { sessionId: 't:t' }]]))
  })

  it('does nothing when the user cancels', async () => {
    const b = backend()
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    await renderScreen(feedOf(taskOf(), { 't:t': 'running' }), b)
    await userEvent.setup().press(screen.getByText('Stop'))
    await act(async () => undefined)
    expect(b.calls).toEqual([])
  })

  it('resets to a fresh conversation (after asking)', async () => {
    const b = backend()
    confirmAll()
    await renderScreen(feedOf(taskOf(), { 't:t': 'running' }), b)
    await more('Reset')
    await waitFor(() =>
      expect(b.paths()).toEqual(['pty.kill', 'task.resetConversation', 'task.startMainAgent'])
    )
  })

  it('restarts (after asking)', async () => {
    const b = backend()
    confirmAll()
    await renderScreen(feedOf(taskOf(), { 't:t': 'running' }), b)
    await more('Restart')
    await waitFor(() => expect(b.paths()).toEqual(['pty.kill', 'task.startMainAgent']))
  })

  it('interrupts a terminal agent without asking', async () => {
    const b = backend()
    const alert = confirmAll()
    await renderScreen(feedOf(taskOf(), { 't:t': 'running' }), b)
    await userEvent.setup().press(screen.getByText('Interrupt'))
    await waitFor(() => expect(b.paths()).toEqual(['pty.write', 'pty.interrupt']))
    expect(alert).not.toHaveBeenCalled()
  })

  it('switches the provider among the enabled modes (after asking)', async () => {
    const b = backend()
    confirmAll()
    await renderScreen(feedOf(taskOf(), { 't:t': 'running' }), b)
    const user = userEvent.setup()
    await user.press(await screen.findByLabelText('Change provider'))
    const picker = within(await screen.findByTestId('mode-picker'))
    expect(picker.queryByText('Gemini')).toBeNull()
    await user.press(picker.getByText('Codex'))
    await waitFor(() =>
      expect(b.calls).toEqual([
        ['task.switchMode', { taskId: 't', mode: 'codex' }],
        ['task.startMainAgent', { taskId: 't' }]
      ])
    )
  })

  it("lists the task's tabs and opens another", async () => {
    const b = backend([tab('t', 'claude-code', true), tab('side', 'terminal', false, 1)])
    const onSelectTab = jest.fn()
    await renderScreen(feedOf(taskOf(), { 't:t': 'running', 't:side': 'idle' }), b, { onSelectTab })
    // Desktop's tab labels: the main tab by its provider, another by "Terminal".
    expect(await screen.findByText('Claude Code')).toBeOnTheScreen()
    await userEvent.setup().press(screen.getByText('Terminal'))
    expect(onSelectTab).toHaveBeenCalledWith('side')
  })

  it('shows the tab the route names', async () => {
    const b = backend([tab('t', 'claude-code', true), tab('side', 'terminal', false, 1)])
    await renderScreen(feedOf(taskOf(), { 't:t': 'running', 't:side': 'idle' }), b, {
      tabId: 'side'
    })
    expect(await screen.findByText('terminal t:side live')).toBeOnTheScreen()
  })

  it('creates the main tab when the task has none yet (as desktop does on open)', async () => {
    const b = backend([])
    await renderScreen(feedOf(taskOf(), {}), b)
    await waitFor(() =>
      expect(b.calls).toContainEqual([
        'taskTerminals.ensureMain',
        { taskId: 't', mode: 'claude-code' }
      ])
    )
  })
})
