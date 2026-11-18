/**
 * Observable lifecycle contract, independent of the transport's transition code.
 * Synthetic provider traces exercise the real transport and both client paths:
 * live events and a freshly opened replay. Seeds and action histories reproduce
 * failures without recording private conversations or relying on timing luck.
 */
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { claudeChatBackend } from '../agents/claude-session-driver'
import { claudeCodeAdapter } from '../agents/claude-code-adapter'
import type { ChatSessionDriver } from '../agents/types'
import type { ChatTimelineState } from '../../shared/chat-timeline'
import { initialState, isTurnOpen, reducer, replayIndexProblems } from '../../shared/chat-timeline'
import { selectBackgroundSubAgents } from '../../shared/background-sub-agents'
import * as mgr from './chat-transport-manager'
import {
  emitLine,
  sendAndStart,
  sj,
  startTab,
  TAB_OPTS,
  transportHarness,
  until,
  type FakeChild,
  type TransportHarness
} from './chat-transport-testkit'

afterEach(() => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
})

const SESSION = `${TAB_OPTS.taskId}:${TAB_OPTS.tabId}`
// Saved events publish after their storage commit, and output a pending publication
// holds is spooled: settle both, then the turn the drainer/observer schedules.
const flush = async (): Promise<void> => {
  await mgr.__flushEventsForTests(TAB_OPTS.tabId)
  await new Promise((resolve) => setImmediate(resolve))
}
const sorted = (values: Iterable<string>): string[] => [...values].sort()
const helperStart = (id: string) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: id,
  tool_use_id: id,
  description: id,
  task_type: 'local_agent'
})
const helperEnd = (id: string) => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: id,
  tool_use_id: id,
  status: 'completed',
  summary: 'synthetic result'
})

function view(state: ChatTimelineState) {
  return {
    open: isTurnOpen(state),
    prompts: sorted(state.pendingPrompts.map((i) => state.prompts[i].requestId)),
    helpers: sorted(
      state.inFlightSubAgents.flatMap((i) => {
        const row = state.timeline[i]
        return row?.kind === 'sub-agent' ? [row.toolUseId] : []
      })
    ),
    messages: state.timeline.flatMap((row) =>
      row?.kind === 'user-text' && row.id ? [{ id: row.id, delivery: row.delivery }] : []
    ),
    replies: state.timeline.flatMap((row) => (row?.kind === 'text' ? [row.text] : []))
  }
}

/** Expected behavior is driven by user/provider actions, never production reducers. */
class Contract {
  open = false
  activeUser: string | null = null
  readonly prompts = new Set<string>()
  readonly helpers = new Set<string>()
  readonly completedHelpers: string[] = []
  readonly users: string[] = []
  readonly actions: string[] = []
  private live = initialState({ agentStartedTurns: true })
  private cursor = 0
  private serial = 0

  constructor(
    readonly h: TransportHarness,
    public child: FakeChild
  ) {}

