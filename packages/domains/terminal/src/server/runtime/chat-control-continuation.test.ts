import { expect, test } from 'vitest'
import {
  createChatTransport,
  memoryChatEventReads,
  type BufferedEvent
} from './chat-transport-manager'
import { fakeChild, emitLine, sj, until } from './chat-transport-testkit'

const opts = {
  tabId: 'tab',
  taskId: 'task',
  mode: 'claude-chat',
  cwd: '/tmp',
  providerFlags: [],
  conversationId: null
}
function fixture(beforeSend?: () => Promise<{ status: 'ready' }>, holdEvent?: () => Promise<void>) {
  const fakes: ReturnType<typeof fakeChild>[] = [],
    rows: BufferedEvent[] = [],
    live: string[] = []
  const runtime = createChatTransport({
    whichBinary: async () => '/fixture/claude',
    broadcastEvent: (_tab, event) => live.push(event.kind),
    spawn: () => {
      const f = fakeChild({ exitOnKill: true })
      fakes.push(f)
      setImmediate(() => f.emitter.emit('spawn'))
      return f.child
    },
    eventStore: {
      ...memoryChatEventReads(() => rows),
      insert: async (_tab, seq, event, at) => {
        if (event.kind === 'assistant-text' && event.text === 'held prefix') await holdEvent?.()
        rows.push({ seq, event, at })
        return 'inserted'
      }
    },
    ...(beforeSend
      ? {
          workspaceCapture: {
            begin: beforeSend,
            finish: async () => ({ status: 'complete' as const, files: [] }),
            discard: async () => {}
          },
          workspaceStore: { begin: async () => {}, save: async () => {}, get: async () => null }
        }
      : {})
  })
  return { runtime, fakes, rows, live }
}

test('captured ACK survives durable continuation once, then next user turn stays untouched', async () => {
  const { runtime: r, fakes, rows } = fixture()
  let control: ReturnType<typeof r.prepareDurableControl> | undefined
  try {
    await r.hydrateSession(opts)
    await r.ensureSpawned('tab')
    const f = fakes[0]
    await r.dispatchUserMessage('tab', { id: 'u1', content: [{ type: 'text', text: 'restore' }] })
    await f.written((m) => m.type === 'user')
    emitLine(f, sj.lifecycle('u1', 'started'))
    await r.readEventsSince('tab', -1)
    f.answer('interrupt', () => {
      setImmediate(() => emitLine(f, sj.aborted()))
      return { success: { still_queued: [] } }
    })
    control = r.prepareDurableControl('tab', 'abortAndPop')!
    await control.acknowledged
    const result = await control.run(() =>
      r.stopTurn('tab', { restorePrompt: true, respawnOpts: async () => opts })
    )
    control.close()
    expect(result).toMatchObject({ popped: true, text: 'restore' })
    expect(f.controlRequests('interrupt')).toHaveLength(1)
    await r.dispatchUserMessage('tab', { id: 'u2', content: [{ type: 'text', text: 'next turn' }] })
    await f.written((m) => m.type === 'user' && m.uuid === 'u2')
    emitLine(f, sj.lifecycle('u2', 'started'))
    emitLine(f, sj.text('next answer'))
    await r.readEventsSince('tab', -1)
    expect(f.controlRequests('interrupt')).toHaveLength(1)
    expect(
      rows.some((x) => x.event.kind === 'assistant-text' && x.event.text === 'next answer')
    ).toBe(true)
  } finally {
    control?.close()
    await r.removeSession('tab')
  }
})

test('refused early ACK uses original durable fallback without retrying interrupt', async () => {
  const { runtime: r, fakes } = fixture()
  let control: ReturnType<typeof r.prepareDurableControl> | undefined
  try {
    await r.hydrateSession(opts)
    await r.ensureSpawned('tab')
    const f = fakes[0]
    f.answer('interrupt', () => ({ error: 'fixture interrupt refused' }))
    control = r.prepareDurableControl('tab', 'interrupt')!
    await expect(control.acknowledged).rejects.toThrow('fixture interrupt refused')
    const result = await control.run(() =>
      r.stopTurn('tab', { restorePrompt: false, respawnOpts: async () => opts })
    )
    control.close()
    expect(result.via).toBe('respawn')
    expect(f.controlRequests('interrupt')).toHaveLength(1)
    expect(fakes).toHaveLength(2)
  } finally {
    control?.close()
    await r.removeSession('tab')
  }
})

