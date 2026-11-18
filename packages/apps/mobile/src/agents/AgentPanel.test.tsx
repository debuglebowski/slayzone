import type { TerminalState } from '@slayzone/terminal-contracts'
import { EMPTY_TERMINAL_STATE } from '@slayzone/terminal/terminal-state'
import { act, render, screen, userEvent, waitFor, within } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { Alert, Pressable, Text, View } from 'react-native'
import { type BoardData, type BoardTask, findTaskRow, type HubFeed } from '../hub-board'
import { hubEntryOf } from '../hub-session'
import { trpcTest } from '../testing'
import { type AgentNav, AgentPanel, type AgentPanelProps } from './AgentPanel'

/** How many times a terminal was mounted (a new process gets a fresh terminal), what
 *  it was asked through its handle, and the grid it reports. */
const mockTerminal = {
  mounts: 0,
  calls: [] as string[],
  grid: undefined as { cols: number; rows: number } | undefined,
  textSize: 'readable' as 'readable' | 'fit',
  props: null as null | Record<string, unknown>
}

// The terminal (a web view) and the chat view (the chat half's) are stand-ins here.
jest.mock('../terminal/TerminalView', () => ({
  TerminalView: (props: {
    sessionId: string
    live: boolean
    onHandle?: (handle: unknown) => void
  }) => {
    const { Text: T } = jest.requireActual('react-native')
    const { useEffect } = jest.requireActual('react')
    mockTerminal.props = props
    useEffect(() => {
      mockTerminal.mounts++
    }, [])
    const { onHandle } = props
    useEffect(() => {
      onHandle?.({
        grid: () => mockTerminal.grid,
        exportText: (kind: string, how: string) => mockTerminal.calls.push(`${how} ${kind}`),
        textSize: () => mockTerminal.textSize,
        toggleTextSize: () => mockTerminal.calls.push('toggle text size')
      })
      return () => onHandle?.(null)
    }, [onHandle])
    return (
      <T testID="terminal">{`terminal ${props.sessionId} ${props.live ? 'live' : 'not running'}`}</T>
    )
  }
}))

