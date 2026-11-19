/**
 * `ChatSession` behaviours beyond the recorded session (`ChatSession.fixture.test.tsx`):
 * which folder it hydrates in, the `/` menu, a send that fails and its retry, an answer
 * the hub no longer takes, and the mode picker.
 */
import type { AgentEvent, ChatAttachment } from '@slayzone/terminal-contracts'
import {
  act,
  fireEvent,
  render,
  screen,
  userEvent,
  waitFor,
  within
} from '@testing-library/react-native'
import { Alert, DeviceEventEmitter, StyleSheet } from 'react-native'
import { type TaskChrome, TaskChromeProvider } from '../task/task-chrome'
import { trpcTest } from '../testing'
import { ChatControls } from './ChatControls'
import { type ChatChrome, ChatSession } from './ChatSession'
import { ChatUploadTargetContext } from './ChatUploadTarget'
import { type FakeHub, fakeHub } from './fake-hub'

// The phone's photo picker and file reads (native): a picked PNG, read from "disk".
const mockPicked = { files: [] as Array<{ uri: string; name: string }> }
jest.mock('../artifacts/pick-uploads', () => ({
  pickUploads: jest.fn(async () => mockPicked.files)
}))
const mockPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const mockUploads: Array<{ taskId: string; file: { name: string } }> = []
jest.mock('./attach-files', () => {
  const actual = jest.requireActual('./attach-files')
  return {
    ...actual,
    attachFile: (...args: unknown[]) =>
      actual.attachFile(...args.slice(0, 4), {
        read: () => ({ size: 2048, head: mockPng }),
        upload: async (_target: unknown, taskId: string, file: { name: string }) => {
          mockUploads.push({ taskId, file })
          return { id: 'art-1', title: file.name }
        }
      })
  }
})

const TAB = 'task-1'
const TASK = 'task-1'

async function open(hub: FakeHub, mode = 'claude-chat', controls?: 'chips') {
  const { wrapper } = trpcTest(hub.backend)
  await render(
    <ChatSession
      hubId="hub-1"
      taskId={TASK}
      tabId={TAB}
      mode={mode}
      {...(controls ? { controls } : {})}
    />,
    { wrapper }
  )
}

/** Push saved events the way the hub does (seq after seq). */
async function hubSends(hub: FakeHub, events: AgentEvent[], from = 0) {
  await act(async () => {
    events.forEach((event, i) => hub.emit('chat.onEvent', { tabId: TAB, event, seq: from + i }))
  })
}

describe('ChatSession: attaching a photo', () => {
  const target = { hubId: 'hub-1', label: 'hub', address: 'hub', token: 't' }

  async function openWithHub(hub: FakeHub, mode = 'claude-chat') {
    const { wrapper: Trpc } = trpcTest(hub.backend)
    await render(<ChatSession hubId="hub-1" taskId={TASK} tabId={TAB} mode={mode} />, {
      wrapper: ({ children }) => (
        <Trpc>
          <ChatUploadTargetContext.Provider value={target}>
            {children}
          </ChatUploadTargetContext.Provider>
        </Trpc>
      )
    })
  }

  it('＋ takes a photo from the library to the task, and the next message carries it', async () => {
    mockUploads.length = 0
    mockPicked.files = [{ uri: 'file:///tmp/IMG_1.png', name: 'IMG_1.png' }]
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await openWithHub(hub)
    await screen.findByText('Send a message to start.')
    const user = userEvent.setup()
    await user.press(screen.getByLabelText('Attach a photo'))
    await user.press(await screen.findByText('Photo library'))
    expect(await screen.findByLabelText('Remove IMG_1.png')).toBeOnTheScreen()
    expect(mockUploads).toEqual([{ taskId: TASK, file: mockPicked.files[0] }])
    await user.press(screen.getByLabelText('Send'))
    await waitFor(() => expect(hub.callsTo('chat.send')).toHaveLength(1))
    expect(hub.callsTo('chat.send')[0].message.content).toEqual([
      {
        type: 'attachment',
        attachment: {
          artifactId: 'art-1',
          name: 'IMG_1.png',
          kind: 'image',
          mediaType: 'image/png',
          size: 2048
        }
      }
    ])
  })

  it('without the hub to upload to, there is no ＋', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await open(hub)
    await screen.findByText('Send a message to start.')
    expect(screen.queryByLabelText('Attach a photo')).toBeNull()
  })
})