test('Stop saves complete streamed blocks before the provider result without broadcasting their fragments', async () => {
  const { runtime: r, fakes, rows, live } = fixture()
  let control: ReturnType<typeof r.prepareDurableControl> | undefined
  try {
    await r.hydrateSession(opts)
    await r.ensureSpawned('tab')
    const f = fakes[0]
    await r.dispatchUserMessage('tab', { id: 'u1', content: [{ type: 'text', text: 'work' }] })
    await f.written((m) => m.type === 'user')
    emitLine(f, sj.lifecycle('u1', 'started'))
    emitLine(f, sj.text('already working'))
    await r.readEventsSince('tab', -1)
    control = r.prepareDurableControl('tab', 'interrupt')!
    await control.acknowledged
    await control.run(() =>
      r.stopTurn('tab', { restorePrompt: false, respawnOpts: async () => opts })
    )
    control.close()
    await r.readEventsSince('tab', -1)
    const cut = live.length
    // Codex supplies only these fragments: no later consolidated assistant event
    // can repair a block dropped while the acknowledged Stop awaits its result.
    const stream = (event: unknown) =>
      emitLine(f, { type: 'stream_event', event, parent_tool_use_id: null })
    for (let i = 0; i < 3; i++) {
      stream({ type: 'message_start', message: { id: `tail-${i}` } })
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: `tail-${i}` }
      })
      stream({ type: 'content_block_stop', index: 0 })
      stream({ type: 'message_stop' })
    }
    emitLine(f, sj.aborted())
    await r.readEventsSince('tab', -1)
    expect(
      rows.flatMap(({ event }) =>
        event.kind === 'assistant-text' && event.messageId.startsWith('tail-') ? [event.text] : []
      )
    ).toEqual(['tail-0', 'tail-1', 'tail-2'])
    expect(live.slice(cut).filter((kind) => kind.startsWith('stream-'))).toEqual([])
    expect(f.controlRequests('interrupt')).toHaveLength(1)
    expect(r.getSessionTerminalState('tab')).toBe('idle')
  } finally {
    control?.close()
    await r.removeSession('tab')
  }
})

test('a pre-click workspace wait cannot start its user turn after early ACK and before durable stop', async () => {
  let release!: () => void,
    entered = false
  const waiting = new Promise<{ status: 'ready' }>((r) => {
    release = () => r({ status: 'ready' })
  })
  const { runtime: r, fakes } = fixture(() => {
    entered = true
    return waiting
  })
  let control: ReturnType<typeof r.prepareDurableControl> | undefined
  try {
    await r.hydrateSession(opts)
    await r.ensureSpawned('tab')
    const f = fakes[0]
    await r.dispatchUserMessage('tab', {
      id: 'held',
      content: [{ type: 'text', text: 'not yet sent' }]
    })
    await until(() => entered)
    await r.dispatchUserMessage('tab', {
      id: 'held-2',
      content: [{ type: 'text', text: 'second unsent prompt' }]
    })
    control = r.prepareDurableControl('tab', 'abortAndPop')!
    await control.acknowledged
    release()
    // A later real protocol ACK proves the event loop/child progressed while
    // the workspace completion remains fenced from the user-message write.
    await r.sendControlRequest('tab', { subtype: 'set_permission_mode', mode: 'default' })
    expect(f.stdin.filter((m) => m.type === 'user')).toEqual([])
    expect(
      await control.run(() =>
        r.stopTurn('tab', { restorePrompt: true, respawnOpts: async () => opts })
      )
    ).toMatchObject({ popped: false, text: null })
    control.close()
    await r.readEventsSince('tab', -1)
    expect(f.stdin.filter((m) => m.type === 'user')).toEqual([])
  } finally {
    release()
    control?.close()
    await r.removeSession('tab')
  }
})