beforeEach(() => {
  mockTerminal.calls = []
  mockTerminal.grid = undefined
  mockTerminal.textSize = 'readable'
  mockTerminal.props = null
})
jest.mock('../chat', () => ({
  ChatSession: (props: {
    hubId: string
    taskId: string
    tabId: string
    mode: string
    controls?: string
    onChrome?: (chrome: unknown) => void
  }) => {
    const { Text: T } = jest.requireActual('react-native')
    const { useEffect: effect } = jest.requireActual('react')
    // A chat that waits for the user's answer, its controls handed to the page.
    effect(() => {
      props.onChrome?.({ mode: props.mode, settings: {}, models: {}, waiting: true })
    }, [props.onChrome, props.mode])
    return (
      <>
        <T testID="chat">{`chat ${props.hubId} ${props.taskId} ${props.tabId} ${props.mode}`}</T>
        {props.controls ? <T>{`chat controls ${props.controls}`}</T> : null}
      </>
    )
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
    computer_id: 'mac',
    ...fields
  } as unknown as BoardTask
}

function feedOf(
  task: BoardTask,
  byId: Record<string, TerminalState>,
  jobs: Record<string, number> = {},
  agents: { loaded: boolean; error: string | null } = { loaded: true, error: null }
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
    agents: { state: { ...EMPTY_TERMINAL_STATE, byId, jobsById: jobs }, ...agents }
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
function backend(
  tabs: unknown[] = [tab('t', 'claude-code', true)],
  opts: { start?: () => void } = {}
) {
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
      'task.startMainAgent': record('task.startMainAgent', () => {
        opts.start?.()
        return started
      }),
      'task.resetConversation': record('task.resetConversation'),
      'pty.kill': record('pty.kill', () => true),
      'pty.write': record('pty.write', () => true),
      'pty.interrupt': record('pty.interrupt', () => true),
      'chat.kill': record('chat.kill'),
      'computers.list': () => [{ id: 'mac', name: 'Mac Studio' }],
      'pty.agentsList': () => [
        { id: 'claude-code', label: 'Claude Code', enabled: true, order: 0 },
        { id: 'codex', label: 'Codex', enabled: true, order: 1 },
        { id: 'gemini', label: 'Gemini', enabled: false, order: 2 }
      ]
    },
    subscriptions: {
      'taskTerminals.onChanged': () => undefined,
      'computers.onStatusChange': () => undefined
    }
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
  extra: { openingKey?: string } = {}
) {
  return render(
    <AgentPanel
      hubId={hub.id}
      feed={feed}
      row={findTaskRow(feed, 't')!}
      showHub={false}
      openingKey={extra.openingKey}
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
      <AgentPanel hubId={hub.id} feed={next} row={findTaskRow(next, 't')!} showHub={false} />
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
      showHub: false
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

  it('waits for the agents to load before saying an agent is not started (no Start for a running one)', async () => {
    const b = backend()
    await renderScreen(feedOf(taskOf(), {}, {}, { loaded: false, error: null }), b)
    expect(screen.getByText('Loading…')).toBeOnTheScreen()
    expect(screen.queryByText('Not started')).toBeNull()
    expect(screen.queryByText('Start')).toBeNull()
    expect(mockTerminal.props?.stateLoading).toBe(true)
  })

  it('says when the agents could not be loaded, and retries', async () => {
    const b = backend()
    const refetch = jest.spyOn(b.queryClient, 'refetchQueries')
    await renderScreen(feedOf(taskOf(), {}, {}, { loaded: false, error: 'socket closed' }), b)
    expect(screen.getByText('Couldn’t load the agent’s state.')).toBeOnTheScreen()
    expect(screen.queryByText('Start')).toBeNull()
    await userEvent.setup().press(screen.getByLabelText('Retry loading the agent’s state'))
    expect(refetch).toHaveBeenCalledWith({ queryKey: ['agents', 'snapshot'] })
  })

  it('a failed action says what failed in plain words, and retries it', async () => {
    let fail = true
    const b = backend(undefined, {
      start: () => {
        if (fail) throw new Error('spawn EACCES')
      }
    })
    await renderScreen(feedOf(taskOf(), { 't:t': 'dead' }), b)
    const user = userEvent.setup()
    await user.press(screen.getByText('Start'))
    expect(await screen.findByText('Couldn’t start the agent.')).toBeOnTheScreen()
    expect(screen.getByText('spawn EACCES')).toBeOnTheScreen()
    fail = false
    await user.press(screen.getByLabelText('Retry: Start'))
    await waitFor(() =>
      expect(b.paths().filter((p) => p === 'task.startMainAgent')).toHaveLength(2)
    )
    await waitFor(() => expect(screen.queryByText('Couldn’t start the agent.')).toBeNull())
  })

  it('starts a terminal agent at the size the phone shows it at', async () => {
    const b = backend()
    mockTerminal.grid = { cols: 64, rows: 40 }
    await renderScreen(feedOf(taskOf(), { 't:t': 'dead' }), b)
    await userEvent.setup().press(screen.getByText('Start'))
    await waitFor(() =>
      expect(b.calls).toEqual([['task.startMainAgent', { taskId: 't', cols: 64, rows: 40 }]])
    )
  })

  it('tells the terminal how to start a stopped agent, and which computer it runs on', async () => {
    const b = backend()
    await renderScreen(feedOf(taskOf(), { 't:t': 'dead' }), b)
    expect(mockTerminal.props?.notRunningHint).toBe('Tap Start to run it.')
    await waitFor(() => expect(mockTerminal.props?.computerName).toBe('Mac Studio'))
  })

  it('offers Stop and Interrupt up front only while the agent works; idle, they are under ⋯', async () => {
    const b = backend()
    const alert = confirmAll()
    await renderScreen(feedOf(taskOf(), { 't:t': 'idle' }), b)
    expect(screen.queryByText('Stop')).toBeNull()
    expect(screen.queryByText('Interrupt')).toBeNull()
    await more('Stop')
    expect(alert).toHaveBeenCalled()
    await waitFor(() => expect(b.calls).toEqual([['pty.kill', { sessionId: 't:t' }]]))
  })

  it('copies or shares the terminal’s text and switches its text size from ⋯', async () => {
    const b = backend()
    await renderScreen(feedOf(taskOf(), { 't:t': 'running' }), b)
    await more('Copy screen text')
    await more('Copy all output')
    await more('Share all output…')
    await more('Fit text to width')
    expect(mockTerminal.calls).toEqual(['copy screen', 'copy all', 'share all', 'toggle text size'])
  })

  it('says the provider’s name to VoiceOver as the button’s value', async () => {
    const b = backend()
    await renderScreen(feedOf(taskOf(), { 't:t': 'running' }), b)
    const provider = await screen.findByLabelText('Change provider')
    await waitFor(() => expect(provider.props.accessibilityValue).toEqual({ text: 'Claude Code' }))
  })

  it('marks the task read once per opening: a remount of the same opening keeps “Mark as unread”', async () => {
    const b = backend()
    const unread = feedOf(taskOf({ needs_attention: true }), { 't:t': 'idle' })
    const first = await renderScreen(unread, b, { openingKey: 'opening-1' })
    await waitFor(() => expect(b.paths().filter((p) => p === 'task.update')).toHaveLength(1))
    await first.unmount()
    // The user marked it unread, switched away and back (the panel remounted).
    await renderScreen(unread, b, { openingKey: 'opening-1' })
    await act(async () => undefined)
    expect(b.paths().filter((p) => p === 'task.update')).toHaveLength(1)
    // Opened again later: a new opening marks it read.
    await renderScreen(unread, b, { openingKey: 'opening-2' })
    await waitFor(() => expect(b.paths().filter((p) => p === 'task.update')).toHaveLength(2))
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

  it("shows the main agent only: no strip of the task's other agent tabs", async () => {
    const b = backend([tab('side', 'terminal', false, 0), tab('t', 'claude-code', true, 1)])
    await renderScreen(feedOf(taskOf(), { 't:t': 'running', 't:side': 'idle' }), b)
    expect(await screen.findByText('terminal t:t live')).toBeOnTheScreen()
    await waitFor(() => expect(screen.getByText('Claude Code ▾')).toBeOnTheScreen())
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByText('Terminal')).toBeNull()
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

/** The phone task page, as a stand-in: what the panel hands it, the body under it. */
function PageStub({ agent, body }: { agent: AgentNav; body: ReactNode }) {
  return (
    <>
      <Text testID="page-agent">{`${agent.provider} · ${agent.stateLabel} · ${agent.status}${agent.busy ? ' · busy' : ''}${agent.waiting ? ' · waiting' : ''}${agent.controls ? ' · controls' : ''}`}</Text>
      {agent.start ? (
        <Pressable accessibilityRole="button" onPress={agent.start}>
          <Text>page start</Text>
        </Pressable>
      ) : null}
      {agent.stop ? (
        <Pressable accessibilityRole="button" onPress={agent.stop}>
          <Text>page stop</Text>
        </Pressable>
      ) : null}
      <View testID="page-actions">
        {agent.actions.map((a) => (
          <Pressable key={a.name} accessibilityRole="button" onPress={a.onPress}>
            <Text>{`${a.label} (${a.kind}${a.destructive ? ', destructive' : ''})`}</Text>
          </Pressable>
        ))}
      </View>
      <View testID="page-providers">
        {agent.providers.map((p) => (
          <Pressable
            key={p.id}
            accessibilityRole="button"
            onPress={() => agent.switchProvider(p.id)}
          >
            <Text>{p.id === agent.providerId ? `${p.label} ✓` : p.label}</Text>
          </Pressable>
        ))}
      </View>
      {body}
    </>
  )
}

function renderPage(feed: HubFeed, b: ReturnType<typeof backend>) {
  return render(
    <AgentPanel
      hubId={hub.id}
      feed={feed}
      row={findTaskRow(feed, 't')!}
      showHub={false}
      phone={(agent, body) => <PageStub agent={agent} body={body} />}
    />,
    { wrapper: b.wrapper }
  )
}

/** Presses the action labelled `label` (as the stand-in writes it). */
async function action(label: string) {
  await userEvent.setup().press(within(screen.getByTestId('page-actions')).getByText(label))
}

describe('AgentPanel on the phone task page (the page draws the agent)', () => {
  it('hands the page its provider and state, and its body; no bar or ⋯ of its own', async () => {
    const b = backend([tab('t', 'claude-code', true), tab('side', 'terminal', false, 1)])
    await renderPage(feedOf(taskOf(), { 't:t': 'running', 't:side': 'idle' }, { 't:t': 2 }), b)
    await waitFor(() =>
      expect(screen.getByTestId('page-agent')).toHaveTextContent(
        'Claude Code · Active · Active · 2 background jobs'
      )
    )
    expect(screen.queryByLabelText('More agent actions')).toBeNull()
    expect(screen.queryByLabelText('Change provider')).toBeNull()
    expect(screen.queryByTestId('agent-menu')).toBeNull()
    expect(await screen.findByText('terminal t:t live')).toBeOnTheScreen()
  })

  it('hands over every action, the terminal’s apart; Stop asks first', async () => {
    const b = backend()
    const alert = confirmAll()
    await renderPage(feedOf(taskOf(), { 't:t': 'running' }), b)
    const actions = within(screen.getByTestId('page-actions'))
    for (const label of [
      'Interrupt (lifecycle)',
      'Stop agent (lifecycle, destructive)',
      'Restart (lifecycle)',
      'New conversation (lifecycle)',
      'Copy screen text (terminal)',
      'Copy all output (terminal)',
      'Share all output… (terminal)',
      'Fit text to width (terminal)'
    ])
      expect(actions.getByText(label)).toBeOnTheScreen()
    await action('Stop agent (lifecycle, destructive)')
    expect(alert).toHaveBeenCalled()
    await waitFor(() => expect(b.calls).toEqual([['pty.kill', { sessionId: 't:t' }]]))
  })

  it('New conversation resets (after asking); Restart restarts', async () => {
    const b = backend()
    confirmAll()
    await renderPage(feedOf(taskOf(), { 't:t': 'running' }), b)
    await action('New conversation (lifecycle)')
    await waitFor(() =>
      expect(b.paths()).toEqual(['pty.kill', 'task.resetConversation', 'task.startMainAgent'])
    )
    await action('Restart (lifecycle)')
    await waitFor(() => expect(b.paths().slice(3)).toEqual(['pty.kill', 'task.startMainAgent']))
  })

  it("the terminal's copy, share and text size work from the page", async () => {
    const b = backend()
    await renderPage(feedOf(taskOf(), { 't:t': 'running' }), b)
    await action('Copy screen text (terminal)')
    await action('Copy all output (terminal)')
    await action('Share all output… (terminal)')
    await action('Fit text to width (terminal)')
    expect(mockTerminal.calls).toEqual(['copy screen', 'copy all', 'share all', 'toggle text size'])
  })

  it('Start is up front while offered', async () => {
    const b = backend()
    await renderPage(feedOf(taskOf(), { 't:t': 'dead' }), b)
    expect(screen.queryByText('page stop')).toBeNull()
    await userEvent.setup().press(await screen.findByText('page start'))
    await waitFor(() => expect(b.calls).toEqual([['task.startMainAgent', { taskId: 't' }]]))
  })

  it('Stop is up front while the agent works (asking first); no Start then', async () => {
    const b = backend()
    confirmAll()
    await renderPage(feedOf(taskOf(), { 't:t': 'running' }), b)
    await screen.findByText('terminal t:t live')
    expect(screen.queryByText('page start')).toBeNull()
    await userEvent.setup().press(screen.getByText('page stop'))
    await waitFor(() => expect(b.calls).toEqual([['pty.kill', { sessionId: 't:t' }]]))
  })

  it('idle, Stop is not up front (it is among the actions)', async () => {
    const b = backend()
    await renderPage(feedOf(taskOf(), { 't:t': 'idle' }), b)
    await screen.findByText('terminal t:t live')
    expect(screen.queryByText('page stop')).toBeNull()
    expect(screen.getByText('Stop agent (lifecycle, destructive)')).toBeOnTheScreen()
  })

  it('switches the provider among the enabled ones (after asking)', async () => {
    const b = backend()
    confirmAll()
    await renderPage(feedOf(taskOf(), { 't:t': 'running' }), b)
    const providers = within(screen.getByTestId('page-providers'))
    await waitFor(() => expect(providers.getByText('Codex')).toBeOnTheScreen())
    expect(providers.getByText('Claude Code ✓')).toBeOnTheScreen()
    expect(providers.queryByText('Gemini')).toBeNull()
    await userEvent.setup().press(providers.getByText('Codex'))
    await waitFor(() =>
      expect(b.calls).toEqual([
        ['task.switchMode', { taskId: 't', mode: 'codex' }],
        ['task.startMainAgent', { taskId: 't' }]
      ])
    )
  })

  it("a chat's controls go to the page, and whether it waits for the user", async () => {
    const b = backend([tab('t', 'claude-chat', true)])
    await renderPage(feedOf(taskOf({ agent_id: 'claude-chat' }), { 't:t': 'idle' }), b)
    expect(await screen.findByText('chat controls page')).toBeOnTheScreen()
    await waitFor(() =>
      expect(screen.getByTestId('page-agent')).toHaveTextContent(/· waiting · controls$/)
    )
  })

  it('a terminal has no chat controls and never waits', async () => {
    const b = backend()
    await renderPage(feedOf(taskOf(), { 't:t': 'idle' }), b)
    await screen.findByText('terminal t:t live')
    expect(screen.getByTestId('page-agent')).not.toHaveTextContent(/waiting|controls/)
  })

  it('in the panel (iPad) the chat keeps its chips', async () => {
    const b = backend([tab('t', 'claude-chat', true)])
    await renderScreen(feedOf(taskOf({ agent_id: 'claude-chat' }), { 't:t': 'idle' }), b)
    await screen.findByTestId('chat')
    expect(screen.queryByText(/chat controls/)).toBeNull()
  })
})