describe('ChatSession: the keyboard', () => {
  it('measures where it sits again once the keyboard has shown (the screen above it moved)', async () => {
    // Every host view's `measureInWindow` (the test renderer's native stand-in).
    const native = jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await open(hub)
    await screen.findByText('Send a message to start.')
    native.measureInWindow.mockClear()
    await act(async () => {
      DeviceEventEmitter.emit('keyboardDidShow', { endCoordinates: { height: 300, screenY: 500 } })
    })
    expect(native.measureInWindow).toHaveBeenCalled()
  })

  it('lifts the composer by what the keyboard covers of the chat, wherever the chat sits', async () => {
    const native = jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default
    // The chat spans y 100…700 of the window; the screen above it can move it.
    let frame = { y: 100, height: 600 }
    native.measureInWindow.mockImplementation((cb: (...n: number[]) => void) =>
      cb(0, frame.y, 390, frame.height)
    )
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await open(hub)
    await screen.findByText('Send a message to start.')
    const padding = () =>
      StyleSheet.flatten(screen.getByTestId('chat-session').props.style).paddingBottom ?? 0
    await act(async () => {
      fireEvent(screen.getByTestId('chat-session'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 600 } }
      })
    })
    expect(padding()).toBe(0)
    await act(async () => {
      DeviceEventEmitter.emit('keyboardWillShow', { endCoordinates: { height: 300, screenY: 500 } })
    })
    expect(padding()).toBe(200)
    // The title line above steps aside: the chat grows upwards, its bottom stays.
    frame = { y: 72, height: 628 }
    await act(async () => {
      fireEvent(screen.getByTestId('chat-session'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 628 } }
      })
    })
    expect(padding()).toBe(200)
    await act(async () => {
      DeviceEventEmitter.emit('keyboardWillHide', { endCoordinates: { height: 0, screenY: 844 } })
    })
    expect(padding()).toBe(0)
    native.measureInWindow.mockReset()
  })

  it('in a short screen the / menu and the prompt dock give way, never the input', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await open(hub)
    await screen.findByText('Send a message to start.')
    await fireEvent.changeText(screen.getByTestId('chat-input'), '/')
    const shrinks = (id: string) =>
      StyleSheet.flatten(screen.getByTestId(id).props.style).flexShrink
    expect(shrinks('slash-menu')).toBe(1)
    await hubSends(hub, [
      { kind: 'user-message', id: 'u1', text: 'go' },
      {
        kind: 'permission-request',
        requestId: 'r1',
        toolUseId: 't1',
        toolName: 'Bash',
        input: { command: 'ls' }
      } as AgentEvent
    ])
    expect(
      StyleSheet.flatten((await screen.findByTestId('prompt-dock')).props.style).flexShrink
    ).toBe(1)
    // The input row keeps its height: it is what must stay above the keyboard.
    expect(
      StyleSheet.flatten(screen.getByTestId('chat-input').parent?.props.style).flexShrink
    ).toBe(0)
  })
})