test('overlapping abort and physical escalation share one generation without refusing commands', async () => {
  const { runtime: r, fakes } = fixture()
  const controls: NonNullable<ReturnType<typeof r.prepareDurableControl>>[] = []
  try {
    await r.hydrateSession(opts)
    await r.ensureSpawned('tab')
    const f = fakes[0]
    const first = r.prepareDurableControl('tab', 'interrupt')!
    controls.push(first)
    await first.acknowledged
    const abort = r.prepareDurableControl('tab', 'abortAndPop')!
    controls.push(abort)
    const kill = r.prepareDurableControl('tab', 'kill')!
    controls.push(kill)
    const remove = r.prepareDurableControl('tab', 'remove')!
    controls.push(remove)
    await Promise.all(controls.map((c) => c.acknowledged))
    expect(f.kills.length).toBeGreaterThan(0)
    expect(new Set(controls.map((c) => c.spawnId)).size).toBe(1)
    await first.run(() =>
      r.stopTurn('tab', { restorePrompt: false, respawnOpts: async () => opts })
    )
    first.close()
    await abort.run(() => r.stopTurn('tab', { restorePrompt: true, respawnOpts: async () => opts }))
    abort.close()
    await kill.run(() => r.kill('tab'))
    kill.close()
    await remove.run(() => r.removeSession('tab'))
    remove.close()
    expect(fakes).toHaveLength(1)
    expect(f.controlRequests('interrupt')).toHaveLength(1)
    await r.hydrateSession(opts)
    await r.ensureSpawned('tab')
    expect(fakes).toHaveLength(2)
  } finally {
    for (const c of controls) c.close()
    await r.removeSession('tab')
  }
})

test('actual physical exit releases a prepared stdout boundary before its storage/output drain', async () => {
  const { runtime: r, fakes } = fixture()
  let control: ReturnType<typeof r.prepareDurableControl> | undefined
  try {
    await r.hydrateSession(opts)
    await r.ensureSpawned('tab')
    const f = fakes[0]
    control = r.prepareDurableControl('tab', 'interrupt')!
    await control.acknowledged
    const killing = r.controlSession('tab', control.spawnId, 'kill')
    await killing
    // A private cancellation must not be required to settle the physical exit.
    await expect.poll(() => r.getSessionInfo('tab')?.ended, { timeout: 1000 }).toBe(true)
    expect(f.kills.length).toBeGreaterThan(0)
  } finally {
    control?.close()
    await r.removeSession('tab')
  }
})

test('physical escalation preserves an unanswered prompt decision at the shared stdout cut', async () => {
  const { runtime: r, fakes, rows } = fixture()
  const controls: NonNullable<ReturnType<typeof r.prepareDurableControl>>[] = []
  try {
    await r.hydrateSession(opts)
    await r.ensureSpawned('tab')
    const f = fakes[0]
    await r.dispatchUserMessage('tab', {
      id: 'prompt',
      content: [{ type: 'text', text: 'restore before kill' }]
    })
    await f.written((m) => m.type === 'user')
    emitLine(f, sj.lifecycle('prompt', 'started'))
    await r.readEventsSince('tab', -1)
    const abort = r.prepareDurableControl('tab', 'abortAndPop')!
    controls.push(abort)
    await abort.acknowledged
    const kill = r.prepareDurableControl('tab', 'kill')!
    controls.push(kill)
    await kill.acknowledged
    const result = await abort.run(() =>
      r.stopTurn('tab', { restorePrompt: true, respawnOpts: async () => opts })
    )
    expect(result).toMatchObject({ popped: true, text: 'restore before kill' })
    abort.close()
    await kill.run(() => r.kill('tab'))
    kill.close()
    await r.readEventsSince('tab', -1)
    expect(rows.some((x) => x.event.kind === 'user-message-popped')).toBe(true)
    expect(fakes).toHaveLength(1)
  } finally {
    for (const c of controls) c.close()
    await r.removeSession('tab')
  }
})

