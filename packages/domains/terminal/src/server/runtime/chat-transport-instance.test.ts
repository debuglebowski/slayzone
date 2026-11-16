import { afterEach, expect, test, vi } from 'vitest'
import files, { type FileHandle } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createChatTransport, memoryChatEventReads } from './chat-transport-manager'

const runtimes: Array<ReturnType<typeof createChatTransport>> = []

test('genuine anonymous-file close failure fences removal/hydrate, then retries physical cleanup', async () => {
  const { fakeChild, sj, until } = await import('./chat-transport-testkit')
  const f = fakeChild({ exitOnKill: true })
  let release!: () => void,
    repair = false,
    file: FileHandle | undefined
  const held = new Promise<void>((r) => {
    release = r
  })
  const fault = Object.assign(new Error('fixture close EIO'), { code: 'EIO' })
  const originalOpen = files.open
  const spy = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args)
    if (String(args[0]).includes('slay-chat-output-')) {
      file = handle
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        if (!repair) throw fault // Genuine rejection; the real FD remains open.
        await close()
      })
    }
    return handle
  })
  syncBuiltinESMExports()
  const rows: import('../chat-events-store').BufferedEvent[] = []
  const r = createChatTransport({
    whichBinary: async () => '/fixture/claude',
    spawn: () => {
      setImmediate(() => f.emitter.emit('spawn'))
      return f.child
    },
    eventStore: {
      ...memoryChatEventReads(() => rows),
      insert: async (_tab, seq, event, at) => {
        if (event.kind === 'assistant-text' && event.text === 'one') await held
        rows.push({ seq, event, at })
        return 'inserted'
      }
    }
  })
  const opts = {
    tabId: 'tab',
    taskId: 'task',
    mode: 'claude-chat',
    cwd: '/tmp',
    providerFlags: [],
    conversationId: null
  }
  try {
    await r.hydrateSession(opts)
    await r.ensureSpawned('tab')
    f.stdout.write([sj.text('one'), sj.text('two')].map((x) => JSON.stringify(x)).join('\n') + '\n')
    await until(() => !!file)
    release()
    await r.readEventsSince('tab', -1)
    expect((await file!.stat()).nlink).toBe(0)
    await expect(r.removeSession('tab')).rejects.toBe(fault)
    await expect(file!.stat()).resolves.toMatchObject({ nlink: 0 })
    await expect(r.hydrateSession(opts)).rejects.toBe(fault)
    const retried = await r.removeSession('tab').catch((error) => error)
    expect(retried).toBeInstanceOf(AggregateError)
    expect(retried.cause).toBe(fault)
    expect(retried.errors).toContain(fault)
    await expect(file!.stat()).resolves.toMatchObject({ nlink: 0 })
    await expect(r.quiesceSession('tab')).rejects.toThrow('Chat physical cleanup retry failed')
    repair = true
    await expect(r.removeSession('tab')).resolves.toBeUndefined()
    await expect(file!.stat()).rejects.toMatchObject({ code: 'EBADF' })
    await expect(r.hydrateSession(opts)).resolves.toBeDefined()
    expect(
      rows
        .filter((x) => x.event.kind === 'assistant-text')
        .map((x) => (x.event as { text: string }).text)
    ).toEqual(['one', 'two'])
  } finally {
    release()
    repair = true
    await file?.close()
    await r.removeSession('tab').catch(() => undefined)
    spy.mockRestore()
    syncBuiltinESMExports()
  }
})
afterEach(async () => {
  for (const r of runtimes.splice(0))
    await r.shutdownAll({ termGraceMs: 1, hardTimeoutMs: 10 }).catch(() => undefined)
})
test('independent runtime instances do not share tabs, event logs or emitters', async () => {
  function runtime(text: string) {
    const value = createChatTransport({
      eventStore: {
        insert: async () => 'inserted',
        ...memoryChatEventReads(() => [
          { seq: 0, at: 1, event: { kind: 'assistant-text', messageId: 'm', text } }
        ])
      }
    })
    runtimes.push(value)
    return value
  }
  const a = runtime('hub A'),
    b = runtime('hub B')
  const opts = {
    tabId: 'tab',
    taskId: 'task',
    mode: 'claude-chat',
    cwd: '/tmp',
    providerFlags: [],
    conversationId: null
  }
  await a.hydrateSession(opts)
  expect(b.getSessionInfo('tab')).toBeNull()
  await b.hydrateSession(opts)
  expect((await a.getReplay('tab', -1)).events[0].event).toMatchObject({ text: 'hub A' })
  expect((await b.getReplay('tab', -1)).events[0].event).toMatchObject({ text: 'hub B' })
  expect(a.chatEvents).not.toBe(b.chatEvents)
  await a.removeSession('tab')
  expect(b.getSessionInfo('tab')).not.toBeNull()
})