  async check(action: string): Promise<void> {
    this.actions.push(action)
    await flush()
    for (const b of this.h.broadcasts.slice(this.cursor)) {
      this.live = reducer(this.live, {
        type: 'event',
        event: b.event,
        at: b.at,
        ...(b.live === undefined ? { seq: b.seq } : {})
      })
    }
    this.cursor = this.h.broadcasts.length
    const context = this.actions.join(' → ')
    const status = mgr.getTurnStatus(TAB_OPTS.tabId)!
    expect(status.state, context).toBe(this.open && this.prompts.size === 0 ? 'running' : 'idle')
    expect(sorted(status.pendingRequestIds), context).toEqual(sorted(this.prompts))
    expect(status.turnOpen, context).toBe(this.open || this.prompts.size > 0)
    expect(mgr.isReadyForQueuedMessage(TAB_OPTS.tabId), context).toBe(
      !this.open && this.prompts.size === 0
    )
    expect(mgr.getChatSessionState(SESSION), context).toBe(
      this.open && this.prompts.size === 0
        ? 'running'
        : this.prompts.size
          ? 'idle'
          : this.helpers.size
            ? 'background'
            : 'idle'
    )

    const actual = view(this.live)
    expect(actual.open, context).toBe(this.open)
    expect(actual.prompts, context).toEqual(sorted(this.prompts))
    expect(actual.helpers, context).toEqual(sorted(this.helpers))
    expect(
      actual.messages.map((m) => m.id),
      context
    ).toEqual(this.users)
    expect(replayIndexProblems(this.live), context).toEqual([])
    const shadow = mgr.__getLifecycleShadowForTests(TAB_OPTS.tabId)
    expect(shadow?.disabled, context).toBe(false)
    expect(shadow?.snapshot.state, context).toBe(status.state)
    expect(shadow?.snapshot.turnOpen, context).toBe(status.turnOpen)
    expect(shadow?.mismatches, context).toBe(0)
    if (!this.open) {
      expect(sorted(selectBackgroundSubAgents(this.live).map((h) => h.toolUseId)), context).toEqual(
        sorted(this.helpers)
      )
    }

    const replay = await mgr.getReplay(TAB_OPTS.tabId, -1)
    let restored = reducer(initialState({ agentStartedTurns: true }), {
      type: 'events',
      events: replay.events.map((e) => e.event),
      seq: replay.events.map((e) => e.seq),
      at: replay.events.map((e) => e.at)
    })
    restored = reducer(restored, { type: 'events', events: replay.live.events })
    expect(view(restored), context).toEqual(actual)
    expect(replayIndexProblems(restored), context).toEqual([])
    const seqs = replay.events.map((e) => e.seq)
    expect(seqs, context).toEqual([...new Set(seqs)].sort((a, b) => a - b))
  }

  async start(): Promise<void> {
    const id = `user-${++this.serial}`
    this.open = true
    this.activeUser = id
    this.users.push(id)
    await sendAndStart(this.child, id)
    await this.check(`send ${id}`)
  }

  async finish(): Promise<void> {
    emitLine(this.child, sj.success())
    if (this.activeUser) emitLine(this.child, sj.lifecycle(this.activeUser, 'completed'))
    this.open = false
    this.activeUser = null
    this.prompts.clear()
    await this.check('main result')
  }

  async launch(): Promise<void> {
    const id = `helper-${++this.serial}`
    this.helpers.add(id)
    emitLine(this.child, sj.toolUse(id, 'Agent', { prompt: 'synthetic', run_in_background: true }))
    emitLine(this.child, helperStart(id))
    emitLine(this.child, {
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'launched' }] },
      tool_use_result: { isAsync: true, status: 'async_launched', agentId: id }
    })
    await this.check(`launch ${id}`)
  }

  async childProgress(id: string): Promise<void> {
    const tool = `tool-${++this.serial}`
    emitLine(this.child, { ...sj.toolUse(tool), parent_tool_use_id: id })
    emitLine(this.child, {
      ...sj.text('synthetic child output', { id: `reply-${tool}` }),
      parent_tool_use_id: id
    })
    emitLine(this.child, {
      type: 'user',
      parent_tool_use_id: id,
      message: { content: [{ type: 'tool_result', tool_use_id: tool, content: 'done' }] }
    })
    await this.check(`child tool ${id}`)
  }

  async finishHelper(id: string): Promise<void> {
    emitLine(this.child, helperEnd(id))
    if (this.helpers.delete(id)) this.completedHelpers.push(id)
    await this.check(`helper result ${id}`)
  }

  async ask(): Promise<void> {
    const id = `prompt-${++this.serial}`
    this.prompts.add(id)
    emitLine(this.child, sj.canUseTool(id, `tool-${id}`))
    await this.check(`ask ${id}`)
  }

  async answer(id: string): Promise<void> {
    expect(
      mgr.respondToPermissionRequest(TAB_OPTS.tabId, {
        requestId: id,
        decision: { behavior: 'allow', updatedInput: {} }
      })
    ).toBe(true)
    this.prompts.delete(id)
    await this.check(`answer ${id}`)
  }

  async withdraw(id: string): Promise<void> {
    emitLine(this.child, sj.cancel(id))
    this.prompts.delete(id)
    // A withdrawn last request can be followed by the provider resuming output.
    // Withdrawal alone does not promise that the provider resumed its turn. A
    // background helper's withdrawn prompt resumes no main turn.
    if (!this.prompts.size && this.open)
      emitLine(this.child, sj.text('continuing', { id: `resume-${++this.serial}` }))
    await this.check(`withdraw ${id}`)
  }

  async progress(): Promise<void> {
    emitLine(this.child, sj.toolUse(`parallel-${++this.serial}`))
    await this.check('main tool progress')
  }

  async metadata(): Promise<void> {
    emitLine(this.child, sj.init('contract-session'))
    await this.check('session metadata')
  }

  async stop(): Promise<void> {
    const results = this.h.savedKinds().filter((kind) => kind === 'result').length
    const user = this.activeUser
    this.child.answer('interrupt', () => {
      setImmediate(() => {
        emitLine(this.child, sj.aborted())
        if (user) emitLine(this.child, sj.lifecycle(user, 'completed'))
      })
      return { success: { still_queued: [] } }
    })
    await mgr.stopTurn(TAB_OPTS.tabId, {
      restorePrompt: false,
      respawnOpts: async () => ({ ...TAB_OPTS })
    })
    await until(() => this.h.savedKinds().filter((kind) => kind === 'result').length > results)
    this.open = false
    this.activeUser = null
    this.prompts.clear()
    await this.check('Stop + provider aborted result')
  }
}

