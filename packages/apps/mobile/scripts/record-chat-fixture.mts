/**
 * Records what a SlayZone hub sends a chat client, end to end, into the fixture the
 * mobile chat's jest suite replays (`src/chat/__fixtures__/hub-chat-session.json`,
 * `ChatSession.fixture.test.tsx`) — and proves the phone's chat client against a real
 * hub on the way. Not run by any test suite: run it again when the hub's chat events
 * change, then run the fixture test.
 *
 *   pnpm --filter @slayzone/hub build && pnpm --filter @slayzone/computer build
 *   pnpm exec tsx packages/apps/mobile/scripts/record-chat-fixture.mts   # repo root
 *
 * What runs (see `test-hub.mts`): a hub of this checkout on 127.0.0.1:47861 and a
 * computer enrolled for the phone's account, whose `claude` is fake-claude
 * (`packages/shared/test-utils/fake-claude`) playing scripted turns and two real
 * recorded transcripts (permission-bash, ask-user-question). The client is the phone's
 * own: its sync engine (`src/chat/chat-sync.ts`) and desktop's reducer, fed by
 * `chat.onEvent({tabIds})` the way `useChatSession` is (onStarted → hydrate → replay).
 * The fake CLI's `initialize` reply describes one command (`cli-command-details`), and
 * one message comes from another client (desktop) with a task artifact attached.
 * The fixture holds no secret: folders become `{{cwd}}` / `{{home}}`.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { initialState, reducer } from '@slayzone/terminal/reducer'
import {
  createFakeClaude,
  echoTurn,
  ev,
  reply,
  step,
  streamMessage,
  taskStep,
  transcriptPath
} from '@slayzone/test-utils/fake-claude'
import { ChatSync, type ChatWireEvent, type ChatWireExit } from '../src/chat/chat-sync.ts'
import {
  check,
  createProject,
  fail,
  finish,
  freshStateDir,
  REPO,
  signInPhone,
  sleep,
  startTestHub,
  until
} from './test-hub.mts'

const OUT = path.join(REPO, 'packages/apps/mobile/src/chat/__fixtures__/hub-chat-session.json')
// The hub's port: the first argument, else 47861.
const PORT = Number(process.argv[2] ?? 47861)

const dir = freshStateDir('record-chat-fixture')
const HOME = path.join(dir, 'home')
const WORK = path.join(HOME, 'work')
mkdirSync(WORK, { recursive: true })
const fake = createFakeClaude({ root: path.join(dir, 'fake') })

type Wire =
  | { kind: 'event'; data: ChatWireEvent }
  | { kind: 'exit'; data: ChatWireExit }
  | { kind: 'queue-changed' | 'queue-drained'; data: unknown }
interface Segment {
  /** What the client did; `rewind` is another client's (desktop's) action. */
  action: string
  input?: unknown
  output?: unknown
  /** Everything the hub sent the client after it, until the next action. */
  wire: Wire[]
  queue?: unknown
}

