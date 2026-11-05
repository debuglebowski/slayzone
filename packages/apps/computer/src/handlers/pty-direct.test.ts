/**
 * The computer's direct-link terminal service (docs/direct-link.md): what a client
 * reaches without the hub — attach, gap-free backfill and the live stream — read
 * from the computer's ring buffer, the session's only scrollback.
 */
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { ComputerConfig } from '../config'
import { createPtyHandlers } from './pty'
import type { ComputerDialer } from './types'

function makeCtx() {
  const notifies: Array<{ method: string; params: Record<string, unknown> }> = []
  const dialer: ComputerDialer = {
    notify: (method, params) => {
      notifies.push({ method, params: (params ?? {}) as Record<string, unknown> })
      return true
    }
  }
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [tmpdir(), process.cwd()],
    capabilities: ['pty']
  }
  return { notifies, ctx: { dialer, config, log: () => {} } }
}

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('direct pty service', () => {
  it('streams to direct watchers while the hub relay is off, and backfills gap-free', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    const sessionId = 'd-1'
    await pty.handlers['pty.spawn']({ sessionId, command: 'cat', cwd: process.cwd(), relay: false })

    const got: Array<{ seq: number; data: string }> = []
    let ended: string | null = null
    const stop = pty.direct.watch(
      sessionId,
      (chunk) => got.push(chunk),
      (reason) => {
        ended = reason
      }
    )
    expect(stop).not.toBeNull()
    await pty.handlers['pty.write']({ sessionId, data: 'alpha\n' })
    await waitFor(() =>
      got
        .map((c) => c.data)
        .join('')
        .includes('alpha')
    )
    // The hub asked for no relay: nothing went its way.
    expect(notifies.filter((n) => n.method === 'pty.data')).toEqual([])
    got.forEach((c, i) => expect(c.seq).toBe(i))

    const attach = pty.direct.attach(sessionId, -1)
    expect(attach.exists).toBe(true)
    expect(attach.size).toEqual({ cols: expect.any(Number), rows: expect.any(Number) })
    expect(attach.buffer.currentSeq).toBe(got[got.length - 1]?.seq)
    expect(attach.buffer.chunks.map((c) => c.data).join('')).toBe(got.map((c) => c.data).join(''))

    const since = pty.direct.getBufferSince(sessionId, 0)
    expect(since.chunks.map((c) => c.seq)).toEqual(got.slice(1).map((c) => c.seq))

    await pty.handlers['pty.kill']({ sessionId })
    await waitFor(() => ended !== null)
    expect(ended).toBe('exit')
    pty.disposeAll()
  })

  it('reports an unknown session as absent, and has nothing to watch', () => {
    const { ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    expect(pty.direct.attach('nope', -1)).toEqual({
      exists: false,
      size: null,
      buffer: { chunks: [], prelude: '', currentSeq: -1 }
    })
    expect(
      pty.direct.watch(
        'nope',
        () => {},
        () => {}
      )
    ).toBeNull()
  })

  it('keeps a stale-resume error off the live stream, as the hub does', async () => {
    const { ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    const sessionId = 'd-stale'
    // Paused so the watcher is in place before any output.
    await pty.handlers['pty.spawn']({
      sessionId,
      command: '/bin/sh',
      args: ['-c', 'sleep 0.3; printf "No conversation found with session ID: x\\n"; sleep 5'],
      cwd: process.cwd(),
      relay: false,
      detection: { mode: 'claude-code', resuming: true }
    })
    const got: string[] = []
    pty.direct.watch(
      sessionId,
      (c) => got.push(c.data),
      () => {}
    )
    await waitFor(() => pty.direct.attach(sessionId, -1).buffer.currentSeq >= 0)
    await waitFor(() =>
      pty.direct
        .attach(sessionId, -1)
        .buffer.chunks.map((c) => c.data)
        .join('')
        .includes('No conversation found')
    )
    expect(got.join('')).not.toContain('No conversation found')
    await pty.handlers['pty.kill']({ sessionId })
    pty.disposeAll()
  })
})

describe('direct pty input', () => {
  const inputEvents = (notifies: Array<{ method: string; params: Record<string, unknown> }>) =>
    notifies
      .filter((n) => n.method === 'computer.event' || n.method === 'event')
      .map((n) => n.params)
      .filter((p) => p.name === 'pty-input')
      .map((p) => p.payload)

  it('writes to the process and reports submit and Esc to the hub — never plain typing', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    const sessionId = 'd-in'
    await pty.handlers['pty.spawn']({ sessionId, command: 'cat', cwd: process.cwd(), relay: false })
    const got: string[] = []
    pty.direct.watch(
      sessionId,
      (c) => got.push(c.data),
      () => {}
    )
    expect(pty.direct.write(sessionId, 'hel')).toBe(true)
    expect(pty.direct.write(sessionId, 'lo')).toBe(true)
    expect(inputEvents(notifies)).toEqual([])
    pty.direct.write(sessionId, '\r')
    await waitFor(() => got.join('').includes('hello'))
    pty.direct.write(sessionId, '\x1b')
    expect(inputEvents(notifies)).toEqual([
      { sessionId, submitted: 'hello\r', esc: false, statusCommand: false },
      { sessionId, submitted: null, esc: true, statusCommand: false }
    ])
    expect(pty.direct.write('nope', 'x')).toBe(false)
    await pty.handlers['pty.kill']({ sessionId })
    pty.disposeAll()
  })

  it('watches for the conversation id itself when /status is submitted directly', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    const sessionId = 'd-status'
    await pty.handlers['pty.spawn']({
      sessionId,
      command: 'cat',
      cwd: process.cwd(),
      relay: false,
      detection: { mode: 'claude-code', resuming: false }
    })
    pty.direct.write(sessionId, '/status\r')
    expect(inputEvents(notifies)).toEqual([
      { sessionId, submitted: '/status\r', esc: false, statusCommand: true }
    ])
    await pty.handlers['pty.kill']({ sessionId })
    pty.disposeAll()
  })
})