/** `authoritative`: the lifecycle model is the server's status; the runtime agrees with it. */
type Mode = 'shadow' | 'authoritative'
const MODES: Mode[] = ['shadow', 'authoritative']

async function contract(mode: Mode = 'shadow'): Promise<Contract> {
  const h = transportHarness()
  await startTab({ lifecycleMode: mode } as never)
  const c = new Contract(h, h.fakes[0])
  await c.metadata()
  return c
}

test('observed stale-spinner trace: live status, queue, helper indicator, and replay agree', async () => {
  const c = await contract()
  await c.start()
  await c.launch()
  await c.finish()
  const [helper] = c.helpers
  await c.childProgress(helper)
  await c.start()
  await c.finishHelper(helper)
  await c.finishHelper(helper) // duplicate notification cannot close the newer main turn
  await c.finish()
})

/** Every ordering that preserves each actor's own causal order. */
function interleave<T>(left: T[], right: T[]): T[][] {
  if (!left.length) return [right]
  if (!right.length) return [left]
  return [
    ...interleave(left.slice(1), right).map((tail) => [left[0], ...tail]),
    ...interleave(left, right.slice(1)).map((tail) => [right[0], ...tail])
  ]
}

test.each(
  MODES.flatMap((mode) =>
    interleave(['main end', 'next start', 'next end'], ['child tool', 'child end']).map(
      (order) => ({ name: `${mode}: ${order.join(' → ')}`, order, mode })
    )
  )
)('all parent/child race orderings: $name', async ({ order, mode }) => {
  const c = await contract(mode)
  await c.start()
  await c.launch()
  const [helper] = c.helpers
  for (const action of order) {
    if (action === 'next start') await c.start()
    else if (action === 'child tool') await c.childProgress(helper)
    else if (action === 'child end') await c.finishHelper(helper)
    else await c.finish()
  }
  await c.check('fully settled')
})

test('parallel prompts remain visible until each answer or withdrawal, despite child progress', async () => {
  const c = await contract()
  await c.start()
  await c.launch()
  await c.ask()
  await c.ask()
  await c.childProgress([...c.helpers][0])
  await c.progress()
  await c.answer([...c.prompts][0])
  await c.childProgress([...c.helpers][0])
  await c.withdraw([...c.prompts][0])
  await c.finish()
  await c.finishHelper([...c.helpers][0])
})

test('Stop settles the main turn without erasing its background helper or losing its replay', async () => {
  const c = await contract()
  await c.start()
  await c.launch()
  await c.ask()
  await c.stop()
  await c.childProgress([...c.helpers][0])
  await c.finishHelper([...c.helpers][0])
  await c.start()
  await c.finish()
})

