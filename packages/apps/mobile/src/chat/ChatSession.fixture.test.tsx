/**
 * `ChatSession` against what a real hub sent: `__fixtures__/hub-chat-session.json` was
 * recorded from a SlayZone hub whose agent was the scripted fake CLI (and two real
 * recorded CLI turns) — every `chat.*` message a subscribed client got, per action.
 * The UI drives the same actions here; the in-memory hub answers each with the recorded
 * reply and pushes the recorded messages, through the real tRPC client, the sync engine
 * and desktop's reducer: streaming text and thinking, a tool card, a permission allowed
 * and one denied, a message queued behind a turn and sent by the hub, a stopped turn
 * (interrupted live), a background job, a question answered, an unanswered message
 * stopped and handed back, a rewind made on desktop, a message with a file attached on
 * desktop, the CLI's own command words in the `/` menu — and the same history loaded fresh.
 * Re-record with `scripts/record-chat-fixture.mts`.
 */
import { act, fireEvent, render, screen, userEvent, waitFor } from '@testing-library/react-native'
import { trpcTest } from '../testing'
import fixture from './__fixtures__/hub-chat-session.json'
import { ChatSession } from './ChatSession'
import { type FakeHub, fakeHub } from './fake-hub'

// The ids the recorded client minted, in the order this UI mints them.
const mockIds = {
  list: ['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-q1', 'msg-5', 'msg-6', 'msg-7', 'msg-8', 'msg-9'],
  next: 0
}
jest.mock('./ids', () => ({
  newMessageId: () => mockIds.list[mockIds.next++] ?? `extra-${mockIds.next}`
}))

type Segment = (typeof fixture.segments)[number]
type Wire = Segment['wire'][number]
const PATH_OF: Record<string, string> = {
  send: 'chat.send',
  respondPermission: 'chat.respondPermission',
  'queue.push': 'chat.queue.push',
  abortAndPop: 'chat.abortAndPop',
  stopCommandTask: 'chat.stopCommandTask'
}
const CWD = '{{cwd}}'

/**
 * A hub that answers each action with its recorded reply; `deliver()` then sends what
 * the hub sent after it (inside `act`, after the reply, like the hub).
 */
function recordedHub(): {
  hub: FakeHub
  inputs: Array<{ action: string; input: unknown; recorded: unknown }>
  deliver: () => Promise<void>
  /** Send what the hub sent after another client's recorded action (e.g. desktop's rewind). */
  deliverRecorded: (action: string) => Promise<void>
} {
  const hub = fakeHub({
    tabId: fixture.tabId,
    taskId: fixture.taskId,
    projects: [
      {
        id: 'p1',
        selected_repo: null,
        placements: [{ computer_id: 'c1', path: CWD, status: 'ready' }],
        resolved_computer_id: 'c1'
      }
    ]
  })
  const inputs: Array<{ action: string; input: unknown; recorded: unknown }> = []
  const queue: { items: unknown[] } = { items: [] }
  hub.on('chat.queue.list', () => queue.items)
  const pending = fixture.segments.filter((s) => PATH_OF[s.action])
  const outbox: Wire[][] = []
  const send = (wire: Wire[]) => {
    for (const w of wire) {
      const path =
        w.kind === 'event'
          ? 'chat.onEvent'
          : w.kind === 'exit'
            ? 'chat.onExit'
            : w.kind === 'queue-changed'
              ? 'chat.onQueueChanged'
              : 'chat.onQueueDrained'
      if (w.kind === 'queue-drained') queue.items = []
      hub.emit(path, w.data)
    }
  }
  for (const [action, path] of Object.entries(PATH_OF)) {
    hub.on(path, (input) => {
      const seg = pending.shift()
      if (!seg || seg.action !== action)
        throw new Error(`unexpected ${action} (next recorded: ${seg?.action})`)
      inputs.push({ action, input, recorded: seg.input })
      if ('queue' in seg && seg.queue) queue.items = seg.queue as unknown[]
      outbox.push(seg.wire)
      return seg.output
    })
  }
  const deliver = async (): Promise<void> => {
    await waitFor(() => expect(outbox.length).toBeGreaterThan(0))
    await act(async () => {
      while (outbox.length > 0) send(outbox.shift() as Wire[])
    })
  }
  const deliverRecorded = async (action: string): Promise<void> => {
    const seg = fixture.segments.find((s) => s.action === action)
    if (!seg) throw new Error(`no recorded ${action}`)
    await act(async () => send(seg.wire))
  }
  return { hub, inputs, deliver, deliverRecorded }
}