test('abandoned control with unknown ACK keeps writes fenced until the captured physical process stops', async () => {
  const { runtime: r, fakes } = fixture()
  let control: ReturnType<typeof r.prepareDurableControl> | undefined
  try {
    await r.hydrateSession(opts)
    await r.ensureSpawned('tab')
    const f = fakes[0]
    f.answer('interrupt', () => 'ignore')
    control = r.prepareDurableControl('tab', 'interrupt')!
    void control.acknowledged.catch(() => undefined)
    control.close()
    await r.dispatchUserMessage('tab', {
      id: 'after-abort',
      content: [{ type: 'text', text: 'must not reach old process' }]
    })
    await r.sendControlRequest('tab', { subtype: 'set_permission_mode', mode: 'default' })
    expect(f.stdin.filter((m) => m.type === 'user')).toEqual([])
    await expect(control.acknowledged).rejects.toThrow(/timed? ?out|timeout/i)
    await expect.poll(() => f.kills.length).toBeGreaterThan(0)
    await r.readEventsSince('tab', -1)
    expect(f.stdin.filter((m) => m.type === 'user')).toEqual([])
    expect(fakes).toHaveLength(1)
  } finally {
    control?.close()
    await r.removeSession('tab')
  }
})

test('a captured stop after same-group removal settles without respawning or controlling a later generation', async () => {
  let release!: () => void,
    entered = false
  const gate = new Promise<void>((r) => {
    release = r
  })
  const {
    runtime: r,
    fakes,
    rows
  } = fixture(undefined, () => {
    entered = true
    return gate
  })
  const controls: NonNullable<ReturnType<typeof r.prepareDurableControl>>[] = []
  try {
    await r.hydrateSession(opts)
    await r.ensureSpawned('tab')
    const f = fakes[0]
    emitLine(f, sj.text('held prefix'))
    await until(() => entered)
    const remove = r.prepareDurableControl('tab', 'remove')!
    controls.push(remove)
    const stop = r.prepareDurableControl('tab', 'interrupt')!
    controls.push(stop)
    await remove.acknowledged
    const removing = remove.run(() => r.removeSession('tab'))
    void removing.catch(() => undefined)
    release()
    await removing
    remove.close()
    const info = await stop.run(async () => {
      await r.stopTurn('tab', { restorePrompt: false, respawnOpts: async () => opts })
      return r.getSessionInfo('tab')
    })
    stop.close()
    expect(info).toMatchObject({ ended: true, pid: null })
    expect(
      rows.some((x) => x.event.kind === 'assistant-text' && x.event.text === 'held prefix')
    ).toBe(true)
    expect(fakes).toHaveLength(1)
  } finally {
    release()
    for (const c of controls) c.close()
    await r.removeSession('tab')
  }
})

test.each(['kill', 'remove'] as const)(
  'accepted captured %s cannot act on a new generation after restart during a durable await',
  async (method) => {
    const { runtime: r, fakes } = fixture()
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((r) => {
        release = r
      }),
      running = new Promise<void>((r) => {
        entered = r
      })
    let control: ReturnType<typeof r.prepareDurableControl> | undefined
    try {
      await r.hydrateSession(opts)
      await r.ensureSpawned('tab')
      control = r.prepareDurableControl('tab', method)!
      await control.acknowledged
      const work = control.run(async () => {
        entered()
        await gate
        return method === 'kill' ? r.kill('tab') : r.removeSession('tab')
      })
      void work.catch(() => undefined)
      await running
      await r.respawn('tab', opts)
      expect(fakes).toHaveLength(2)
      release()
      await expect(work).rejects.toThrow(/generation changed/)
      expect(fakes[1].kills).toEqual([])
    } finally {
      release()
      control?.close()
      await r.removeSession('tab')
    }
  }
)

