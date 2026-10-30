/**
 * `ChatSession` behaviours beyond the recorded session (`ChatSession.fixture.test.tsx`):
 * which folder it hydrates in, the `/` menu, a send that fails and its retry, an answer
 * the hub no longer takes, and the mode picker.
 */
import type { AgentEvent, ChatAttachment } from '@slayzone/terminal-contracts'
import { act, fireEvent, render, screen, userEvent, waitFor } from '@testing-library/react-native'
import { trpcTest } from '../testing'
import { ChatSession } from './ChatSession'
import { type FakeHub, fakeHub } from './fake-hub'

const TAB = 'task-1'
const TASK = 'task-1'

async function open(hub: FakeHub, mode = 'claude-chat') {
  const { wrapper } = trpcTest(hub.backend)
  await render(<ChatSession hubId="hub-1" taskId={TASK} tabId={TAB} mode={mode} />, { wrapper })
}

/** Push saved events the way the hub does (seq after seq). */
async function hubSends(hub: FakeHub, events: AgentEvent[], from = 0) {
  await act(async () => {
    events.forEach((event, i) => hub.emit('chat.onEvent', { tabId: TAB, event, seq: from + i }))
  })
}

describe('ChatSession: the folder it runs in', () => {
  it("binds a repo-bound task to the child repo desktop would pick, scanned on the task's computer", async () => {
    const hub = fakeHub({
      tabId: TAB,
      taskId: TASK,
      task: { id: TASK, project_id: 'p1', worktree_path: null, base_dir: null, repo_name: 'api' },
      projects: [
        {
          id: 'p1',
          selected_repo: null,
          placements: [{ computer_id: 'c1', path: '/proj', status: 'ready' }],
          resolved_computer_id: 'c1'
        }
      ]
    })
    hub.on('worktrees.detectChildRepos', () => [
      { name: 'web', path: '/proj/web' },
      { name: 'api', path: '/proj/api' }
    ])
    await open(hub)
    await waitFor(() => expect(hub.callsTo('chat.hydrate')).toHaveLength(1))
    expect(hub.callsTo('worktrees.detectChildRepos')).toEqual([
      { projectPath: '/proj', taskId: TASK }
    ])
    expect(hub.callsTo('chat.hydrate')[0].cwd).toBe('/proj/api')
  })

  it('never hydrates without a folder', async () => {
    const hub = fakeHub({
      tabId: TAB,
      taskId: TASK,
      projects: [{ id: 'p1', selected_repo: null, placements: [], resolved_computer_id: 'c1' }]
    })
    await open(hub)
    await screen.findByText(/no folder to run in/)
    expect(hub.callsTo('chat.hydrate')).toEqual([])
  })

  it("says a chosen folder that is gone is not found (desktop's words), and never hydrates", async () => {
    const hub = fakeHub({
      tabId: TAB,
      taskId: TASK,
      projects: [
        {
          id: 'p1',
          selected_repo: null,
          placements: [{ computer_id: 'c1', path: '/gone/proj', status: 'missing' }],
          resolved_computer_id: 'c1'
        }
      ]
    })
    await open(hub)
    expect(await screen.findByText('Folder not found on this task’s machine')).toBeOnTheScreen()
    expect(screen.getByText('/gone/proj')).toBeOnTheScreen()
    expect(screen.queryByText(/no folder to run in/)).toBeNull()
    expect(hub.callsTo('chat.hydrate')).toEqual([])
  })
})