test('a failed durable event save stops the process and reports a live storage error', async () => {
  const { fakeChild, sj, emitLine, until } = await import('./chat-transport-testkit')
  const f = fakeChild({ exitOnKill: true })
  const broadcast: Array<{
    event: import('@slayzone/terminal-contracts').AgentEvent
    live?: number
  }> = []
  const r = createChatTransport({
    spawn: () => {
      setImmediate(() => f.child.emit('spawn'))
      return f.child
    },
    whichBinary: async () => '/fake/claude',
    broadcastEvent: (_tab, event, _seq, live) => broadcast.push({ event, live }),
    eventStore: {
      ...memoryChatEventReads(() => []),
      insert: async (_tab, _seq, event) => {
        if (event.kind === 'assistant-text') throw new Error('disk full')
        return 'inserted'
      }
    }
  })
  runtimes.push(r)
  await r.hydrateSession({
    tabId: 'tab',
    taskId: 'task',
    mode: 'claude-chat',
    cwd: '/tmp',
    providerFlags: [],
    conversationId: null
  })
  await r.ensureSpawned('tab')
  emitLine(f, sj.init('session'))
  emitLine(f, sj.text('must not look saved'))
  await until(() =>
    broadcast.some((x) => x.event.kind === 'error' && /storage/i.test(x.event.message))
  )
  expect(broadcast.some((x) => x.event.kind === 'assistant-text')).toBe(false)
  expect(f.kills).toContain('SIGTERM')
  expect(
    broadcast.find((x) => x.event.kind === 'error' && /storage/i.test(x.event.message))?.live
  ).toBeDefined()
  await expect(r.readEventsSince('tab', -1)).rejects.toThrow('disk full')
  await expect(r.removeSession('tab')).rejects.toThrow('disk full')
  await expect(r.removeSession('tab')).rejects.toThrow('disk full')
  await expect(
    r.hydrateSession({
      tabId: 'tab',
      taskId: 'task',
      mode: 'claude-chat',
      cwd: '/tmp',
      providerFlags: [],
      conversationId: null
    })
  ).rejects.toThrow('disk full')
})