test('replaced process cannot overwrite a new turn with late tools, prompts, or completion', async () => {
  const c = await contract()
  await c.start()
  await c.finish()
  const old = c.child
  await mgr.respawn(TAB_OPTS.tabId, { ...TAB_OPTS })
  c.child = c.h.fakes.at(-1)!
  await c.metadata()
  await c.start()
  const before = c.h.broadcasts.length
  emitLine(old, sj.toolUse('stale-tool'))
  emitLine(old, sj.canUseTool('stale-prompt', 'stale-tool'))
  emitLine(old, sj.success('stale result'))
  await c.check('late events from replaced process')
  expect(c.h.broadcasts).toHaveLength(before)
  await c.finish()
})

test('legacy mode disables the observer for the whole session without changing behavior', async () => {
  const h = transportHarness()
  await mgr.hydrateSession({ ...TAB_OPTS, lifecycleMode: 'legacy' })
  await mgr.ensureSpawned(TAB_OPTS.tabId)
  expect(mgr.__getLifecycleShadowForTests(TAB_OPTS.tabId)).toBeNull()
  await sendAndStart(h.fakes[0], 'legacy-user')
  expect(mgr.getTurnStatus(TAB_OPTS.tabId)).toMatchObject({ state: 'running', turnOpen: true })
  emitLine(h.fakes[0], sj.success())
  emitLine(h.fakes[0], sj.lifecycle('legacy-user', 'completed'))
  await until(() => mgr.isReadyForQueuedMessage(TAB_OPTS.tabId))
  expect(mgr.__getLifecycleShadowForTests(TAB_OPTS.tabId)).toBeNull()
})

test('answering a background-only prompt leaves the closed main turn idle', async () => {
  const c = await contract()
  await c.metadata()
  await c.start()
  await c.launch()
  await c.finish()
  const [helper] = c.helpers
  await c.ask()
  await c.answer([...c.prompts][0])
  await c.childProgress(helper)
  await c.finishHelper(helper)
  await c.start()
  await c.finish()
})

test('a delayed native acknowledgement updates shadow delivery without another provider event', async () => {
  const h = transportHarness()
  await startTab()
  await sendAndStart(h.fakes[0], 'delayed-ack')
  emitLine(h.fakes[0], sj.success())
  await until(() => mgr.getSessionTerminalState(TAB_OPTS.tabId) === 'idle')
  await flush()
  expect(mgr.__getLifecycleShadowForTests(TAB_OPTS.tabId)?.snapshot).toMatchObject({
    state: 'idle',
    outboxInFlight: 1,
    turnOpen: true,
    readyForMessage: false
  })
  emitLine(h.fakes[0], sj.lifecycle('delayed-ack', 'completed'))
  await flush()
  expect(mgr.__getLifecycleShadowForTests(TAB_OPTS.tabId)?.snapshot).toMatchObject({
    state: 'idle',
    outboxInFlight: 0,
    turnOpen: false,
    readyForMessage: true
  })
  expect(mgr.__getLifecycleShadowForTests(TAB_OPTS.tabId)?.mismatches).toBe(0)
})

