/**
 * The phone's agents code against two real hubs at once — the check no jest suite can
 * make. Not run by any test suite.
 *
 *   pnpm --filter @slayzone/hub build && pnpm --filter @slayzone/computer build
 *   pnpm exec tsx packages/apps/mobile/scripts/two-hub-agents.mts   # repo root
 *
 * Boots hubs a (127.0.0.1:47861) and b (:47862), each with a computer enrolled for a
 * phone account of its own (`test-hub.mts`), and runs the app's own modules:
 * - `agents/lifecycle.ts`: `task.startMainAgent` twice at once + once later (one start,
 *   the same session), Stop (`pty.kill`);
 * - `terminal/terminal-feed.ts`: `pty.onData` subscribed first, then `pty.attach`; a
 *   catch-up after a resubscribe and a late attach duplicate nothing;
 * - the session size: a desktop-style `pty.resize` reaches the phone by `pty.onResize`
 *   and `pty.attach` reports it;
 * - `agents/hub-agents.ts` `mergeHubAgents` over each hub's session state, kept by the
 *   shared rules (`@slayzone/terminal/terminal-state`) as `use-hub-agent-sessions.ts`
 *   keeps it: one row per hub, tagged with its hub; a stop moves only that hub's row.
 * Agents are plain shells (terminal mode `terminal`): no agent CLI needed.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { TerminalState } from '@slayzone/terminal-contracts'
import {
  applyExit,
  applyStateChange,
  EMPTY_TERMINAL_STATE,
  reconcile,
  type TerminalStateData,
  type TerminalStatePatch
} from '@slayzone/terminal/terminal-state'
import { mergeHubAgents } from '../src/agents/hub-agents.ts'
import { startAgent, stopAgent } from '../src/agents/lifecycle.ts'
import type { HubFeed } from '../src/hub-board.ts'
import { type FeedClient, TerminalFeed } from '../src/terminal/terminal-feed.ts'
import {
  check,
  createProject,
  fail,
  finish,
  freshStateDir,
  type PhoneHub,
  signInPhone,
  sleep,
  startTestHub,
  until
} from './test-hub.mts'

// The hubs' ports: the first two arguments, else 47861 and 47862.
const PORTS = [Number(process.argv[2] ?? 47861), Number(process.argv[3] ?? 47862)]

const dir = freshStateDir('two-hub-agents')

try {
  // Two hubs, each with its own phone account and computer; one project + task each.
  const hubs: Array<{ phone: PhoneHub; taskId: string }> = []
  for (const [i, name] of ['a', 'b'].entries()) {
    const hubDir = path.join(dir, name)
    const work = path.join(hubDir, 'home', 'work')
    mkdirSync(work, { recursive: true })
    const hub = await startTestHub({ name: `mobile-agents-${name}`, port: PORTS[i], dir: hubDir })
    const account = await hub.createUser(`mobile@agents-${name}.test`)
    hub.startComputer({ forUser: account.email, allowedRoot: path.join(hubDir, 'home') })
    const phone = await signInPhone(hub.address, account)
    const project = await createProject(phone.client, {
      name: `Project on hub ${name.toUpperCase()}`,
      color: name === 'a' ? '#8b5cf6' : '#10b981',
      path: work
    })
    const task = await phone.client.task.create.mutate({
      projectId: project.id,
      title: `${name.toUpperCase()}: first task`,
      terminalMode: 'terminal'
    })
    hubs.push({ phone, taskId: task.id })
  }
  check(hubs.length === 2, 'signed in to two hubs, a task on each')
  const sid = (i: number): string => `${hubs[i].taskId}:${hubs[i].taskId}`

  // Each hub's agent sessions: the shared rules over pushes + a snapshot.
  const states: TerminalStateData[] = hubs.map(() => ({ ...EMPTY_TERMINAL_STATE }))
  const apply = (i: number, patch: TerminalStatePatch): void => {
    states[i] = { ...states[i], ...patch }
  }
  const unsubscribe: Array<() => void> = []
  for (const [i, { phone }] of hubs.entries()) {
    unsubscribe.push(
      phone.client.pty.onStateChange.subscribe(undefined, {
        onData: (e) =>
          apply(
            i,
            applyStateChange(states[i], e.sessionId, e.newState as TerminalState, Date.now())
          )
      }).unsubscribe,
      phone.client.pty.onExit.subscribe(undefined, {
        onData: (e) => apply(i, applyExit(states[i], e.sessionId, Date.now()))
      }).unsubscribe
    )
  }
  const snapshot = async (i: number): Promise<void> => {
    const at = Date.now()
    const [sessions, hibernated] = await Promise.all([
      hubs[i].phone.client.pty.sessionList.query(),
      hubs[i].phone.client.taskTerminals.listHibernatedSessions.query()
    ])
    apply(i, reconcile(states[i], sessions, hibernated, at))
  }

  // 1. The feed: subscribe pty.onData FIRST, then start the agent, then attach.
  const a = hubs[0].phone.client
  const out: string[] = []
  const sizes: string[] = []
  let resets = 0
  const sink = {
    reset: () => {
      resets++
      out.length = 0
    },
    write: (d: string) => void out.push(d),
    resize: (c: number, r: number) => void sizes.push(`${c}x${r}`)
  }
  const feedClient: FeedClient = {
    attach: (s, after) => a.pty.attach.query({ sessionId: s, afterSeq: after }),
    bufferSince: (s, after) => a.pty.getBufferSince.query({ sessionId: s, afterSeq: after })
  }
  const feed = new TerminalFeed(sid(0), feedClient, sink)
  let dataStarted = false
  const dataSub = a.pty.onData.subscribe(
    { sessionIds: [sid(0)] },
    {
      onStarted: () => {
        dataStarted = true
      },
      onData: (e) => feed.data(e.seq, e.data)
    }
  )
  const resizeSub = a.pty.onResize.subscribe(undefined, {
    onData: (e) => {
      if (e.sessionId === sid(0)) feed.resize(e.cols, e.rows)
    }
  })
  await until('onData subscription started', () => dataStarted)

  // 2. startMainAgent from the phone's lifecycle code: two at once, then a third.
  const [first, second] = await Promise.all([
    startAgent(a, hubs[0].taskId),
    startAgent(a, hubs[0].taskId)
  ])
  const third = await startAgent(a, hubs[0].taskId)
  check(
    [first, second, third].every((r) => r.sessionId === sid(0)),
    `every start answers the main session ${sid(0)}`
  )
  check(
    [first, second].filter((r) => r.started).length === 1 && third.started === false,
    'exactly one call started it; the concurrent one joined, the later one found it live'
  )
  check(
    first.kind === 'pty' && first.mode === 'terminal',
    `a terminal agent (${first.kind}, ${first.mode})`
  )

  await feed.start()
  await until('shell output', () => out.join('').length > 0, 15_000)
  check(sizes[0] !== undefined, `attached at the session's size (${sizes[0]})`)

  // 3. Write (what the key bar / text field do) and read it back exactly once.
  await a.pty.write.mutate({ sessionId: sid(0), data: 'echo P1MARK_$((6*7))\r' })
  const marks = (text: string[]): number => (text.join('').match(/P1MARK_42/g) ?? []).length
  await until('echo output', () => marks(out) >= 1)
  check(marks(out) === 1, `the written command ran; its output arrived once (${marks(out)}×)`)
  // A resubscribe (what a reconnect does): catch up, no duplicates.
  await feed.start()
  await sleep(300)
  check(
    marks(out) === 1 && resets === 1,
    `catch-up after a reconnect duplicated nothing (${marks(out)}×, ${resets} attach)`
  )
  // A second phone attaching now gets the full buffer, the output once.
  const out2: string[] = []
  const late = new TerminalFeed(sid(0), feedClient, {
    reset: () => undefined,
    write: (d) => void out2.push(d),
    resize: () => undefined
  })
  await late.start()
  check(marks(out2) === 1, 'a later attach replays the buffer, output once')

  // 4. The session size: a desktop resizes → the phone follows (it never resizes itself).
  await a.pty.resize.mutate({ sessionId: sid(0), cols: 101, rows: 33 })
  await until('resize push', () => sizes.includes('101x33'))
  check(sizes.at(-1) === '101x33', `pty.onResize delivered the new size (${sizes.join(' → ')})`)
  const reattach = await a.pty.attach.query({ sessionId: sid(0), afterSeq: 0 })
  check(
    reattach.size?.cols === 101 && reattach.size?.rows === 33,
    `attach reports the size (${JSON.stringify(reattach.size)})`
  )

  // 5. Hub b's agent too, then the merged status list.
  const startedB = await startAgent(hubs[1].phone.client, hubs[1].taskId)
  check(
    startedB.started && startedB.sessionId === sid(1),
    'hub b: agent started through its own hub'
  )
  await Promise.all([snapshot(0), snapshot(1)])
  await until('both running', () =>
    [0, 1].every((i) => ['running', 'idle', 'starting'].includes(states[i].byId[sid(i)] ?? ''))
  )
  const feeds = async (): Promise<HubFeed[]> => {
    const boards = await Promise.all(hubs.map((h) => h.phone.client.task.loadBoardData.query()))
    return hubs.map((h, i) => ({
      hub: h.phone.entry,
      connection: { status: 'open', error: null },
      stalled: false,
      board: { data: boards[i], pending: false, error: null, refreshing: false },
      agents: { state: states[i], loaded: true, error: null }
    }))
  }
  let rows = mergeHubAgents(await feeds())
  for (const r of rows)
    console.log(`     agent  ${r.hubLabel}  ${r.task.title}  ${r.state} → ${r.group}`)
  check(rows.length === 2, `one agent row per hub's task (${rows.length})`)
  check(
    rows.every((r) => r.task.id === hubs[r.hubId === hubs[0].phone.entry.id ? 0 : 1].taskId),
    'each row tagged with the hub that owns it'
  )

  // 6. Stop from the phone: the exit push moves the row to "done" on that hub only.
  await stopAgent(a, { taskId: hubs[0].taskId, tabId: hubs[0].taskId, mode: 'terminal' })
  await until('exit push', () => states[0].byId[sid(0)] === 'dead')
  rows = mergeHubAgents(await feeds())
  const rowA = rows.find((r) => r.hubId === hubs[0].phone.entry.id)
  const rowB = rows.find((r) => r.hubId === hubs[1].phone.entry.id)
  check(
    rowA?.state === 'dead' && rowA.group === 'done',
    `hub a's agent stopped → ${rowA?.state}/${rowA?.group}`
  )
  check(rowB !== undefined && rowB.state !== 'dead', `hub b's agent untouched (${rowB?.state})`)

  // Clean up: stop hub b's agent, close everything.
  await stopAgent(hubs[1].phone.client, {
    taskId: hubs[1].taskId,
    tabId: hubs[1].taskId,
    mode: 'terminal'
  })
  feed.dispose()
  late.dispose()
  dataSub.unsubscribe()
  resizeSub.unsubscribe()
  for (const u of unsubscribe) u()
  for (const h of hubs) h.phone.close()
} catch (err) {
  fail(err)
}
finish()