try {
  const hub = await startTestHub({ name: 'mobile-chat-fixture', port: PORT, dir })
  const account = await hub.createUser('mobile@chat-fixture.test')
  hub.startComputer({ forUser: account.email, allowedRoot: HOME, binOverrideDir: fake.binDir })
  const phone = await signInPhone(hub.address, account)
  check(true, 'phone account signed in with its password (bearer socket)')
  const client = phone.client

  const project = await createProject(client, {
    name: 'Chat fixtures',
    color: '#8b5cf6',
    path: WORK
  })
  check(true, 'project created on the enrolled computer')
  const task = await client.task.create.mutate({
    projectId: project.id,
    title: 'Chat on the phone',
    terminalMode: 'claude-chat'
  })
  const tab = await client.taskTerminals.ensureMain.mutate({ taskId: task.id, mode: 'claude-chat' })
  const tabId = tab.id
  check(tabId === task.id, `main tab id is the task id (${tabId})`)

  // The fake CLI's script: one process (Stop interrupts it live; it keeps running),
  // one turn per user message.
  fake.setScenario({
    processes: [
      {
        turns: [
          // 0: streamed thinking + text + a Bash tool call, then a second streamed message.
          [
            step.emit(ev.init()),
            ...streamMessage(
              'msg_stream_1',
              [
                { thinking: ['The user wants ', 'a greeting.'] },
                { text: ['Hello', ' from', ' the **fake** CLI.'] },
                {
                  toolUse: {
                    id: 'toolu_ls',
                    name: 'Bash',
                    input: { command: 'ls -la', description: 'List files' }
                  }
                }
              ],
              { gapMs: 15 }
            ),
            step.emit(ev.toolResult({ toolUseId: 'toolu_ls', content: 'README.md\nsrc' })),
            ...streamMessage('msg_stream_2', [{ text: ['Two ', 'files.'] }], { gapMs: 15 }),
            step.emit(ev.result({ text: 'Two files.' }))
          ],
          // 1 + 2: a real recorded Bash permission request (allowed, then denied).
          [step.replay(transcriptPath('permission-bash'), { turn: 0 })],
          [step.replay(transcriptPath('permission-bash'), { turn: 1 })],
          // 3: a slow turn — a message is queued while it runs.
          [
            step.emit(ev.init()),
            ...streamMessage('msg_slow', [{ text: ['Counting', ' one,', ' two,', ' three.'] }], {
              gapMs: 250
            }),
            step.emit(ev.result({ text: 'done' }))
          ],
          // 4: the queued message, sent by the hub when the agent was free.
          reply('Answer to the queued message.'),
          // 5: a turn that runs until it is stopped (Stop interrupts it live).
          [
            step.emit(ev.init()),
            ...streamMessage('msg_hang', [{ text: ['Working on ', 'it'] }], { open: true }),
            step.hang()
          ],
          // 6: a background shell.
          [
            step.emit(
              ev.init(),
              ev.toolUse({
                id: 'toolu_bg',
                name: 'Bash',
                input: {
                  command: 'npm run dev',
                  run_in_background: true,
                  description: 'Start the dev server'
                }
              })
            ),
            taskStep({
              taskId: 'bgtask1',
              toolUseId: 'toolu_bg',
              background: true,
              description: 'Start the dev server',
              output: [{ atMs: 50, text: 'ready on :3000\n' }],
              endAtMs: 60_000
            }),
            step.emit(ev.text('The dev server runs in the background.'), ev.result({ text: 'ok' }))
          ],
          // 7: a real recorded AskUserQuestion.
          [step.replay(transcriptPath('ask-user-question'), { turn: 0 })],
          // 8: nothing comes back before Stop: the message is withdrawn (popped).
          [step.hang()],
          // 9: answered; then rewound from desktop (edit & resend).
          reply('Sure, noted.'),
          // 10: desktop's message with a text file attached.
          reply('Your notes say: buy milk.')
        ],
        // The CLI's own words for its commands (the `/` menu's descriptions + hints).
        controlPayloads: {
          initialize: {
            commands: [
              {
                name: 'goal',
                description: 'Set a goal Claude keeps working toward',
                argumentHint: '<condition>'
              }
            ]
          }
        },
        defaultTurn: echoTurn()
      }
    ]
  })

  // The phone's client: sync engine + reducer, fed by the tab's own subscription.
  const segments: Segment[] = [{ action: 'open', wire: [] }]
  let current = segments[0]
  const begin = (action: string, input?: unknown): Segment => {
    current = { action, input, wire: [] }
    segments.push(current)
    return current
  }
  let state = initialState()
  const sync = new ChatSync(tabId, {
    dispatch: (a) => {
      state = reducer(state, a)
    },
    requestFrame: () => void setTimeout(() => sync.flush(), 5),
    cancelFrame: () => undefined
  })
  let started = 0
  const target = {
    tabId,
    taskId: task.id,
    mode: 'claude-chat',
    cwd: WORK,
    providerFlagsOverride: null
  }
  async function load(kind: 'full' | 'catch-up'): Promise<void> {
    const ticket = sync.beginLoad(kind)
    if (kind === 'full') await client.chat.hydrate.mutate(target)
    const replay = await client.chat.getReplay.query({ tabId, afterSeq: ticket.afterSeq })
    if (sync.completeLoad(ticket, replay) === 'reload') await load('full')
  }
  // The folder exactly as the phone resolves it (`chat-cwd.ts`): no session yet, so the
  // task's — the project's folder on the computer it runs on.
  check((await client.chat.getInfo.query({ tabId })) === null, 'no session yet before hydrate')
  let loaded: Promise<void> = Promise.resolve()
  const subs = [
    client.chat.onEvent.subscribe(
      { tabIds: [tabId] },
      {
        onStarted: () => {
          started++
          loaded = load(started === 1 ? 'full' : 'catch-up')
        },
        onData: (data) => {
          current.wire.push({ kind: 'event', data })
          if (sync.receive(data) === 'regressed') void load('full')
        }
      }
    ),
    client.chat.onExit.subscribe(undefined, {
      onData: (data) => {
        if (data.tabId !== tabId) return
        current.wire.push({ kind: 'exit', data })
        sync.exit(data)
      }
    }),
    client.chat.onQueueChanged.subscribe(undefined, {
      onData: (data) => {
        if (data.tabId === tabId) current.wire.push({ kind: 'queue-changed', data })
      }
    }),
    client.chat.onQueueDrained.subscribe(undefined, {
      onData: (data) => {
        if (data.tabId === tabId) current.wire.push({ kind: 'queue-drained', data })
      }
    })
  ]
  await until('onEvent started', () => started > 0)
  await loaded
  check(!sync.loading && sync.loadedOnce, 'hydrated (no spawn) and replayed')
  const hydrated = await client.chat.getInfo.query({ tabId })
  check(hydrated?.cwd === WORK, `hydrated in the folder desktop uses (${hydrated?.cwd})`)

  const results = (): number => state.resultCount
  let ids = 0
  const send = async (text: string): Promise<string> => {
    const id = `msg-${++ids}`
    const seg = begin('send', { text, id })
    state = reducer(state, { type: 'user-sent', id, text })
    seg.output = await client.chat.send.mutate({
      tabId,
      message: { id, content: [{ type: 'text', text }] }
    })
    return id
  }
  const pendingPrompt = (toolName?: string) =>
    state.prompts.find((p) => p.status === 'pending' && (!toolName || p.toolName === toolName))

  // 0: stream + tool card
  let r0 = results()
  await send('Say hello and list the files')
  await until(
    'turn 0',
    () =>
      results() > r0 && state.timeline.some((i) => i?.kind === 'text' && i.text === 'Two files.')
  )
  check(
    state.timeline.some(
      (i) => i?.kind === 'tool' && i.invocation.name === 'Bash' && i.invocation.status === 'done'
    ),
    'tool card done'
  )
  check(
    state.timeline.some((i) => i?.kind === 'thinking'),
    'thinking row'
  )

  // 1: permission request → allow
  r0 = results()
  await send('Use the Bash tool to run exactly: touch created-by-claude.txt')
  const p1 = await until('permission request 1', () => pendingPrompt())
  const allow = {
    requestId: p1.requestId,
    optionId: 'yes',
    decision: { behavior: 'allow' as const }
  }
  let seg = begin('respondPermission', allow)
  seg.output = await client.chat.respondPermission.mutate({ tabId, args: allow })
  const again = await client.chat.respondPermission.mutate({ tabId, args: allow })
  check(
    seg.output === true && again === false,
    `answer accepted once, the double submit refused (${seg.output}/${again})`
  )
  await until('turn 1', () => results() > r0)
  check(
    state.prompts.find((p) => p.requestId === p1.requestId)?.status === 'resolved',
    'prompt 1 resolved (allow)'
  )

  // 2: permission request → deny (No: the turn stops)
  r0 = results()
  await send('Use the Bash tool to run exactly: rm created-by-claude.txt')
  const p2 = await until('permission request 2', () => pendingPrompt())
  const deny = {
    requestId: p2.requestId,
    optionId: 'no',
    decision: {
      behavior: 'deny' as const,
      message:
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
      interrupt: true
    }
  }
  seg = begin('respondPermission', deny)
  seg.output = await client.chat.respondPermission.mutate({ tabId, args: deny })
  await until('turn 2 end', () => results() > r0 || state.timeline.at(-1)?.kind === 'interrupted')
  await sleep(500)
  check(
    state.prompts.find((p) => p.requestId === p2.requestId)?.decision?.behavior === 'deny',
    'prompt 2 resolved (deny)'
  )

  // 3 + 4: slow turn, a message queued meanwhile, sent by the hub
  r0 = results()
  await send('Count slowly')
  await until(
    'slow turn streaming',
    () =>
      state.live.length > 0 ||
      state.timeline.some((i) => i?.kind === 'text' && i.messageId === 'msg_slow')
  )
  const queued = {
    tabId,
    send: 'And then this',
    original: 'And then this',
    id: 'msg-q1',
    content: [{ type: 'text' as const, text: 'And then this' }]
  }
  seg = begin('queue.push', queued)
  seg.output = await client.chat.queue.push.mutate(queued)
  seg.queue = await client.chat.queue.list.query({ tabId })
  check(
    Array.isArray(seg.queue) && seg.queue.length === 1,
    'message waits in the queue while the turn runs'
  )
  await until('queued message answered', () => results() >= r0 + 2, 30_000)
  check(
    state.timeline.some((i) => i?.kind === 'user-text' && i.text === 'And then this'),
    'queued message delivered by the hub'
  )
  check(
    state.timeline.some((i) => i?.kind === 'text' && i.text === 'Answer to the queued message.'),
    'queued message answered'
  )
  check((await client.chat.queue.list.query({ tabId })).length === 0, 'queue drained')

  // 5: a running turn, stopped (the composer's Stop generation = abortAndPop): Claude
  // Code is interrupted live and keeps its process.
  const runsBefore = fake.current().runs().length
  await send('Work on something long')
  await until('long turn streaming', () => state.live.some((b) => b.text.includes('Working')))
  seg = begin('abortAndPop', target)
  seg.output = await client.chat.abortAndPop.mutate(target)
  await until('interrupted marker', () => state.timeline.some((i) => i?.kind === 'interrupted'))
  // The stopped turn still ends with its own `result` (after the marker): wait for it,
  // or the next message's row would be placed before it here but after it on reload.
  await until('the stopped turn ends', () => {
    const marker = state.timeline.findLastIndex((i) => i?.kind === 'interrupted')
    return marker >= 0 && state.timeline.slice(marker).some((i) => i?.kind === 'result')
  })
  check(
    state.timeline.some((i) => i?.kind === 'interrupted'),
    `interrupted (abortAndPop → ${JSON.stringify(seg.output)})`
  )

  // 6: background shell — still the same process (the stop did not respawn it)
  await send('Start the dev server in the background')
  await until(
    'turn 6',
    () =>
      state.timeline.some(
        (i) => i?.kind === 'text' && i.text === 'The dev server runs in the background.'
      ) && state.bgShells.size > 0,
    30_000
  )
  check(
    fake.current().runs().length === runsBefore,
    `Stop kept the agent's process (${fake.current().runs().length} process(es))`
  )
  const shells = [...state.bgShells.values()]
  check(
    shells.length === 1 && (shells[0].status === 'running' || shells[0].status === 'pending'),
    `background job listed (${shells[0]?.status})`
  )
  const stopJob = { tabId, taskId: shells[0]?.shellId ?? 'bgtask1' }
  seg = begin('stopCommandTask', stopJob)
  seg.output = await client.chat.stopCommandTask
    .mutate(stopJob)
    .catch((e: Error) => ({ error: e.message }))
  await sleep(1_000)

  // 7: AskUserQuestion answered through the prompt (desktop's QuestionPrompt path)
  r0 = results()
  const askLine = readFileSync(transcriptPath('ask-user-question'), 'utf8')
    .split('\n')
    .find((l) => l.includes('"kind":"stdin"'))
  if (!askLine) throw new Error('ask-user-question transcript has no stdin line')
  const askMessage = JSON.parse(JSON.parse(askLine).line).message.content as string
  await send(askMessage)
  const p3 = await until('question', () => pendingPrompt('AskUserQuestion'), 30_000)
  const questions = (
    p3.input as { questions: Array<{ question: string; options: Array<{ label: string }> }> }
  ).questions
  const answers = Object.fromEntries(questions.map((q) => [q.question, q.options[0].label]))
  const answer = {
    requestId: p3.requestId,
    optionId: 'answer',
    decision: {
      behavior: 'allow' as const,
      updatedInput: { ...(p3.input as object), answers }
    }
  }
  seg = begin('respondPermission', answer)
  seg.output = await client.chat.respondPermission.mutate({ tabId, args: answer })
  await until('turn 7', () => results() > r0, 30_000)
  check(
    state.prompts.find((p) => p.requestId === p3.requestId)?.status === 'resolved',
    'question answered'
  )

  // 8: Stop before anything came back: the message is withdrawn and handed back.
  const popped = await send('Never mind this one')
  await sleep(300)
  seg = begin('abortAndPop', target)
  const stop = await client.chat.abortAndPop.mutate(target)
  seg.output = stop
  check(
    stop.popped && stop.id === popped && stop.text === 'Never mind this one',
    `an unanswered message is popped whole (${JSON.stringify(stop)})`
  )
  await until(
    'popped row gone',
    () => !state.timeline.some((i) => i?.kind === 'user-text' && i.id === popped)
  )

  // 9: answered, then rewound from another client (desktop's edit & resend): the
  // message and its answer are folded behind a divider on the phone.
  r0 = results()
  const rewound = await send('One more thing')
  await until('turn 9', () => results() > r0, 30_000)
  const rewind = {
    ...target,
    messageId: rewound,
    scope: 'before' as const,
    conversation: true,
    files: false
  }
  seg = begin('rewind', rewind)
  seg.output = await client.chat.rewind.mutate(rewind)
  const branch = await until('conversation-branch', () =>
    state.timeline.find((i) => i?.kind === 'conversation-branch')
  )
  check(
    branch.kind === 'conversation-branch' && branch.reason === 'rewound' && branch.hiddenCount > 0,
    `rewound from another client: ${branch.kind === 'conversation-branch' ? branch.hiddenCount : 0} rows folded`
  )

  // The CLI's command words: live (its `initialize` reply), and kept for the project.
  check(
    state.cliCommandDetails?.goal?.argumentHint === '<condition>',
    'cli-command-details live: /goal <condition>'
  )
  const storedDetails = await client.chat.getCliCommandDetails.query({
    taskId: task.id,
    mode: 'claude-chat'
  })
  check(
    storedDetails?.goal?.description === 'Set a goal Claude keeps working toward',
    'cli command details stored for the project (chat.getCliCommandDetails)'
  )

  // 10: another client (desktop) sends a message with a task artifact attached; the
  // hub checks + seals it and the CLI gets the file as a document block.
  const notes = 'buy milk\n'
  const artifact = await client.artifacts.create.mutate({
    taskId: task.id,
    title: 'notes.txt',
    content: notes
  })
  if (!artifact) throw new Error('artifacts.create returned nothing')
  const file = {
    artifactId: artifact.id,
    name: 'notes.txt',
    kind: 'text' as const,
    mediaType: 'text/plain' as const,
    size: Buffer.byteLength(notes)
  }
  r0 = results()
  const withFile = {
    tabId,
    message: {
      id: 'desk-1',
      content: [
        { type: 'attachment' as const, attachment: file },
        { type: 'text' as const, text: 'Summarize the attached notes' }
      ]
    }
  }
  seg = begin('desktop-send', withFile)
  seg.output = await client.chat.send.mutate(withFile)
  await until('turn 10', () => results() > r0, 30_000)
  const withFiles = state.timeline.find((i) => i?.kind === 'user-text' && i.id === 'desk-1')
  check(
    withFiles?.kind === 'user-text' &&
      withFiles.attachments?.[0]?.name === 'notes.txt' &&
      Boolean(withFiles.attachments[0].contentHash),
    `the message shows its file, sealed by the hub (${JSON.stringify(withFiles && 'attachments' in withFiles ? withFiles.attachments : null)})`
  )
  const written = JSON.stringify(fake.current().runs().at(-1)?.userContents().at(-1))
  check(
    written.includes('buy milk') && written.includes('Summarize the attached notes'),
    `the CLI got the file's text with the message (${written.slice(0, 160)})`
  )

  // reconnect: drop the socket, let the client reconnect + resubscribe → catch-up by seq
  const before = state.timeline.length
  const lastSeq = sync.lastSeq
  begin('reconnect')
  phone.dropSocket()
  await until('resubscribed after reconnect', () => started >= 2, 20_000)
  await loaded
  check(
    state.timeline.length === before && sync.lastSeq === lastSeq,
    `caught up by seq after reconnect (no duplicates, lastSeq ${lastSeq})`
  )

  // The final history, as a fresh phone loads it.
  const finalReplay = await client.chat.getReplay.query({ tabId, afterSeq: -1 })
  let freshState = initialState()
  const fresh = new ChatSync(tabId, {
    dispatch: (a) => {
      freshState = reducer(freshState, a)
    },
    requestFrame: () => undefined,
    cancelFrame: () => undefined
  })
  fresh.completeLoad(fresh.beginLoad('full'), finalReplay)
  const kinds = (s: typeof state): string => s.timeline.map((i) => i?.kind).join(',')
  const same = kinds(freshState) === kinds(state)
  check(same, 'a fresh load replays the same timeline as the live client saw')
  if (!same) console.log(`     live:  ${kinds(state)}\n     fresh: ${kinds(freshState)}`)
  check(
    freshState.prompts.map((p) => p.status).join() === state.prompts.map((p) => p.status).join(),
    'same prompt states on reload'
  )

  const fixture = {
    source:
      'Recorded by packages/apps/mobile/scripts/record-chat-fixture.mts from a SlayZone hub with fake-claude (packages/shared/test-utils/fake-claude) playing scripted turns and the real recorded transcripts permission-bash + ask-user-question: every chat.* message a client subscribed with {tabIds:[tabId]} received, per action.',
    tabId,
    taskId: task.id,
    mode: 'claude-chat',
    cwdPlaceholder: '{{cwd}}',
    segments,
    finalReplay
  }
  const text = JSON.stringify(fixture, null, 1)
    .split(WORK)
    .join('{{cwd}}')
    .split(HOME)
    .join('{{home}}')
  writeFileSync(OUT, `${text}\n`)
  // In the repo's own format (`pnpm lint:format`).
  execFileSync(path.join(REPO, 'node_modules/.bin/biome'), ['format', '--write', OUT], {
    stdio: 'ignore'
  })
  console.log(
    `fixture: ${segments.length} segments, ${segments.reduce((n, s) => n + s.wire.length, 0)} wire messages, final replay ${finalReplay.events.length} events → ${path.relative(REPO, OUT)}`
  )
  for (const s of subs) s.unsubscribe()
  phone.close()
} catch (err) {
  fail(err)
}
finish()