test('transport ownership independently fences stale normalized root events before prompts, delivery and streaming', async () => {
  let emit!: (event: AgentEvent) => void
  const execution = (id: string) => ({
    turnId: `native-${id}`,
    messageId: id,
    source: 'provider' as const
  })
  const fake: ChatSessionDriver = {
    start(ctx) {
      emit = ctx.emit
    },
    handleLine() {},
    sendUserMessage() {},
    dispose() {},
    extractSessionId: () => null,
    async sendUserTurn(message) {
      emit({ kind: 'turn-started', execution: execution(message.id) })
    }
  }
  const driver = vi.spyOn(claudeChatBackend, 'createDriver').mockReturnValue(fake)
  try {
    const h = transportHarness()
    await startTab()
    const send = async (id: string) => {
      mgr.dispatchUserMessage(TAB_OPTS.tabId, { id, content: [{ type: 'text', text: id }] })
      await until(() => mgr.__getOutboxStateForTests(TAB_OPTS.tabId, id) === 'delivered')
    }
    const end = (id: string) =>
      emit({
        ...claudeCodeAdapter.parseLine(JSON.stringify(sj.success()))!,
        execution: execution(id)
      })
    await send('A')
    end('A')
    await flush()
    await send('B')
    emit({
      kind: 'permission-request',
      requestId: 'approval-B',
      toolUseId: 'tool-B',
      toolName: 'Bash',
      input: {},
      execution: execution('B')
    })
    emit({ kind: 'stream-message-start', messageId: 'reply-B', execution: execution('B') })
    emit({
      kind: 'stream-block-start',
      blockIndex: 0,
      blockType: 'text',
      execution: execution('B')
    })
    emit({
      kind: 'stream-block-delta',
      blockIndex: 0,
      deltaType: 'text',
      text: 'current reply',
      execution: execution('B')
    })
    end('A')
    emit({
      kind: 'permission-request',
      requestId: 'old-approval-A',
      toolUseId: 'old-tool',
      toolName: 'Bash',
      input: {},
      execution: execution('A')
    })
    emit({ kind: 'tool-call', id: 'old-tool', name: 'Bash', input: {}, execution: execution('A') })
    emit({ kind: 'stream-message-start', messageId: 'old-reply', execution: execution('A') })
    emit({
      kind: 'stream-block-delta',
      blockIndex: 0,
      deltaType: 'text',
      text: 'stale',
      execution: execution('A')
    })
    emit({ kind: 'stream-message-stop', execution: execution('B') })
    await flush()
    expect(mgr.getTurnStatus(TAB_OPTS.tabId)).toMatchObject({
      state: 'idle',
      turnOpen: true,
      pendingRequestIds: ['approval-B']
    })
    expect(mgr.__getOutboxStateForTests(TAB_OPTS.tabId, 'B')).toBe('delivered')
    expect(h.saved().filter((e) => e.kind === 'result')).toHaveLength(1)
    expect(h.saved().find((e) => e.kind === 'assistant-text')).toMatchObject({
      text: 'current reply',
      execution: execution('B')
    })
  } finally {
    driver.mockRestore()
  }
})

/** Xorshift32: reproducible scheduling, not random wall-clock sleeps. */
function seeded(seed: number): () => number {
  let n = seed | 0
  return () => {
    n ^= n << 13
    n ^= n >>> 17
    n ^= n << 5
    return (n >>> 0) / 0x1_0000_0000
  }
}

test.each(
  MODES.flatMap((mode) => Array.from({ length: 64 }, (_, i) => ({ seed: 0x51a700 + i, mode })))
)('generated lifecycle orderings preserve contract ($mode, seed $seed)', async ({ seed, mode }) => {
  const c = await contract(mode)
  const random = seeded(seed)
  for (let i = 0; i < 64; i++) {
    const choices: Array<() => Promise<void>> = [() => c.metadata(), () => c.check('reload replay')]
    // A queued message cannot start while a prompt waits (the drainer is gated).
    if (!c.open && !c.prompts.size) choices.push(() => c.start())
    // A background helper may ask while the main turn is closed.
    if (!c.open && c.helpers.size) choices.push(() => c.ask())
    if (c.open) {
      choices.push(
        () => c.progress(),
        () => c.ask()
      )
      if (c.helpers.size < 3) choices.push(() => c.launch())
      if (!c.prompts.size) choices.push(() => c.finish())
    }
    if (c.prompts.size) {
      const ids = [...c.prompts]
      const id = ids[Math.floor(random() * ids.length)]
      choices.push(
        () => c.answer(id),
        () => c.withdraw(id)
      )
    }
    if (c.helpers.size) {
      const ids = [...c.helpers]
      const id = ids[Math.floor(random() * ids.length)]
      choices.push(
        () => c.childProgress(id),
        () => c.finishHelper(id)
      )
    }
    if (c.completedHelpers.length) {
      const id = c.completedHelpers[Math.floor(random() * c.completedHelpers.length)]
      choices.push(() => c.finishHelper(id))
    }
    await choices[Math.floor(random() * choices.length)]()
  }
  for (const id of [...c.prompts]) await c.answer(id)
  if (c.open) await c.finish()
  for (const id of [...c.helpers]) await c.finishHelper(id)
  await c.check(`seed ${seed} fully settled`)
})