// R1: a client write carries an id. When a direct write is merely late, the client
// also sends it through the hub with the same id: the computer applies it once, and
// reports its input facts (submit, Esc) once.
describe('client write ids', () => {
  it('a write that arrives direct and through the hub is applied once, either order', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    const sessionId = 'w-1'
    await pty.handlers['pty.spawn']({ sessionId, command: 'cat', cwd: process.cwd(), relay: false })
    const got: string[] = []
    pty.direct.watch(
      sessionId,
      (c) => got.push(c.data),
      () => undefined
    )

    expect(pty.direct.write(sessionId, 'one\r', 'w-a')).toBe(true)
    await pty.handlers['pty.write']({ sessionId, data: 'one\r', writeId: 'w-a' })
    await pty.handlers['pty.write']({ sessionId, data: 'two\r', writeId: 'w-b' })
    expect(pty.direct.write(sessionId, 'two\r', 'w-b')).toBe(true)
    // Both echoes of each line (the tty's and cat's), then a quiet spell in which a
    // duplicate would have shown up.
    const count = (word: string) => got.join('').split(word).length - 1
    await waitFor(() => count('one') >= 2 && count('two') >= 2)
    await new Promise((r) => setTimeout(r, 500))
    const out = got.join('')
    expect(out.split('one').length - 1).toBe(2) // typed echo + cat's echo, once each
    expect(out.split('two').length - 1).toBe(2)
    // Each submit is reported to the hub once, whichever path delivered it.
    const inputs = notifies.filter((n) => n.params.name === 'pty-input')
    expect(inputs.map((n) => (n.params.payload as { submitted: string }).submitted)).toEqual([
      'one\r',
      'two\r'
    ])
    pty.disposeAll()
  })

  it('a write without an id (an older client) is applied as before', async () => {
    const { ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    const sessionId = 'w-2'
    await pty.handlers['pty.spawn']({ sessionId, command: 'cat', cwd: process.cwd(), relay: false })
    const got: string[] = []
    pty.direct.watch(
      sessionId,
      (c) => got.push(c.data),
      () => undefined
    )
    await pty.handlers['pty.write']({ sessionId, data: 'x\n' })
    await pty.handlers['pty.write']({ sessionId, data: 'x\n' })
    await waitFor(() => got.join('').split('x').length - 1 >= 4)
    pty.disposeAll()
  })
})