test('a delayed insert cannot reach replay, projection or broadcast before its commit', async () => {
  const { fakeChild, sj, emitLine, until } = await import('./chat-transport-testkit')
  const f = fakeChild({ exitOnKill: true })
  let commit!: () => void
  const gate = new Promise<void>((resolve) => {
    commit = resolve
  })
  let writing = false
  const broadcast: import('@slayzone/terminal-contracts').AgentEvent[] = []
  const r = createChatTransport({
    spawn: () => {
      setImmediate(() => f.child.emit('spawn'))
      return f.child
    },
    whichBinary: async () => '/fake/claude',
    broadcastEvent: (_tab, event) => {
      broadcast.push(event)
    },
    eventStore: {
      ...memoryChatEventReads(() => []),
      insert: async (_tab, _seq, event) => {
        if (event.kind === 'assistant-text') {
          writing = true
          await gate
        }
        return 'inserted'
      }
    }
  })
  runtimes.push(r)
  await r.hydrateSession({
    tabId: 'tab',
    taskId: 'task',
    mode: 'claude-chat',
    cwd: '/tmp',
    providerFlags: [],
    conversationId: null
  })
  await r.ensureSpawned('tab')
  emitLine(f, sj.init('session'))
  // One OS chunk can contain several protocol lines: a later live fragment
  // must not overtake an earlier saved event whose insert is still blocked.
  f.stdout.write(
    [
      sj.text('pending'),
      {
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'next-message' } }
      }
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n'
  )
  try {
    await until(() => writing)
    // Event consumption waits; same-pipe control responses must still progress.
    await expect(
      r.sendControlRequest('tab', { subtype: 'set_model', model: 'fixture' }, 1500)
    ).resolves.toBeDefined()
    expect(r.getSessionTerminalState('tab')).toBe('idle')
    expect(broadcast.some((event) => event.kind === 'assistant-text')).toBe(false)
    expect(broadcast.some((event) => event.kind === 'stream-message-start')).toBe(false)
    expect(
      r.getEventBufferSince('tab', -1).some((entry) => entry.event.kind === 'assistant-text')
    ).toBe(false)
  } finally {
    commit()
  }
  await until(() => broadcast.some((event) => event.kind === 'assistant-text'))
  await until(() => broadcast.some((event) => event.kind === 'stream-message-start'))
  expect(broadcast.findIndex((event) => event.kind === 'assistant-text')).toBeLessThan(
    broadcast.findIndex((event) => event.kind === 'stream-message-start')
  )
  expect(r.getSessionTerminalState('tab')).toBe('running')
  expect(
    (await r.getReplay('tab', -1)).events.some((entry) => entry.event.kind === 'assistant-text')
  ).toBe(true)
})

test('spawn waits for an asynchronous ownership guard before creating a provider', async () => {
  const { fakeChild } = await import('./chat-transport-testkit')
  const f = fakeChild({ exitOnKill: true })
  let allow!: () => void
  const guard = new Promise<void>((resolve) => {
    allow = resolve
  })
  let spawned = false
  const r = createChatTransport({
    beforeSpawn: () => guard,
    spawn: () => {
      spawned = true
      setImmediate(() => f.child.emit('spawn'))
      return f.child
    },
    whichBinary: async () => '/fake/claude'
  })
  runtimes.push(r)
  await r.hydrateSession({
    tabId: 'tab',
    taskId: 'task',
    mode: 'claude-chat',
    cwd: '/tmp',
    providerFlags: [],
    conversationId: null
  })
  const pending = r.ensureSpawned('tab')
  try {
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(spawned).toBe(false)
  } finally {
    allow()
  }
  await pending
  expect(spawned).toBe(true)
})

test('dispatch commits the user row before provider delivery and deduplicates concurrent admissions', async () => {
  const { fakeChild, until } = await import('./chat-transport-testkit')
  const f = fakeChild({ exitOnKill: true })
  let commit!: () => void
  const gate = new Promise<void>((resolve) => {
    commit = resolve
  })
  let writing = false
  let userRows = 0
  const r = createChatTransport({
    spawn: () => {
      setImmediate(() => f.child.emit('spawn'))
      return f.child
    },
    whichBinary: async () => '/fake/claude',
    eventStore: {
      ...memoryChatEventReads(() => []),
      insert: async (_tab, _seq, event) => {
        if (event.kind === 'user-message') {
          userRows++
          writing = true
          await gate
        }
        return 'inserted'
      }
    }
  })
  runtimes.push(r)
  await r.hydrateSession({
    tabId: 'tab',
    taskId: 'task',
    mode: 'claude-chat',
    cwd: '/tmp',
    providerFlags: [],
    conversationId: null
  })
  await r.ensureSpawned('tab')
  const message = { id: 'same-admission', content: [{ type: 'text' as const, text: 'hello' }] }
  const first = Promise.resolve(r.dispatchUserMessage('tab', message))
  const same = Promise.resolve(r.dispatchUserMessage('tab', message))
  try {
    await until(() => writing)
    expect(f.stdin.some((value) => value.type === 'user')).toBe(false)
  } finally {
    commit()
  }
  expect(await first).toEqual(await same)
  await until(() => f.stdin.some((value) => value.type === 'user'))
  expect(userRows).toBe(1)
  expect(f.stdin.filter((value) => value.type === 'user')).toHaveLength(1)
})