describe('ChatSession: sending', () => {
  it('keeps a message the hub did not take on screen, and retries it under the same id', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    let fail = true
    hub.on('chat.send', (input) => {
      if (fail) throw new Error('WebSocket closed')
      return { id: input.message.id, state: 'queued' }
    })
    await open(hub)
    await screen.findByText('Send a message to start.')
    await fireEvent.changeText(screen.getByTestId('chat-input'), 'hello')
    const user = userEvent.setup()
    await user.press(screen.getByLabelText('Send'))
    await screen.findByText(/Not sent/)
    expect(screen.getByText('hello')).toBeOnTheScreen()
    fail = false
    await user.press(screen.getByText('Retry'))
    await waitFor(() => expect(hub.callsTo('chat.send')).toHaveLength(2))
    const [first, second] = hub.callsTo('chat.send')
    expect(second.message.id).toBe(first.message.id)
    await waitFor(() => expect(screen.queryByText(/Not sent/)).toBeNull())
  })

  it('offers the /-menu from desktop sources and runs the CLI command it completes', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.getCliSnapshot', () => ({
      slashCommands: ['compact', 'context'],
      skills: [],
      terminalSlashCommands: []
    }))
    hub.on('chat.listSkills', () => [
      { name: 'review-pr', description: 'Review a PR', source: 'project' }
    ])
    await open(hub)
    await screen.findByText('Send a message to start.')
    await fireEvent.changeText(screen.getByTestId('chat-input'), '/')
    await screen.findByTestId('slash-menu')
    expect(screen.getByLabelText('/compact')).toBeOnTheScreen()
    expect(screen.getByLabelText('/clear')).toBeOnTheScreen()
    await fireEvent.changeText(screen.getByTestId('chat-input'), '/rev')
    expect(await screen.findByLabelText('/review-pr')).toBeOnTheScreen()
    await fireEvent.changeText(screen.getByTestId('chat-input'), '/comp')
    const user = userEvent.setup()
    await user.press(screen.getByLabelText('Send'))
    await waitFor(() => expect(hub.callsTo('chat.send')).toHaveLength(1))
    expect(hub.callsTo('chat.send')[0].message.content).toEqual([
      { type: 'text', text: '/compact' }
    ])
    expect(hub.callsTo('chat.bumpAutocompleteUsage')).toEqual([
      { source: 'cli-commands', name: 'compact' }
    ])
  })

  it('/clear resets the chat on the hub and clears it here at once', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await open(hub)
    await screen.findByText('Send a message to start.')
    await hubSends(hub, [{ kind: 'user-message', id: 'u1', text: 'old message' }])
    await screen.findByText('old message')
    await fireEvent.changeText(screen.getByTestId('chat-input'), '/clear')
    const user = userEvent.setup()
    await user.press(screen.getByLabelText('/clear'))
    await waitFor(() => expect(hub.callsTo('chat.reset')).toHaveLength(1))
    expect(hub.callsTo('chat.reset')[0]).toMatchObject({ tabId: TAB, taskId: TASK, cwd: '/w' })
    expect(screen.queryByText('old message')).toBeNull()
  })
})

describe('ChatSession: answering', () => {
  const request: AgentEvent = {
    kind: 'permission-request',
    requestId: 'r1',
    toolUseId: 't1',
    toolName: 'Bash',
    input: { command: 'rm -rf build' }
  } as AgentEvent

  it("says so when the hub no longer waits for the answer, and doesn't send twice", async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    let release: (ok: boolean) => void = () => undefined
    hub.on('chat.respondPermission', () => new Promise<boolean>((r) => (release = r)))
    await open(hub)
    await screen.findByText('Send a message to start.')
    await hubSends(hub, [{ kind: 'user-message', id: 'u1', text: 'go' }, request])
    await screen.findByTestId('prompt-dock')
    expect(screen.getByText('$ rm -rf build')).toBeOnTheScreen()
    const user = userEvent.setup()
    await user.press(screen.getByText('Yes'))
    await user.press(screen.getByText('Yes'))
    expect(hub.callsTo('chat.respondPermission')).toHaveLength(1)
    expect(hub.callsTo('chat.respondPermission')[0]).toEqual({
      tabId: TAB,
      args: { requestId: 'r1', optionId: 'yes', decision: { behavior: 'allow' } }
    })
    await act(async () => release(false))
    await screen.findByText(/no longer active/)
    await waitFor(() => expect(screen.queryByTestId('prompt-dock')).toBeNull())
  })

  it('rejects with typed feedback (the turn goes on)', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await open(hub)
    await screen.findByText('Send a message to start.')
    await hubSends(hub, [{ kind: 'user-message', id: 'u1', text: 'go' }, request])
    await screen.findByTestId('prompt-dock')
    const user = userEvent.setup()
    await user.press(screen.getByText('No, and tell Claude what to do differently'))
    await fireEvent.changeText(
      screen.getByLabelText('No, and tell Claude what to do differently'),
      'use trash'
    )
    await user.press(screen.getByText('Send'))
    const args = hub.callsTo('chat.respondPermission')[0].args
    expect(args.decision.behavior).toBe('deny')
    expect(args.decision.message).toMatch(/use trash$/)
    expect(args.decision.interrupt).toBeUndefined()
  })
})

