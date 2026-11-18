/**
 * Randomized host + agent sequences through the real transport. A simulated
 * Claude Code follows the CLI's measured protocol (2.1.326): a written message is
 * `queued`, then `started` (with its replay) once no turn runs; a turn ends with
 * its result, then `completed`; an interrupt ends it with an aborted result and
 * `cancelled`; a turn the CLI starts by itself has no `started`; a queued
 * message can be withdrawn (`cancel_async_message`). The host sends, stops,
 * answers prompts and respawns at random points.
 *
 * Every step is checked by the strict lifecycle check (the model and the runtime
 * must agree), in both lifecycle modes; every run must end settled and ready.
 */
import { afterEach, expect, test } from 'vitest'
import * as mgr from './chat-transport-manager'
import {
  emitLine,
  type FakeChild,
  sj,
  startTab,
  TAB_OPTS,
  transportHarness,
  type TransportHarness,
  until,
  wait
} from './chat-transport-testkit'

afterEach(() => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
})

const TAB = TAB_OPTS.tabId
const respawnOpts = async () => ({ ...TAB_OPTS })

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One simulated Claude Code process. */
class Agent {
  /** The running turn: the message it answers, or null for a self-started one. */
  turn: { owner: string | null } | null = null
  readonly queue: string[] = []
  readonly prompts = new Set<string>()
  readonly helpers = new Set<string>()
  private seen = 0
  private serial = 0

  constructor(readonly f: FakeChild) {
    f.answer('interrupt', () => {
      setImmediate(() => this.interrupted())
      return { success: { still_queued: [] } }
    })
    f.answer('cancel_async_message', (req) => {
      const id = String(req.message_uuid)
      const at = this.queue.indexOf(id)
      if (at < 0) return { success: { cancelled: false } }
      this.queue.splice(at, 1)
      setImmediate(() => emitLine(this.f, sj.lifecycle(id, 'cancelled')))
      return { success: { cancelled: true } }
    })
  }

  /** Take every message written since the last look (a write happens after its baseline). */
  pump(): void {
    const users = this.f.stdin.filter((m) => m.type === 'user' && typeof m.uuid === 'string')
    for (const m of users.slice(this.seen)) {
      const id = m.uuid as string
      this.queue.push(id)
      emitLine(this.f, sj.lifecycle(id, 'queued'))
    }
    this.seen = users.length
    this.next()
  }

  private next(): void {
    if (this.turn || !this.queue.length) return
    const id = this.queue.shift()!
    this.turn = { owner: id }
    emitLine(this.f, sj.lifecycle(id, 'started'))
    emitLine(this.f, { type: 'user', isReplay: true, uuid: id, message: { content: 'x' } })
  }

  selfStart(): void {
    if (this.turn || this.queue.length) return
    this.turn = { owner: null }
    emitLine(this.f, sj.init('fuzz-session'))
    emitLine(this.f, sj.text('on my own', { id: `self-${++this.serial}` }))
  }

  output(): void {
    if (!this.turn || this.prompts.size) return
    emitLine(this.f, sj.text('working', { id: `msg-${++this.serial}` }))
  }

  ask(): void {
    if (!this.turn) return
    const id = `p-${++this.serial}`
    this.prompts.add(id)
    emitLine(this.f, sj.toolUse(`tool-${id}`))
    emitLine(this.f, sj.canUseTool(id, `tool-${id}`))
  }

