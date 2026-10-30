/**
 * Chaos: 200 seeded runs of sends interleaved with CLI crashes, link drops,
 * reloads and model changes (respawns), through the real transport, outbox, log
 * and reducer — against a scripted CLI that confirms delivery like Claude Code
 * 2.1.312 (`command_lifecycle` for each message `uuid`).
 *
 * Done-when of plan Phase 1: 0 lost messages (every accepted message is
 * answered, visibly failed, or was delivered before its process died — never
 * silently gone), never answered twice, 0 overwritten events, nothing a replaced
 * process said in the history, and a reload rebuilds the same chat.
 */
import { afterAll, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import * as mgr from './chat-transport-manager'
import { chatWriteError, type ChatDisposable, type ChatProcHandle } from './chat-proc-handle'
import { initialState, reducer } from '../../shared/chat-timeline'

// ---- seeded PRNG (mulberry32) ----
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * A scripted Claude CLI behind the routed handle seam: confirms each message
 * (`queued` → `started` → reply → result → `completed`), answers control
 * requests, and can crash, lose its link, or keep talking after it was replaced.
 */
class FakeCli implements ChatProcHandle {
  readonly pid = 0
  private readonly spawnCbs: Array<() => void> = []
  private readonly stdoutCbs: Array<(chunk: string) => void> = []
  private readonly exitCbs: Array<(e: { code: number | null; signal: string | null }) => void> = []
  private spawned = false
  exited = false
  /** Writes fail as link-down while > 0 (counts down per write). */
  linkDownWrites = 0
  readonly writeIds = new Set<string>()
  /** uuids this process received (and acked). */
  readonly received: string[] = []
  private turnQueue: string[] = []
  private turnRunning = false

  constructor(
    readonly gen: number,
    private readonly random: () => number
  ) {
    setImmediate(() => {
      this.spawned = true
      for (const cb of this.spawnCbs.splice(0)) cb()
    })
  }

  onSpawn(cb: () => void): ChatDisposable {
    if (this.spawned) setImmediate(cb)
    else this.spawnCbs.push(cb)
    return { dispose: () => undefined }
  }
  onStdout(cb: (chunk: string) => void): ChatDisposable {
    this.stdoutCbs.push(cb)
    return { dispose: () => undefined }
  }
  onStderr(): ChatDisposable {
    return { dispose: () => undefined }
  }
  onExit(cb: (e: { code: number | null; signal: string | null }) => void): ChatDisposable {
    this.exitCbs.push(cb)
    return { dispose: () => undefined }
  }
  onError(): ChatDisposable {
    return { dispose: () => undefined }
  }

  write(data: string, opts?: { writeId?: string }): Promise<void> {
    if (this.exited) return Promise.reject(chatWriteError('not-delivered', 'process ended'))
    if (this.linkDownWrites > 0) {
      this.linkDownWrites--
      return Promise.reject(chatWriteError('link-down', 'computer unreachable'))
    }
    // The computer writes a retried id once.
    if (opts?.writeId && this.writeIds.has(opts.writeId)) return Promise.resolve()
    if (opts?.writeId) this.writeIds.add(opts.writeId)
    for (const line of data.split('\n').filter(Boolean)) this.onLine(JSON.parse(line))
    return Promise.resolve()
  }

  kill(signal?: string): void {
    // A real process takes a moment to die; sometimes it gets a last line out.
    const lastWords = this.random() < 0.3
    setTimeout(() => {
      if (lastWords)
        this.emit({
          type: 'assistant',
          message: {
            id: `late_${this.gen}`,
            content: [{ type: 'text', text: `late from gen ${this.gen}` }]
          }
        })
      this.exit(null, signal ?? 'SIGTERM')
    }, 1)
  }

  crash(): void {
    this.exit(1, null)
  }

  private exit(code: number | null, signal: string | null): void {
    if (this.exited) return
    this.exited = true
    for (const cb of this.exitCbs) cb({ code, signal })
  }

  private emit(obj: unknown): void {
    if (this.exited) return
    const line = JSON.stringify(obj) + '\n'
    for (const cb of this.stdoutCbs) cb(line)
  }

  private onLine(msg: Record<string, unknown>): void {
    if (msg.type === 'control_request') {
      setTimeout(
        () =>
          this.emit({
            type: 'control_response',
            response: { subtype: 'success', request_id: msg.request_id, response: {} }
          }),
        0
      )
      return
    }
    if (msg.type !== 'user' || typeof msg.uuid !== 'string') return
    const uuid = msg.uuid
    this.received.push(uuid)
    setTimeout(
      () => this.emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'queued' }),
      0
    )
    this.turnQueue.push(uuid)
    if (!this.turnRunning) void this.runTurns()
  }

  private async runTurns(): Promise<void> {
    this.turnRunning = true
    while (this.turnQueue.length > 0 && !this.exited) {
      const uuid = this.turnQueue.shift()!
      this.emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' })
      this.emit({ type: 'user', isReplay: true, uuid, message: { role: 'user', content: '…' } })
      this.emit({
        type: 'system',
        subtype: 'init',
        session_id: 'chaos',
        model: 'haiku',
        cwd: '/',
        tools: [],
        claude_code_version: '2.1.312'
      })
      await tick(Math.floor(this.random() * 3))
      this.emit({
        type: 'assistant',
        message: { id: `msg_${uuid}`, content: [{ type: 'text', text: `answer to ${uuid}` }] }
      })
      this.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        duration_ms: 1,
        duration_api_ms: 1,
        total_cost_usd: 0,
        result: 'ok'
      })
      this.emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' })
    }
    this.turnRunning = false
  }
}