test('closing drains buffered provider output after a delayed commit before releasing the tab', async () => {
  const { fakeChild, sj, emitLine, until } = await import('./chat-transport-testkit')
  const f = fakeChild({ exitOnKill: true })
  let commit!: () => void
  const gate = new Promise<void>((resolve) => {
    commit = resolve
  })
  let writing = false
  const saved: import('@slayzone/terminal-contracts').AgentEvent[] = []
  const r = createChatTransport({
    spawn: () => {
      setImmediate(() => f.child.emit('spawn'))
      return f.child
    },
    whichBinary: async () => '/fake/claude',
    eventStore: {
      ...memoryChatEventReads(() => []),
      insert: async (_tab, _seq, event) => {
        if (event.kind === 'assistant-text') {
          writing = true
          await gate
        }
        saved.push(event)
        return 'inserted'
      }
    }
  })
  runtimes.push(r)
  await r.hydrateSession({
    tabId: 'tab',
    taskId: 'task',
    mode: 'claude-chat',
    cwd: '/tmp',
    providerFlags: [],
    conversationId: null
  })
  await r.ensureSpawned('tab')
  emitLine(f, sj.text('first'))
  await until(() => writing)
  emitLine(f, sj.text('buffered tail'))
  let closed = false
  const closing = r.removeSession('tab').then(() => {
    closed = true
  })
  try {
    await new Promise((resolve) => setImmediate(resolve))
    expect(closed).toBe(false)
  } finally {
    commit()
  }
  await closing
  expect(
    saved.filter((event) => event.kind === 'assistant-text').map((event) => event.text)
  ).toEqual(['first', 'buffered tail'])
  expect(f.kills).toEqual(['SIGTERM'])
})

test('storage backpressure does not count as a stalled provider turn', async () => {
  const { fakeChild, sj, emitLine, until } = await import('./chat-transport-testkit')
  const f = fakeChild({ exitOnKill: true })
  let commit!: () => void
  const gate = new Promise<void>((resolve) => {
    commit = resolve
  })
  let writing = false
  const r = createChatTransport({
    spawn: () => {
      setImmediate(() => f.child.emit('spawn'))
      return f.child
    },
    whichBinary: async () => '/fake/claude',
    isProcessAlive: () => true,
    watchdogTimings: { startingBoundMs: 2000, runningStallMs: 20, killGraceMs: 20 },
    eventStore: {
      ...memoryChatEventReads(() => []),
      insert: async (_tab, _seq, event) => {
        if (event.kind === 'assistant-text') {
          writing = true
          await gate
        }
        return 'inserted'
      }
    }
  })
  runtimes.push(r)
  await r.hydrateSession({
    tabId: 'tab',
    taskId: 'task',
    mode: 'claude-chat',
    cwd: '/tmp',
    providerFlags: [],
    conversationId: null
  })
  await r.ensureSpawned('tab')
  await r.dispatchUserMessage('tab', { id: 'user', content: [{ type: 'text', text: 'hello' }] })
  emitLine(f, sj.text('waiting for storage'))
  try {
    await until(() => writing)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(f.kills).toEqual([])
  } finally {
    commit()
  }
  await r.getReplay('tab', -1)
})