// Measured on Claude Code 2.1.326 (`command_lifecycle` + `--replay-user-messages`):
// a turn the CLI starts by itself after a background task has no `started`, and its
// result precedes `started` of a message written meanwhile.
test('a self-started turn racing a written message keeps its own ownership', async () => {
  const c = await contract()

  await c.start()
  await c.finish()
  await mgr.dispatchUserMessage(TAB_OPTS.tabId, {
    id: 'next',
    content: [{ type: 'text', text: 'next' }]
  })
  await c.child.written((m) => m.type === 'user' && m.uuid === 'next')
  emitLine(c.child, sj.lifecycle('next', 'queued'))
  emitLine(c.child, sj.init('contract-session'))
  emitLine(c.child, sj.text('background task finished', { id: 'self-started' }))
  emitLine(c.child, sj.success())
  await flush()
  const ownerOf = (text: string) =>
    c.h.broadcasts.find(
      (b) => b.event.kind === 'assistant-text' && b.event.text === text && b.live === undefined
    )?.event.execution
  expect(ownerOf('background task finished')?.messageId).toBeUndefined()
  expect(mgr.getTurnStatus(TAB_OPTS.tabId)).toMatchObject({ turnOpen: true, outboxInFlight: 1 })
  expect(mgr.isReadyForQueuedMessage(TAB_OPTS.tabId)).toBe(false)
  emitLine(c.child, sj.lifecycle('next', 'started'))
  emitLine(c.child, { type: 'user', isReplay: true, uuid: 'next', message: { content: 'next' } })
  emitLine(c.child, sj.text('reply to next', { id: 'reply-next' }))
  await flush()
  expect(ownerOf('reply to next')).toMatchObject({ messageId: 'next', turnId: 'next' })
  expect(mgr.getTurnStatus(TAB_OPTS.tabId)).toMatchObject({ state: 'running', turnOpen: true })
  emitLine(c.child, sj.success())
  emitLine(c.child, sj.lifecycle('next', 'completed'))
  await until(() => mgr.isReadyForQueuedMessage(TAB_OPTS.tabId))
  const shadow = mgr.__getLifecycleShadowForTests(TAB_OPTS.tabId)!
  expect(shadow.mismatches).toBe(0)
  expect(mgr.getTurnStatus(TAB_OPTS.tabId)).toMatchObject({ state: 'idle', turnOpen: false })
})

// Seen on a real chat (2026-11-18 13:24): the CLI started a turn by itself
// (a finished background task) just as a message was written; it took the
// message into that turn (`started` inside it) and ended it with one result.
test.each(['shadow', 'authoritative'] as const)(
  '%s: a message taken into a self-started turn ends with that turn',
  async (mode) => {
    const records: Array<{ event: string; payload?: unknown }> = []
    const h = transportHarness({ deps: { diagnostic: (_t, r) => records.push(r) } })
    await startTab({ lifecycleMode: mode } as never)
    const c = new Contract(h, h.fakes[0])
    await c.metadata()
    await c.start()
    await c.finish()
    // The self-started turn is already streaming when the message is written.
    emitLine(c.child, sj.init('contract-session'))
    emitLine(c.child, {
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'self' } }
    })
    await flush()
    await mgr.dispatchUserMessage(TAB_OPTS.tabId, {
      id: 'joined',
      content: [{ type: 'text', text: 'next' }]
    })
    await c.child.written((m) => m.type === 'user' && m.uuid === 'joined')
    emitLine(c.child, sj.lifecycle('joined', 'queued'))
    emitLine(c.child, sj.toolUse('self-tool'))
    emitLine(c.child, sj.lifecycle('joined', 'started'))
    emitLine(c.child, {
      type: 'user',
      isReplay: true,
      uuid: 'joined',
      message: { content: 'next' }
    })
    emitLine(c.child, sj.text('reply', { id: 'self-reply' }))
    emitLine(c.child, sj.lifecycle('joined', 'completed'))
    emitLine(c.child, sj.success())
    await until(() => mgr.getTurnStatus(TAB_OPTS.tabId)?.turnOpen === false)
    await flush()
    expect(mgr.getTurnStatus(TAB_OPTS.tabId)).toMatchObject({ state: 'idle', turnOpen: false })
    expect(mgr.isReadyForQueuedMessage(TAB_OPTS.tabId)).toBe(true)
    expect(records.filter((r) => r.event === 'chat.lifecycle_shadow_mismatch')).toEqual([])
  }
)