describe('ChatSession: controls', () => {
  it("switches the permission mode through the hub, showing the hub's answer", async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await open(hub)
    const user = userEvent.setup()
    await user.press(await screen.findByLabelText('Permission mode: Auto-accept edits'))
    await user.press(screen.getByText('Plan mode'))
    await waitFor(() =>
      expect(hub.callsTo('chat.setMode')).toEqual([
        {
          tabId: TAB,
          taskId: TASK,
          mode: 'claude-chat',
          cwd: '/w',
          providerFlagsOverride: null,
          chatMode: 'plan'
        }
      ])
    )
    await screen.findByLabelText('Permission mode: Plan mode')
  })

  /** What Codex's CLI listed for the account (`chat.getModels`): not a list of the app's. */
  const CODEX_LISTED = [
    {
      id: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      supportsEffort: true,
      isDefault: true,
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'medium', label: 'Medium' },
        { id: 'ultra', label: 'Ultra' }
      ],
      defaultEffort: 'medium'
    },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', supportsEffort: false }
  ]

  it("Codex: offers the models its CLI listed (the hub's), each with its own effort levels", async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.getModels', () => CODEX_LISTED)
    hub.on('chat.getModel', () => 'gpt-6-luna')
    hub.on('chat.getEffort', () => 'ultra')
    await open(hub, 'codex-chat')
    const user = userEvent.setup()
    await user.press(await screen.findByLabelText('Model: GPT-6 Luna'))
    expect(screen.getByText('GPT-6.1 Sol')).toBeOnTheScreen()
    expect(screen.queryByText('GPT-5.5')).toBeNull()
    expect(hub.callsTo('chat.getModels')).toContainEqual({ taskId: TASK, mode: 'codex-chat' })
    await user.press(screen.getByLabelText('Close'))

    await user.press(await screen.findByLabelText('Effort: Ultra'))
    expect(screen.getAllByRole('radio').map((r) => r.props.accessibilityState.checked)).toEqual([
      false,
      false,
      true
    ])
    expect(screen.getByText('Low')).toBeOnTheScreen()
    expect(screen.queryByText('Max')).toBeNull()
    await user.press(screen.getByLabelText('Close'))

    // A model that lists no efforts: no effort chip.
    await user.press(screen.getByLabelText('Model: GPT-6 Luna'))
    await user.press(screen.getByText('GPT-6.1 Sol'))
    await screen.findByLabelText('Model: GPT-6.1 Sol')
    expect(screen.queryByLabelText(/^Effort:/)).toBeNull()
  })

  it('Codex before its first run: no list to offer, the CLI default applies, no effort chip', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.getModel', () => '')
    await open(hub, 'codex-chat')
    const user = userEvent.setup()
    await user.press(await screen.findByLabelText('Model: Default'))
    expect(screen.getByText('Codex lists its models once it has started.')).toBeOnTheScreen()
    expect(screen.queryAllByRole('radio')).toEqual([])
    expect(screen.queryByLabelText(/^Effort:/)).toBeNull()
  })
})

