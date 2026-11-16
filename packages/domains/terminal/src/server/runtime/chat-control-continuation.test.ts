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
function fixture(beforeSend?: () => Promise<{ status: 'ready' }>) {
  const fakes: ReturnType<typeof fakeChild>[] = [],
    rows: BufferedEvent[] = []
  const runtime = createChatTransport({
    whichBinary: async () => '/fixture/claude',
    spawn: () => {
      const f = fakeChild({ exitOnKill: true })
      fakes.push(f)
      setImmediate(() => f.emitter.emit('spawn'))
      return f.child
    },
    eventStore: {
      ...memoryChatEventReads(() => rows),
      insert: async (_tab, seq, event, at) => {
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
  return { runtime, fakes, rows }
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