describe('ChatSession: computer availability', () => {
  it('replays output saved during a computer disconnect even when availability stays ready', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    let generation = 'boot:0'
    let missed = false
    hub.on('chat.availability', () => ({
      state: 'ready',
      computer: { id: 'pc', name: 'Laptop' },
      recoveryGeneration: generation
    }))
    hub.on('chat.getReplay', () => ({
      events: missed
        ? [
            {
              seq: 0,
              event: {
                kind: 'assistant-text',
                messageId: 'offline-answer',
                text: 'Completed while computer disconnected'
              }
            }
          ]
        : [],
      live: { afterSeq: missed ? 0 : -1, liveSeq: 0, events: [] }
    }))
    await open(hub)
    await screen.findByTestId('chat-input')
    await waitFor(() => expect(hub.callsTo('chat.getReplay')).toHaveLength(1))
    await waitFor(() => expect(screen.queryByTestId('chat-loading')).toBeNull())
    expect(hub.callsTo('chat.getReplay')).toHaveLength(1)
    await waitFor(() => expect(hub.subscribed['chat.onReplayRequired']).toEqual([{ tabId: TAB }]))
    await act(async () => {
      missed = true
      generation = 'boot:1'
      hub.emit('chat.onReplayRequired', { tabId: TAB, generation })
    })
    expect(await screen.findByText('Completed while computer disconnected')).toBeOnTheScreen()
    expect(hub.callsTo('chat.getReplay')).toHaveLength(2)
    expect(hub.callsTo('chat.send')).toEqual([])
  })

  it('a delayed old-provider queue acknowledgement cannot clear the newly selected provider draft', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    const { wrapper } = trpcTest(hub.backend)
    let confirm!: () => void
    hub.on(
      'chat.queue.push',
      () =>
        new Promise<void>((resolve) => {
          confirm = resolve
        })
    )
    const view = await render(
      <ChatSession hubId="hub-1" taskId={TASK} tabId={TAB} mode="claude-chat" />,
      { wrapper }
    )
    await screen.findByTestId('chat-input')
    await hubSends(hub, [
      { kind: 'turn-init', sessionId: 'old', model: 'opus', cwd: '/w', tools: [] },
      {
        kind: 'user-message',
        id: 'turn',
        text: 'running',
        content: [{ type: 'text', text: 'running' }]
      }
    ])
    await fireEvent.changeText(screen.getByTestId('chat-input'), 'old provider queued text')
    await fireEvent.press(screen.getByLabelText('Queue message'))
    await waitFor(() => expect(hub.callsTo('chat.queue.push')).toHaveLength(1))
    await view.rerender(<ChatSession hubId="hub-1" taskId={TASK} tabId={TAB} mode="codex-chat" />)
    await waitFor(() => expect(screen.queryByTestId('chat-loading')).toBeNull())
    await fireEvent.changeText(screen.getByTestId('chat-input'), 'new provider draft')
    await act(async () => {
      confirm()
    })
    expect(screen.getByTestId('chat-input').props.value).toBe('new provider draft')
    expect(hub.callsTo('chat.queue.push')[0]).toMatchObject({ expectedMode: 'claude-chat' })
  })

  it('uses one loader through computer setup and history loading without a separate storage banner', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    let finishSetup!: () => void
    const setup = new Promise<void>((resolve) => {
      finishSetup = resolve
    })
    const saved = {
      events: [
        { seq: 0, event: { kind: 'assistant-text', messageId: 'saved', text: 'Saved answer' } }
      ],
      live: { afterSeq: -1, liveSeq: 0, events: [] }
    }
    let finishHistory!: (value: typeof saved) => void
    const history = new Promise<typeof saved>((resolve) => {
      finishHistory = resolve
    })
    hub.on('chat.hydrate', () => setup)
    hub.on('chat.getReplay', () => history)
    hub.on('chat.availability', () => ({
      state: 'preparing',
      computer: { id: 'pc', name: 'Laptop' }
    }))
    try {
      await open(hub)
      await screen.findByTestId('chat-loading')
      await waitFor(() => expect(hub.callsTo('chat.availability')).toHaveLength(1))
      expect(screen.getAllByLabelText('Loading chat')).toHaveLength(1)
      expect(screen.queryByText(/Opening chat on|Preparing its storage/)).toBeNull()
      expect(screen.queryByText('Send a message to start.')).toBeNull()
      await act(async () => finishSetup())
      await waitFor(() => expect(hub.callsTo('chat.getReplay')).toHaveLength(1))
      expect(screen.getAllByLabelText('Loading chat')).toHaveLength(1)
      await act(async () => finishHistory(saved))
      expect(await screen.findByText('Saved answer')).toBeOnTheScreen()
      expect(screen.queryByTestId('chat-loading')).toBeNull()
      expect(screen.queryByText(/Opening chat on|Preparing its storage/)).toBeNull()
      expect(hub.callsTo('chat.hydrate')).toHaveLength(1)
      expect(hub.callsTo('chat.send')).toEqual([])
    } finally {
      finishSetup()
      finishHistory(saved)
    }
  })

  it('names an offline computer and reloads on Retry without resending or losing draft text', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    let offline = true
    hub.on('chat.availability', () => ({
      state: offline ? 'offline' : 'ready',
      computer: { id: 'c1', name: 'Office Mac' }
    }))
    hub.on('chat.hydrate', () => {
      if (offline) throw new Error('Computer offline')
      return null
    })
    await open(hub)
    expect(await screen.findByText(/Office Mac is offline/)).toBeOnTheScreen()
    await fireEvent.changeText(screen.getByTestId('chat-input'), 'keep this draft')
    offline = false
    await userEvent.setup().press(screen.getByText('Retry'))
    await waitFor(() => expect(hub.callsTo('chat.hydrate')).toHaveLength(2))
    await waitFor(() => expect(screen.queryByText(/Office Mac is offline/)).toBeNull())
    expect(screen.getByTestId('chat-input').props.value).toBe('keep this draft')
    expect(hub.callsTo('chat.send')).toEqual([])
  })

  it('explains when a running agent defers migration', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.availability', () => ({
      state: 'migrating',
      waitingForAgents: true,
      computer: { id: 'c1', name: 'Office Mac' }
    }))
    await open(hub)
    expect(
      await screen.findByText(/Stop this task’s agents to move its history to Office Mac/)
    ).toBeOnTheScreen()
    expect(hub.callsTo('chat.send')).toEqual([])
  })
})

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