describe('ChatSession: what changed the conversation', () => {
  const done = {
    kind: 'result',
    subtype: 'success',
    isError: false,
    durationMs: 1000,
    durationApiMs: 900,
    numTurns: 1,
    totalCostUsd: 0,
    stopReason: null,
    terminalReason: null,
    text: null,
    modelUsage: {},
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    },
    permissionDenials: []
  } as AgentEvent

  it('folds what a rewind left behind under its divider, shown again on demand', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await open(hub)
    await screen.findByText('Send a message to start.')
    await hubSends(hub, [
      { kind: 'user-message', id: 'u1', text: 'first' },
      { kind: 'assistant-text', messageId: 'm1', text: 'answer one' },
      done,
      { kind: 'user-message', id: 'u2', text: 'second' },
      { kind: 'assistant-text', messageId: 'm2', text: 'answer two' },
      done,
      { kind: 'conversation-branch', reason: 'rewound', messageId: 'u2' } as AgentEvent
    ])
    await screen.findByText('Rewound: Claude forgot what came after this point')
    expect(screen.getByText('first')).toBeOnTheScreen()
    expect(screen.queryByText('second')).toBeNull()
    const user = userEvent.setup()
    await user.press(screen.getByLabelText('Show rewound (3)'))
    expect(await screen.findByText('second')).toBeOnTheScreen()
    await user.press(screen.getByLabelText('Hide rewound'))
    await waitFor(() => expect(screen.queryByText('second')).toBeNull())
  })

  it('says when a turn was interrupted, and when Claude Code did not run a message again', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await open(hub)
    await screen.findByText('Send a message to start.')
    await hubSends(hub, [
      { kind: 'user-message', id: 'u1', text: 'one' },
      { kind: 'interrupted' } as AgentEvent,
      { kind: 'user-message', id: 'u2', text: 'two' },
      { kind: 'interrupted', reason: 'already-in-conversation' } as AgentEvent
    ])
    expect(await screen.findByText('Turn interrupted')).toBeOnTheScreen()
    expect(
      screen.getByText('Not run again: Claude Code already had this message')
    ).toBeOnTheScreen()
  })

  it('Stop generation clears the queue, stops the turn and gives an unanswered message back', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.abortAndPop', () => ({
      popped: true,
      text: 'fix the bug',
      id: 'x',
      content: [{ type: 'text', text: 'fix the bug' }]
    }))
    await open(hub)
    await screen.findByText('Send a message to start.')
    await fireEvent.changeText(screen.getByTestId('chat-input'), 'fix the bug')
    const user = userEvent.setup()
    await user.press(screen.getByLabelText('Send'))
    await waitFor(() => expect(screen.getByTestId('chat-input').props.value).toBe(''))
    await user.press(await screen.findByLabelText('Stop generation'))
    await waitFor(() => expect(hub.callsTo('chat.abortAndPop')).toHaveLength(1))
    expect(hub.callsTo('chat.queue.clear')).toEqual([{ tabId: TAB }])
    expect(hub.callsTo('chat.abortAndPop')[0]).toEqual({
      tabId: TAB,
      taskId: TASK,
      mode: 'claude-chat',
      cwd: '/w',
      providerFlagsOverride: null
    })
    await waitFor(() => expect(screen.getByTestId('chat-input').props.value).toBe('fix the bug'))
  })

  it("explains an agent that could not start in desktop's words, and retries it", async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await open(hub)
    await screen.findByText('Send a message to start.')
    await hubSends(hub, [
      {
        kind: 'error',
        message: 'spawn claude ENOENT',
        detail: { code: 'cli-not-installed', binary: 'claude' }
      } as AgentEvent
    ])
    expect(await screen.findByText("Claude Code isn't installed")).toBeOnTheScreen()
    expect(screen.getByText(/must be on that computer's PATH/)).toBeOnTheScreen()
    expect(screen.queryByText('Continue here')).toBeNull()
    const user = userEvent.setup()
    await user.press(screen.getByLabelText('Retry starting the agent'))
    await waitFor(() => expect(hub.callsTo('chat.start')).toHaveLength(1))
    expect(hub.callsTo('chat.start')[0]).toMatchObject({ tabId: TAB, cwd: '/w', reason: 'user' })
  })
})