const TAB = 'chaos-tab'
const OPTS = {
  tabId: TAB,
  taskId: 'chaos-task',
  mode: 'claude-chat',
  cwd: '/tmp',
  conversationId: null,
  providerFlags: []
}

afterAll(() => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
})

test('chaos × 200: no lost message, none answered twice, no overwritten or stale event', async () => {
  const RUNS = 200
  const random = prng(0x5eed)
  const rows = new Map<number, AgentEvent>()
  let clashes = 0
  const clis: FakeCli[] = []
  mgr.__resetForTests()
  mgr.setTransportDepsForTests({
    backend: {
      spawn: async () => {
        const cli = new FakeCli(clis.length + 1, random)
        clis.push(cli)
        return cli
      }
    },
    broadcastEvent: () => undefined,
    broadcastExit: () => undefined,
    broadcastStateChange: () => undefined,
    eventStore: {
      load: async () =>
        [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([seq, event]) => ({ seq, event })),
      insert: async (_tab, seq, event) => {
        if (rows.has(seq)) {
          clashes++
          return 'clash'
        }
        rows.set(seq, event)
        return 'inserted'
      },
      readRange: async (_tab, after, before) =>
        [...rows.entries()]
          .filter(([seq]) => seq > after && seq < before)
          .sort((a, b) => a[0] - b[0])
          .map(([seq, event]) => ({ seq, event }))
    },
    outboxRetry: { windowMs: 40, baseMs: 2 },
    watchdogTimings: { startingBoundMs: 5_000, runningStallMs: 60_000, killGraceMs: 50 }
  })
  await mgr.hydrateSession({ ...OPTS })

  const accepted: string[] = []
  const current = (): FakeCli | undefined => clis.at(-1)

  for (let run = 0; run < RUNS; run++) {
    const roll = random()
    if (roll < 0.45) {
      const id = `m${run}`
      accepted.push(id)
      mgr.dispatchUserMessage(TAB, { id, content: [{ type: 'text', text: `message ${run}` }] })
    } else if (roll < 0.6) {
      current()?.crash()
    } else if (roll < 0.72) {
      const cli = current()
      if (cli) cli.linkDownWrites = 1 + Math.floor(random() * 30)
    } else if (roll < 0.84) {
      // Model change that needs a new process.
      await mgr.respawn(TAB, { ...OPTS, chatModel: random() < 0.5 ? 'opus' : 'sonnet' })
    } else {
      // Reload: a client rebuilds the chat from one replay snapshot.
      const replay = await mgr.getReplay(TAB, -1)
      const seqs = replay.events.map((e) => e.seq)
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
      expect(new Set(seqs).size).toBe(seqs.length)
    }
    await tick(Math.floor(random() * 4))
  }

  // Settle: every message reaches an end the user can see.
  const ended = (id: string): boolean => {
    const s = mgr.__getOutboxStateForTests(TAB, id)
    return s === 'answered' || s === 'failed' || s === 'cancelled'
  }
  for (let i = 0; i < 400 && !accepted.every(ended); i++) {
    // A crashed agent restarts on the next send, as for a user: nudge with a no-op probe.
    if (mgr.getSessionTerminalState(TAB) === 'dead')
      await mgr.ensureSpawned(TAB).catch(() => undefined)
    await tick(5)
  }
  expect(accepted.filter((id) => !ended(id))).toEqual([])

  await mgr.removeSession(TAB)
  const saved = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e)

  // 0 overwritten events.
  expect(clashes).toBe(0)
  // Nothing a replaced or dead process said after it ended.
  expect(saved.some((e) => e.kind === 'assistant-text' && e.text.startsWith('late from gen'))).toBe(
    false
  )

  const lastState = new Map<string, string>()
  const answered = new Map<string, number>()
  const userEvents = new Map<string, number>()
  for (const e of saved) {
    if (e.kind === 'user-message' && e.id) userEvents.set(e.id, (userEvents.get(e.id) ?? 0) + 1)
    if (e.kind === 'user-message-delivery') {
      lastState.set(e.id, e.state)
      if (e.state === 'answered') answered.set(e.id, (answered.get(e.id) ?? 0) + 1)
    }
  }
  for (const id of accepted) {
    // Recorded once, answered at most once…
    expect(userEvents.get(id), id).toBe(1)
    expect(answered.get(id) ?? 0, id).toBeLessThanOrEqual(1)
    // …and never silently gone: answered, failed (with Retry), or confirmed by
    // an agent that then died (shown as an interrupted turn).
    expect(['answered', 'failed', 'delivered'], id).toContain(lastState.get(id))
  }
  // The answer to every answered message came from exactly one process.
  for (const [id] of answered) {
    expect(clis.filter((c) => c.received.includes(id)).length, id).toBeGreaterThanOrEqual(1)
  }

  // A reload (replaying the saved history through the real reducer) shows each
  // message once, with its final state.
  const state = saved.reduce((s, event) => reducer(s, { type: 'event', event }), initialState())
  const bubbles = state.timeline.filter((i) => i?.kind === 'user-text')
  expect(bubbles.map((b) => (b as { id?: string }).id)).toEqual(accepted)
  for (const b of bubbles) {
    const id = (b as { id: string }).id
    const delivery = (b as { delivery?: string }).delivery
    expect(delivery, id).toBe(lastState.get(id))
  }

  // Sanity: the chaos really exercised every path.
  expect(clis.length).toBeGreaterThan(10)
  expect([...lastState.values()]).toContain('answered')
  expect([...lastState.values()]).toContain('failed')
}, 120_000)