const textOf = (str: string | RegExp) => screen.queryAllByText(str).length > 0
/** The text the recorded client sent in segment `i`. */
const sentText = (i: number): string => (fixture.segments[i].input as { text: string }).text

async function type(text: string) {
  await fireEvent.changeText(screen.getByTestId('chat-input'), text)
}

/** The whole recorded session in one test: well past jest's 5s default under a loaded run. */
const LONG_SCENARIO_MS = 30_000

describe('ChatSession against a recorded hub session', () => {
  beforeEach(() => {
    mockIds.next = 0
  })

  it(
    'streams, answers, queues, stops and lists jobs the way the hub drives it',
    async () => {
      const { hub, inputs, deliver, deliverRecorded } = recordedHub()
      const { wrapper } = trpcTest(hub.backend)
      await render(
        <ChatSession
          hubId="hub-1"
          taskId={fixture.taskId}
          tabId={fixture.tabId}
          mode="claude-chat"
        />,
        { wrapper }
      )
      const user = userEvent.setup()
      // Opened: attached through the tab's own subscription, hydrated in the task's folder.
      await waitFor(() =>
        expect(hub.callsTo('chat.getReplay')).toEqual([{ tabId: fixture.tabId, afterSeq: -1 }])
      )
      expect(hub.subscribed['chat.onEvent']).toEqual([{ tabIds: [fixture.tabId] }])
      expect(hub.callsTo('chat.hydrate')).toEqual([
        {
          tabId: fixture.tabId,
          taskId: fixture.taskId,
          mode: 'claude-chat',
          cwd: CWD,
          providerFlagsOverride: null
        }
      ])
      await screen.findByText('Send a message to start.')

      // 1. Streaming thinking + text, a Bash tool card, a second streamed message.
      await type('Say hello and list the files')
      await user.press(screen.getByLabelText('Send'))
      await deliver()
      await waitFor(() => expect(textOf('Two files.')).toBe(true))
      expect(textOf('List files')).toBe(true)
      expect(textOf(/Thought/)).toBe(true)
      expect(textOf(/Done in/)).toBe(true)
      expect(inputs[0].input).toEqual({
        tabId: fixture.tabId,
        message: { id: 'msg-1', content: [{ type: 'text', text: 'Say hello and list the files' }] }
      })

      // 2. A Bash permission request, allowed ("Yes").
      await type(sentText(2))
      await user.press(screen.getByLabelText('Send'))
      await deliver()
      await screen.findByTestId('prompt-dock')
      expect(textOf('Bash command')).toBe(true)
      await user.press(screen.getByText('Yes'))
      await deliver()
      await waitFor(() => expect(screen.queryByTestId('prompt-dock')).toBeNull())
      expect(inputs[2].input).toEqual({ tabId: fixture.tabId, args: inputs[2].recorded })

      // 3. Denied ("No" — the turn stops).
      await type(sentText(4))
      await user.press(screen.getByLabelText('Send'))
      await deliver()
      await screen.findByTestId('prompt-dock')
      await user.press(screen.getByText('No'))
      await deliver()
      await waitFor(() => expect(screen.queryByTestId('prompt-dock')).toBeNull())
      expect(inputs[4].input).toEqual({ tabId: fixture.tabId, args: inputs[4].recorded })
      await waitFor(() => expect(textOf('Turn interrupted')).toBe(true))

      // 4. A message sent while a turn runs waits in the hub's queue; the hub sends it.
      await type('Count slowly')
      await user.press(screen.getByLabelText('Send'))
      await deliver()
      await screen.findByLabelText('Queue message')
      await type('And then this')
      await user.press(screen.getByLabelText('Queue message'))
      await deliver()
      expect(inputs[6].input).toEqual(inputs[6].recorded)
      await waitFor(() => expect(textOf('Answer to the queued message.')).toBe(true))
      expect(screen.queryByTestId('chat-queue')).toBeNull()

      // 5. Stop a running turn: the queue is cleared, the turn aborted.
      await type('Work on something long')
      await user.press(screen.getByLabelText('Send'))
      await deliver()
      await waitFor(() => expect(textOf(/Working on/)).toBe(true))
      await user.press(screen.getByLabelText('Stop generation'))
      await deliver()
      expect(hub.callsTo('chat.queue.clear')).toEqual([{ tabId: fixture.tabId }])
      expect(inputs[8].input).toEqual({
        tabId: fixture.tabId,
        taskId: fixture.taskId,
        mode: 'claude-chat',
        cwd: CWD,
        providerFlagsOverride: null
      })
      await waitFor(() => expect(screen.queryByLabelText('Stop generation')).toBeNull())

      // 6. A background job: listed, and stopped from the list.
      await type('Start the dev server in the background')
      await user.press(screen.getByLabelText('Send'))
      await deliver()
      await screen.findByTestId('background-jobs')
      await user.press(screen.getByLabelText(/Background jobs: 1 running of 1/))
      await user.press(screen.getByLabelText(/Stop background job/))
      await deliver()
      expect(inputs[10].input).toEqual(inputs[10].recorded)
      await waitFor(() =>
        expect(screen.queryByLabelText(/Background jobs: 0 running of 1/)).not.toBeNull()
      )

      // 7. AskUserQuestion: pick each question's first option, Submit.
      await type(sentText(12))
      await user.press(screen.getByLabelText('Send'))
      await deliver()
      await screen.findByTestId('prompt-dock')
      const recorded = inputs.length
      const answer = (
        fixture.segments[13].input as {
          decision: { updatedInput: { answers: Record<string, string> } }
        }
      ).decision.updatedInput.answers
      for (const label of Object.values(answer))
        await user.press(screen.getAllByText(label).at(-1)!)
      await user.press(screen.getByText('Submit'))
      await deliver()
      await waitFor(() => expect(screen.queryByTestId('prompt-dock')).toBeNull())
      expect(inputs[recorded].input).toEqual({
        tabId: fixture.tabId,
        args: inputs[recorded].recorded
      })

      // The `/` menu has the CLI's own words: its live list (the recorded CLI's) with the
      // descriptions + hints of its `initialize` reply.
      await type('/goa')
      expect(await screen.findByText('Set a goal Claude keeps working toward')).toBeOnTheScreen()
      expect(screen.getByText(/<condition>/)).toBeOnTheScreen()
      await type('')

      // 8. Stopped before anything came back: the message is withdrawn and handed back.
      await type(sentText(14))
      await user.press(screen.getByLabelText('Send'))
      await deliver()
      await user.press(screen.getByLabelText('Stop generation'))
      await deliver()
      await waitFor(() => expect(screen.getByTestId('chat-input').props.value).toBe(sentText(14)))
      expect(textOf(sentText(14))).toBe(false)

      // 9. Answered, then rewound on desktop: folded behind its divider, shown on demand.
      await type(sentText(16))
      await user.press(screen.getByLabelText('Send'))
      await deliver()
      await waitFor(() => expect(textOf('Sure, noted.')).toBe(true))
      await deliverRecorded('rewind')
      await screen.findByText('Rewound: Claude forgot what came after this point')
      expect(textOf('Sure, noted.')).toBe(false)
      await user.press(screen.getByLabelText(/^Show rewound \(\d+\)$/))
      await waitFor(() => expect(textOf('Sure, noted.')).toBe(true))
      expect(inputs).toHaveLength(16)

      // 10. A message with a file, sent on desktop: the bubble names the file.
      await deliverRecorded('desktop-send')
      await waitFor(() => expect(textOf('Your notes say: buy milk.')).toBe(true))
      expect(textOf('Summarize the attached notes')).toBe(true)
      expect(screen.getByLabelText('Attached text file notes.txt, 9 B')).toBeOnTheScreen()
    },
    LONG_SCENARIO_MS
  )

  it('loads the same history fresh (a reopened tab, a phone that was away)', async () => {
    const hub = fakeHub({
      tabId: fixture.tabId,
      taskId: fixture.taskId,
      session: { taskId: fixture.taskId, cwd: CWD }
    })
    hub.on('chat.getReplay', () => fixture.finalReplay)
    const { wrapper } = trpcTest(hub.backend)
    await render(
      <ChatSession
        hubId="hub-1"
        taskId={fixture.taskId}
        tabId={fixture.tabId}
        mode="claude-chat"
      />,
      { wrapper }
    )
    // The tab's session folder is used as is; nothing about the task is read.
    await waitFor(() => expect(hub.callsTo('chat.hydrate')[0]?.cwd).toBe(CWD))
    expect(hub.callsTo('task.get')).toEqual([])
    // Newest rows on screen: the answered question's turn, the job, no pending prompt.
    await waitFor(() => expect(screen.queryByTestId('chat-timeline')).not.toBeNull())
    expect(screen.queryByTestId('prompt-dock')).toBeNull()
    expect(screen.queryByTestId('background-jobs')).not.toBeNull()
    expect(screen.queryByLabelText('Stop generation')).toBeNull()
    // Desktop's rewind stays folded behind its divider.
    expect(screen.getByText('Rewound: Claude forgot what came after this point')).toBeOnTheScreen()
    expect(textOf('Sure, noted.')).toBe(false)
    // Desktop's message keeps its file.
    expect(screen.getByLabelText('Attached text file notes.txt, 9 B')).toBeOnTheScreen()
  })
})