/** A transport whose event store can hold chosen inserts (slow storage on demand). */
function heldStorage() {
  const fakes: ReturnType<typeof fakeChild>[] = [],
    rows: BufferedEvent[] = [],
    holds = new Map<string, Promise<void>>(),
    releases = new Map<string, () => void>()
  const key = (event: BufferedEvent['event']) =>
    event.kind === 'user-message' ? `user-message:${event.id}` : event.kind
  const hold = (k: string) =>
    holds.set(
      k,
      new Promise<void>((r) => {
        releases.set(k, r)
      })
    )
  const release = (k: string) => {
    holds.delete(k)
    releases.get(k)?.()
  }
  const runtime = createChatTransport({
    whichBinary: async () => '/fixture/claude',
    broadcastEvent: () => {},
    spawn: () => {
      const f = fakeChild({ exitOnKill: true })
      fakes.push(f)
      setImmediate(() => f.emitter.emit('spawn'))
      return f.child
    },
    eventStore: {
      ...memoryChatEventReads(() => rows),
      insert: async (_tab, seq, event, at) => {
        const held = holds.get(key(event))
        if (held) await held
        rows.push({ seq, event, at })
        return 'inserted'
      }
    }
  })
  return {
    runtime,
    fakes,
    rows,
    hold,
    release,
    releaseAll: () => [...releases.keys()].map(release)
  }
}

test("a previous turn's late result spooled before a write settles that turn; the write's turn runs", async () => {
  const { runtime: r, fakes, rows, hold, release, releaseAll } = heldStorage()
  try {
    await r.hydrateSession(opts)
    await r.ensureSpawned('tab')
    const f = fakes[0]
    await r.dispatchUserMessage('tab', { id: 'u1', content: [{ type: 'text', text: 'one' }] })
    await f.written((m) => m.type === 'user' && m.uuid === 'u1')
    emitLine(f, sj.lifecycle('u1', 'started'))
    await r.readEventsSince('tab', -1)
    // u2's own row is slow to save; meanwhile u1's end arrives and is held back.
    hold('user-message:u2')
    const sending = r.dispatchUserMessage('tab', {
      id: 'u2',
      content: [{ type: 'text', text: 'two' }]
    })
    emitLine(f, sj.lifecycle('u1', 'completed'))
    emitLine(f, sj.success('u1 done'))
    // Received (out of the pipe) before u2 is written.
    await until(() => f.stdout.readableLength === 0)
    release('user-message:u2')
    await sending
    await f.written((m) => m.type === 'user' && m.uuid === 'u2')
    emitLine(f, sj.lifecycle('u2', 'started'))
    emitLine(f, sj.text('u2 answer'))
    await r.readEventsSince('tab', -1)
    expect(rows.filter((x) => x.event.kind === 'result')).toHaveLength(1)
    expect(r.__getOutboxStateForTests('tab', 'u1')).toBe('answered')
    expect(r.getSessionTerminalState('tab')).toBe('running')
    expect(
      rows.some((x) => x.event.kind === 'assistant-text' && x.event.text === 'u2 answer')
    ).toBe(true)
  } finally {
    releaseAll()
    await r.removeSession('tab')
  }
})

test('Stop pressed after a write whose turn start still waits on held output keeps the turn stopping', async () => {
  const { runtime: r, fakes, hold, release, releaseAll } = heldStorage()
  try {
    await r.hydrateSession(opts)
    await r.ensureSpawned('tab')
    const f = fakes[0]
    await r.dispatchUserMessage('tab', { id: 'u1', content: [{ type: 'text', text: 'one' }] })
    await f.written((m) => m.type === 'user' && m.uuid === 'u1')
    emitLine(f, sj.lifecycle('u1', 'started'))
    await r.readEventsSince('tab', -1)
    hold('user-message:u2')
    hold('result')
    const sending = r.dispatchUserMessage('tab', {
      id: 'u2',
      content: [{ type: 'text', text: 'two' }]
    })
    emitLine(f, sj.lifecycle('u1', 'completed'))
    emitLine(f, sj.success('u1 done'))
    // Received (out of the pipe) before u2 is written.
    await until(() => f.stdout.readableLength === 0)
    release('user-message:u2')
    // u2 is written; its turn start waits behind u1's held result.
    await f.written((m) => m.type === 'user' && m.uuid === 'u2')
    await r.sendControlRequest('tab', { subtype: 'interrupt' })
    release('result')
    await sending
    await r.readEventsSince('tab', -1)
    expect(r.getSessionTerminalState('tab')).toBe('running')
    // The Stop came after the write: the turn it stopped stays stopping.
    expect(r.canSteer('tab')).toBe(false)
  } finally {
    releaseAll()
    await r.removeSession('tab')
  }
})