  launch(): void {
    if (!this.turn || this.prompts.size) return
    const id = `helper-${++this.serial}`
    this.helpers.add(id)
    emitLine(this.f, sj.toolUse(id, 'Agent', { prompt: 'x', run_in_background: true }))
    emitLine(this.f, {
      type: 'system',
      subtype: 'task_started',
      task_id: id,
      tool_use_id: id,
      description: id,
      task_type: 'local_agent'
    })
    emitLine(this.f, {
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'launched' }] },
      tool_use_result: { isAsync: true, status: 'async_launched', agentId: id }
    })
  }

  finishHelper(): void {
    const id = [...this.helpers][0]
    if (!id) return
    this.helpers.delete(id)
    emitLine(this.f, {
      type: 'system',
      subtype: 'task_notification',
      task_id: id,
      tool_use_id: id,
      status: 'completed',
      summary: 'done'
    })
  }

  finish(): void {
    if (!this.turn || this.prompts.size) return
    const owner = this.turn.owner
    emitLine(this.f, sj.success())
    if (owner) emitLine(this.f, sj.lifecycle(owner, 'completed'))
    this.turn = null
    this.next()
  }

  private interrupted(): void {
    if (!this.turn) return
    const owner = this.turn.owner
    for (const id of this.prompts) emitLine(this.f, sj.cancel(id))
    this.prompts.clear()
    emitLine(this.f, sj.aborted())
    if (owner) emitLine(this.f, sj.lifecycle(owner, 'cancelled'))
    this.turn = null
    this.next()
  }
}

async function settle(): Promise<void> {
  await mgr.__flushEventsForTests(TAB)
  await new Promise((r) => setImmediate(r))
  await mgr.__flushEventsForTests(TAB)
}

async function run(seed: number, mode: 'shadow' | 'authoritative'): Promise<void> {
  const h: TransportHarness = transportHarness()
  await startTab({ lifecycleMode: mode } as never)
  const random = seeded(seed)
  let agent = new Agent(h.fakes[0])
  let sent = 0
  const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]

  for (let step = 0; step < 48; step++) {
    if (h.fakes.at(-1) !== agent.f) agent = new Agent(h.fakes.at(-1)!)
    const actions: Array<() => Promise<void> | void> = [
      async () => {
        await mgr.dispatchUserMessage(TAB, {
          id: `m${++sent}`,
          content: [{ type: 'text', text: 'hi' }]
        })
      },
      () => agent.output(),
      () => agent.ask(),
      () => agent.launch(),
      () => agent.finishHelper(),
      () => agent.finish(),
      () => agent.selfStart(),
      async () => {
        const id = pick([...agent.prompts])
        if (!id) return
        agent.prompts.delete(id)
        mgr.respondToPermissionRequest(TAB, {
          requestId: id,
          decision: { behavior: 'allow', updatedInput: {} }
        })
      },
      async () => {
        await mgr.stopTurn(TAB, {
          restorePrompt: random() < 0.5,
          respawnOpts,
          interruptTimeoutMs: 200
        })
      }
    ]
    if (random() < 0.04) {
      actions.push(async () => {
        await mgr.respawn(TAB, { ...TAB_OPTS })
      })
    }
    await pick(actions)()
    await settle()
    agent.pump()
    await settle()
  }

  // Settle: every prompt answered, every turn and helper ended, nothing queued.
  for (let i = 0; i < 20; i++) {
    if (h.fakes.at(-1) !== agent.f) agent = new Agent(h.fakes.at(-1)!)
    agent.pump()
    for (const id of agent.prompts) {
      mgr.respondToPermissionRequest(TAB, {
        requestId: id,
        decision: { behavior: 'allow', updatedInput: {} }
      })
    }
    agent.prompts.clear()
    agent.finish()
    agent.finishHelper()
    await settle()
    await wait(5)
  }
  await until(() => mgr.isReadyForQueuedMessage(TAB), 3000)
  expect(mgr.getTurnStatus(TAB)).toMatchObject({
    state: 'idle',
    turnOpen: false,
    pendingRequestIds: [],
    outboxInFlight: 0
  })
}

test.each(
  (['shadow', 'authoritative'] as const).flatMap((mode) =>
    Array.from({ length: 48 }, (_, i) => ({ mode, seed: 0xc4a7 + i }))
  )
)(
  'randomized host and agent actions: model and runtime agree ($mode, seed $seed)',
  async ({ mode, seed }) => {
    await run(seed, mode)
  }
)