describe('ChatSession: files attached on desktop', () => {
  const shot: ChatAttachment = {
    artifactId: 'a1',
    contentHash: 'h1',
    name: 'screenshot.png',
    kind: 'image',
    mediaType: 'image/png',
    size: 2048
  }
  const spec: ChatAttachment = {
    artifactId: 'a2',
    name: 'spec.pdf',
    kind: 'pdf',
    mediaType: 'application/pdf',
    size: 3 * 1024 * 1024
  }
  const withFiles = [
    { type: 'attachment' as const, attachment: shot },
    { type: 'text' as const, text: 'what is wrong here?' }
  ]

  it("shows a message's files in its bubble by name and size", async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await open(hub)
    await screen.findByText('Send a message to start.')
    await hubSends(hub, [
      { kind: 'user-message', id: 'u1', text: 'what is wrong here?', content: withFiles },
      {
        kind: 'user-message',
        id: 'u2',
        text: '',
        content: [{ type: 'attachment', attachment: spec }]
      }
    ])
    expect(await screen.findByText('what is wrong here?')).toBeOnTheScreen()
    expect(screen.getByLabelText('Attached image screenshot.png, 2 KB')).toBeOnTheScreen()
    expect(screen.getByLabelText('Attached PDF spec.pdf, 3.0 MB')).toBeOnTheScreen()
  })

  it('retries a failed message with its files', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await open(hub)
    await screen.findByText('Send a message to start.')
    await hubSends(hub, [
      { kind: 'user-message', id: 'u1', text: 'what is wrong here?', content: withFiles },
      { kind: 'user-message-delivery', id: 'u1', state: 'failed', error: 'CLI gone' }
    ])
    await userEvent.setup().press(await screen.findByText('Retry'))
    await waitFor(() => expect(hub.callsTo('chat.send')).toHaveLength(1))
    expect(hub.callsTo('chat.send')[0].message).toEqual({ id: 'u1', content: withFiles })
  })

  it('Stop gives a message back with its files; Send carries them again, ✕ drops one', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.abortAndPop', () => ({
      popped: true,
      text: 'what is wrong here?',
      id: 'u1',
      content: [{ type: 'attachment', attachment: spec }, ...withFiles]
    }))
    await open(hub)
    await screen.findByText('Send a message to start.')
    // Desktop's message, running: Stop takes it back.
    await hubSends(hub, [
      { kind: 'user-message', id: 'u1', text: 'what is wrong here?', content: withFiles },
      { kind: 'user-message-delivery', id: 'u1', state: 'delivered' }
    ])
    const user = userEvent.setup()
    await user.press(await screen.findByLabelText('Stop generation'))
    await waitFor(() =>
      expect(screen.getByTestId('chat-input').props.value).toBe('what is wrong here?')
    )
    expect(screen.getByLabelText('Remove spec.pdf')).toBeOnTheScreen()
    expect(screen.getByLabelText('Remove screenshot.png')).toBeOnTheScreen()
    await user.press(screen.getByLabelText('Remove spec.pdf'))
    expect(screen.queryByLabelText('Remove spec.pdf')).toBeNull()
    await hubSends(hub, [{ kind: 'user-message-popped', id: 'u1', text: 'what is wrong here?' }], 2)
    await user.press(screen.getByLabelText('Send'))
    await waitFor(() => expect(hub.callsTo('chat.send')).toHaveLength(1))
    expect(hub.callsTo('chat.send')[0].message.content).toEqual(withFiles)
    await waitFor(() => expect(screen.queryByLabelText('Remove screenshot.png')).toBeNull())
  })

  it('a file alone can be sent', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.abortAndPop', () => ({
      popped: true,
      text: '',
      id: 'u1',
      content: [{ type: 'attachment', attachment: spec }]
    }))
    await open(hub)
    await screen.findByText('Send a message to start.')
    await hubSends(hub, [
      {
        kind: 'user-message',
        id: 'u1',
        text: '',
        content: [{ type: 'attachment', attachment: spec }]
      },
      { kind: 'user-message-delivery', id: 'u1', state: 'delivered' }
    ])
    const user = userEvent.setup()
    await user.press(await screen.findByLabelText('Stop generation'))
    await screen.findByLabelText('Remove spec.pdf')
    await hubSends(hub, [{ kind: 'user-message-popped', id: 'u1', text: '' }], 2)
    await user.press(screen.getByLabelText('Send'))
    await waitFor(() => expect(hub.callsTo('chat.send')).toHaveLength(1))
    expect(hub.callsTo('chat.send')[0].message.content).toEqual([
      { type: 'attachment', attachment: spec }
    ])
  })

  it('names the files of a queued message', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.queue.list', () => [
      {
        id: 'q1',
        tabId: TAB,
        send: '',
        original: '',
        position: 0,
        createdAt: '2026-10-30 10:00:00',
        content: [{ type: 'attachment', attachment: spec }]
      }
    ])
    await open(hub)
    const queue = await screen.findByTestId('chat-queue')
    expect(queue).toHaveTextContent(/spec\.pdf/)
    expect(screen.getByLabelText('Remove queued message: spec.pdf')).toBeOnTheScreen()
  })
})