describe('ChatSession: Codex plan approval', () => {
  it('offers implementation and sends decision to hub', async () => {
    const hub = fakeHub({
      tabId: TAB,
      taskId: TASK,
      session: { taskId: TASK, cwd: '/w', chatCollaboration: 'plan' }
    })
    await open(hub, 'codex-chat')
    await screen.findByText('Send a message to start.')
    await hubSends(hub, [
      { kind: 'codex-plan', planId: 'p1', turnId: 't1', text: '# Build it', phase: 'completed' },
      {
        kind: 'result',
        subtype: 'success',
        isError: false,
        durationMs: 1,
        durationApiMs: 0,
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
      }
    ])
    expect(await screen.findByText('Implement this plan?')).toBeOnTheScreen()
    await userEvent.setup().press(screen.getByText('Implement'))
    await waitFor(() => expect(hub.callsTo('chat.decidePlan')).toHaveLength(1))
    expect(hub.callsTo('chat.decidePlan')[0]).toMatchObject({ planId: 'p1', decision: 'implement' })
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
    expect(first.operationId).toEqual(expect.any(String))
    expect(second.operationId).toEqual(expect.any(String))
    expect(second.operationId).not.toBe(first.operationId)
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
      { source: 'cli-commands', name: 'compact', taskId: TASK }
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

  it('a Codex chat names Codex, not Claude, while it waits and when it stopped waiting', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.respondPermission', () => false)
    await open(hub, 'codex-chat')
    await screen.findByText('Send a message to start.')
    await hubSends(hub, [{ kind: 'user-message', id: 'u1', text: 'go' }, request])
    expect(await screen.findByText('Codex is waiting for your answer')).toBeOnTheScreen()
    expect(screen.getByText('No, and tell Codex what to do differently')).toBeOnTheScreen()
    expect(screen.queryByText(/Claude/)).toBeNull()
    await userEvent.setup().press(screen.getByText('Yes'))
    expect(await screen.findByText(/Codex stopped waiting for it/)).toBeOnTheScreen()
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

  it('the chips scroll sideways when they do not fit; a chip opens the app’s bottom sheet', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await open(hub)
    expect((await screen.findByTestId('chat-controls')).props.horizontal).toBe(true)
    await userEvent
      .setup()
      .press(await screen.findByLabelText('Permission mode: Auto-accept edits'))
    expect(screen.getByTestId('chat-control-sheet')).toBeOnTheScreen()
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

/** The phone task page's chrome, as a chat on it sees it. */
function pageChrome(fields: Partial<TaskChrome> = {}): TaskChrome {
  return {
    top: 56,
    bottom: 74,
    composer: { bottom: 74, start: 16, end: 16 },
    keyboardUp: false,
    onTimelineScroll: jest.fn(),
    ...fields
  }
}

/** The chat as the phone task page shows it: what it hands the page, and the page's chrome. */
async function openOnPage(hub: FakeHub, mode = 'claude-chat', chrome = pageChrome()) {
  const { wrapper } = trpcTest(hub.backend)
  const handed: { last: ChatChrome | null } = { last: null }
  await render(
    <TaskChromeProvider value={chrome}>
      <ChatSession
        hubId="hub-1"
        taskId={TASK}
        tabId={TAB}
        mode={mode}
        controls="page"
        onChrome={(c) => {
          handed.last = c
        }}
      />
    </TaskChromeProvider>,
    { wrapper }
  )
  return { handed, chrome }
}

describe('ChatSession on the phone task page', () => {
  const CODEX_LISTED = [
    {
      id: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      supportsEffort: true,
      isDefault: true,
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'ultra', label: 'Ultra' }
      ],
      defaultEffort: 'low'
    }
  ]

  it('no controls of its own: it hands them to the page, with whether it waits', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    const { handed } = await openOnPage(hub)
    await screen.findByTestId('chat-composer')
    expect(screen.queryByTestId('chat-controls')).toBeNull()
    expect(screen.queryByLabelText(/^Model: /)).toBeNull()
    // The permission mode comes with the session state, which can land after the first
    // hand-off (mode null until then): wait for the hand-off that carries it.
    await waitFor(() =>
      expect(handed.last).toMatchObject({
        mode: 'claude-chat',
        waiting: false,
        settings: { mode: 'auto-accept' }
      })
    )
  })

  it('the controls the page shows change the chat: a model tile opens the models', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.getModels', () => CODEX_LISTED)
    hub.on('chat.getModel', () => 'gpt-6-luna')
    hub.on('chat.getEffort', () => 'ultra')
    const { handed } = await openOnPage(hub, 'codex-chat')
    await waitFor(() => expect(handed.last?.settings.model).toBe('gpt-6-luna'))
    const c = handed.last!
    const { wrapper } = trpcTest(hub.backend)
    await render(
      <ChatControls mode={c.mode} settings={c.settings} models={c.models} variant="tiles" />,
      { wrapper }
    )
    const tiles = within(screen.getByTestId('chat-control-tiles'))
    expect(tiles.getByLabelText('Model').props.accessibilityValue).toEqual({ text: 'GPT-6 Luna' })
    expect(tiles.getByLabelText('Effort').props.accessibilityValue).toEqual({ text: 'Ultra' })
    expect(tiles.getByLabelText('Collaboration mode')).toBeOnTheScreen()
    // The choices fold out in place (the card is a pop-up: no sheet can open over it).
    await userEvent.setup().press(tiles.getByLabelText('Effort'))
    expect(screen.queryByTestId('chat-control-sheet')).toBeNull()
    await userEvent
      .setup()
      .press(within(screen.getByTestId('chat-control-choices')).getByText('Low'))
    expect(screen.queryByTestId('chat-control-choices')).toBeNull()
    await waitFor(() =>
      expect(hub.callsTo('chat.setEffort')).toEqual([
        expect.objectContaining({ tabId: TAB, chatEffort: 'low' })
      ])
    )
  })

  it('the composer floats between the page’s insets as a glass capsule, naming the agent', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await openOnPage(hub)
    const composer = await screen.findByTestId('chat-composer')
    expect(StyleSheet.flatten(composer.props.style)).toMatchObject({
      marginLeft: 16,
      marginRight: 16
    })
    expect(screen.getByTestId('chat-input')).toHaveProp('placeholder', 'Message Claude…')
    // Its root keeps the composer above the page's tab bar.
    expect(StyleSheet.flatten(screen.getByTestId('chat-session').props.style)).toMatchObject({
      paddingBottom: 74
    })
  })

  it('a Codex chat names Codex in the composer', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await openOnPage(hub, 'codex-chat')
    await screen.findByTestId('chat-composer')
    expect(screen.getByTestId('chat-input')).toHaveProp('placeholder', 'Message Codex…')
  })

  it('tells the page how far the timeline is from the newest message as it scrolls', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    const { chrome } = await openOnPage(hub)
    await screen.findByText('Send a message to start.')
    await hubSends(hub, [
      { kind: 'user-message', id: 'm1', text: 'Hello', content: [{ type: 'text', text: 'Hello' }] }
    ] as AgentEvent[])
    const timeline = await screen.findByTestId('chat-timeline')
    await act(async () =>
      fireEvent.scroll(timeline, { nativeEvent: { contentOffset: { y: 420 } } })
    )
    expect(chrome.onTimelineScroll).toHaveBeenCalledWith(420)
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

  const queuedRow = (over: Record<string, unknown> = {}) => ({
    id: 'q1',
    tabId: TAB,
    send: 'also run lint',
    original: 'also run lint',
    position: 0,
    createdAt: '2026-11-03 10:00:00',
    ...over
  })
  const runningTurn = (hub: FakeHub) =>
    hubSends(hub, [
      { kind: 'turn-init', sessionId: 's', model: 'opus', cwd: '/w', tools: [] },
      { kind: 'user-message', id: 'u1', text: 'build', content: [{ type: 'text', text: 'build' }] }
    ])

  it('Stop with messages waiting asks first: they would be dropped', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.queue.list', () => [queuedRow()])
    const alert = jest.spyOn(Alert, 'alert')
    await open(hub)
    await screen.findByTestId('chat-queue')
    await runningTurn(hub)
    const user = userEvent.setup()
    alert.mockImplementationOnce((_t, _m, buttons) =>
      buttons?.find((b) => b.text === 'Cancel')?.onPress?.()
    )
    await user.press(await screen.findByLabelText('Stop generation'))
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert.mock.calls[0][0]).toMatch(/1 queued message/)
    expect(hub.callsTo('chat.abortAndPop')).toHaveLength(0)
    expect(hub.callsTo('chat.queue.clear')).toHaveLength(0)
    alert.mockImplementationOnce((_t, _m, buttons) =>
      buttons?.find((b) => b.text === 'Stop')?.onPress?.()
    )
    await user.press(screen.getByLabelText('Stop generation'))
    await waitFor(() => expect(hub.callsTo('chat.abortAndPop')).toHaveLength(1))
    alert.mockRestore()
  })

  it('Send and Stop are at least 44pt to a finger', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    await open(hub)
    await screen.findByText('Send a message to start.')
    await runningTurn(hub)
    for (const label of ['Queue message', 'Stop generation']) {
      const button = await screen.findByLabelText(label)
      const style = StyleSheet.flatten(button.props.style)
      const slop = button.props.hitSlop ?? 0
      expect(style.width + 2 * slop).toBeGreaterThanOrEqual(44)
      expect(style.height + 2 * slop).toBeGreaterThanOrEqual(44)
    }
  })

  it('"Send now" on a queued message while a turn runs', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.queue.list', () => [queuedRow()])
    hub.on('chat.queue.steer', () => ({ ok: true }))
    await open(hub)
    await screen.findByTestId('chat-queue')
    expect(screen.queryByLabelText('Send now: also run lint')).toBeNull()
    await runningTurn(hub)
    await fireEvent.press(await screen.findByLabelText('Send now: also run lint'))
    await waitFor(() => expect(hub.callsTo('chat.queue.steer')).toEqual([{ id: 'q1', tabId: TAB }]))
  })

  it('a refused add says why', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.queue.list', () => [queuedRow()])
    hub.on('chat.queue.steer', () => ({ ok: false, reason: 'no active turn to steer' }))
    await open(hub)
    await screen.findByTestId('chat-queue')
    await runningTurn(hub)
    await fireEvent.press(await screen.findByLabelText('Send now: also run lint'))
    await screen.findByText('Could not send it now: no active turn to steer')
  })

  it('a message with the agent is marked; Claude can take it back, Codex cannot', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.queue.list', () => [queuedRow({ steering: true })])
    await open(hub)
    await screen.findByTestId('chat-queue')
    await runningTurn(hub)
    const queue = await screen.findByTestId('chat-queue')
    expect(queue).toHaveTextContent(/With agent/)
    expect(screen.queryByLabelText('Send now: also run lint')).toBeNull()
    expect(screen.queryByLabelText('Remove queued message: also run lint')).toBeNull()
    await fireEvent.press(screen.getByLabelText('Take back from the agent: also run lint'))
    await waitFor(() =>
      expect(hub.callsTo('chat.queue.remove')).toEqual([{ id: 'q1', tabId: TAB }])
    )
  })

  it('a queued message shows in Up next at once, before the hub confirms it', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.queue.push', () => new Promise(() => {}))
    await open(hub)
    await screen.findByTestId('chat-input')
    await runningTurn(hub)
    await fireEvent.changeText(screen.getByTestId('chat-input'), 'follow-up')
    await fireEvent.press(screen.getByLabelText('Queue message'))
    const queue = await screen.findByTestId('chat-queue')
    expect(queue).toHaveTextContent(/follow-up/)
    expect(screen.queryByText(/Waiting for queue confirmation/)).toBeNull()
    expect(screen.getByTestId('chat-input').props.value).toBe('')
  })

  it('Codex: a message with the agent cannot be taken back', async () => {
    const hub = fakeHub({ tabId: TAB, taskId: TASK, session: { taskId: TASK, cwd: '/w' } })
    hub.on('chat.queue.list', () => [queuedRow({ steering: true })])
    await open(hub, 'codex-chat')
    const queue = await screen.findByTestId('chat-queue')
    expect(queue).toHaveTextContent(/With agent/)
    expect(screen.queryByLabelText('Take back from the agent: also run lint')).toBeNull()
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