describe("ChatSession: the CLI's own command words", () => {
  it("shows a CLI command's description and argument hint, from the project's stored ones", async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.getCliSnapshot', () => ({
      slashCommands: ['pr-comments'],
      skills: [],
      terminalSlashCommands: []
    }))
    hub.on('chat.getCliCommandDetails', () => ({
      'pr-comments': {
        description: 'Get comments from a GitHub pull request',
        argumentHint: '<pr-number>'
      }
    }))
    await open(hub)
    await screen.findByText('Send a message to start.')
    await fireEvent.changeText(screen.getByTestId('chat-input'), '/pr')
    expect(await screen.findByText('Get comments from a GitHub pull request')).toBeOnTheScreen()
    expect(screen.getByText(/<pr-number>/)).toBeOnTheScreen()
    expect(hub.callsTo('chat.getCliCommandDetails')).toEqual([
      { taskId: TASK, mode: 'claude-chat' }
    ])
  })

  it("takes the live session's words over the stored ones", async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.getCliSnapshot', () => ({
      slashCommands: ['compact'],
      skills: [],
      terminalSlashCommands: []
    }))
    hub.on('chat.getCliCommandDetails', () => ({
      compact: { description: 'stored words', argumentHint: '' }
    }))
    await open(hub)
    await screen.findByText('Send a message to start.')
    await hubSends(hub, [
      {
        kind: 'cli-command-details',
        commands: [
          {
            name: 'compact',
            description: 'Clear history but keep a summary',
            argumentHint: '<focus>'
          }
        ]
      }
    ])
    await fireEvent.changeText(screen.getByTestId('chat-input'), '/comp')
    expect(await screen.findByText('Clear history but keep a summary')).toBeOnTheScreen()
    expect(screen.queryByText('stored words')).toBeNull()
    // Picking it parks `/compact ` and says what it takes.
    await userEvent.setup().press(screen.getByLabelText('/compact'))
    expect(screen.getByTestId('chat-input').props.value).toBe('/compact ')
    expect(await screen.findByText(/\/compact <focus>/)).toBeOnTheScreen()
  })
})
