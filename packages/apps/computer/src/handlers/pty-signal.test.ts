/**
 * `pty.spawn` / `pty.warmAdopt` with `detection`: the computer runs output detection
 * itself and reports it as `pty-signal` events; without it (an older hub) nothing
 * changes.
 */
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type * as nodePty from 'node-pty'
import { PTY_SIGNAL_EVENT_NAME } from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from '../config'
import { createPtyHandlers } from './pty'
import type { ComputerDialer } from './types'

interface Notify {
  method: string
  params: Record<string, unknown>
}

function makeCtx() {
  const notifies: Notify[] = []
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

function talkingPty(pid: number) {
  let onData: ((data: string) => void) | undefined
  const proc = {
    pid,
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    onData: (listener: typeof onData) => {
      onData = listener
      return { dispose() {} }
    },
    onExit: () => ({ dispose() {} })
  } as unknown as nodePty.IPty
  return { proc, say: (data: string) => onData?.(data) }
}

const signals = (notifies: Notify[]) =>
  notifies
    .filter((n) => n.method === 'event' && n.params.name === PTY_SIGNAL_EVENT_NAME)
    .map((n) => n.params.payload as Record<string, unknown>)

function setup(pid: number) {
  const { ctx, notifies } = makeCtx()
  const child = talkingPty(pid)
  const pty = createPtyHandlers(ctx, undefined, {
    spawnPty: (() => child.proc) as typeof nodePty.spawn
  })
  return { notifies, child, pty }
}

describe('output detection on the computer (pty-signal)', () => {
  it('runs detection when the hub asks, acks it, and reports what the output says', async () => {
    const { notifies, child, pty } = setup(9101)
    const reply = await pty.handlers['pty.spawn']({
      sessionId: 's',
      spawnId: 'one',
      command: 'cat',
      cwd: process.cwd(),
      detection: { mode: 'codex', resuming: false }
    })
    expect(reply).toMatchObject({ pid: 9101, detection: true })
    child.say('\x1b]0;Codex working\x07 dev on http://localhost:3000')
    // Bytes still stream verbatim; the signal rides alongside.
    expect(notifies.find((n) => n.method === 'pty.data')?.params.data).toContain('localhost:3000')
    expect(signals(notifies)).toEqual([
      expect.objectContaining({
        sessionId: 's',
        spawnId: 'one',
        seq: 0,
        title: 'Codex working',
        devServerUrls: ['http://localhost:3000']
      })
    ])
    expect((pty.handlers['pty.list']({}) as { sessions: unknown[] }).sessions).toEqual([
      expect.objectContaining({
        sessionId: 's',
        detection: true,
        // What it has detected so far, for a hub reattaching after a disconnect.
        detected: expect.objectContaining({
          title: 'Codex working',
          devServerUrls: ['http://localhost:3000']
        })
      })
    ])
    pty.disposeAll()
  })

  it('lists what a restarted hub needs to adopt a session: its mode and start time', async () => {
    const { pty } = setup(9106)
    const before = Date.now()
    await pty.handlers['pty.spawn']({
      sessionId: 'task:tab',
      spawnId: 'one',
      command: 'cat',
      cwd: process.cwd(),
      detection: { mode: 'claude-code', resuming: false }
    })
    const [listed] = (pty.handlers['pty.list']({}) as { sessions: Array<Record<string, unknown>> })
      .sessions
    expect(listed).toMatchObject({ sessionId: 'task:tab', detection: true, mode: 'claude-code' })
    expect(listed?.startedAt).toBeGreaterThanOrEqual(before)
    pty.disposeAll()
  })

  it('a warm session adopted with detection lists the mode it was adopted as', async () => {
    const { pty } = setup(9107)
    await pty.handlers['pty.warmSpawn']({
      projectId: 'p1',
      warmId: 'warm',
      command: 'cat',
      cwd: process.cwd()
    })
    await pty.handlers['pty.warmAdopt']({
      warmId: 'warm',
      sessionId: 'task:task',
      taskId: 'task',
      detection: { mode: 'codex', resuming: false }
    })
    const [listed] = (pty.handlers['pty.list']({}) as { sessions: Array<Record<string, unknown>> })
      .sessions
    expect(listed).toMatchObject({ sessionId: 'task:task', mode: 'codex' })
    pty.disposeAll()
  })

  it('answers terminal queries itself and streams the filtered chunk (buffer = stream)', async () => {
    const { notifies, child, pty } = setup(9105)
    await pty.handlers['pty.spawn']({
      sessionId: 's',
      command: 'cat',
      cwd: process.cwd(),
      detection: { mode: 'claude-code', resuming: false }
    })
    child.say('a\x1b[cb\x1b]0;title\x07c')
    // In stream order behind `a` in the screen mirror, so a moment later.
    await vi.waitFor(() => expect(child.proc.write).toHaveBeenCalledWith('\x1b[?62;4;22c'))
    const streamed = notifies.find((n) => n.method === 'pty.data')?.params
    expect(streamed?.data).toBe('abc')
    const backfill = pty.handlers['pty.getBufferSince']({ sessionId: 's', seq: -1 }) as {
      frames: Array<{ seq: number; data: string }>
    }
    expect(backfill.frames).toEqual([{ seq: streamed?.seq, data: 'abc' }])
    pty.disposeAll()
  })

  it('serves replay (with prelude after eviction) and clears the only buffer', async () => {
    const { child, pty } = setup(9106)
    await pty.handlers['pty.spawn']({
      sessionId: 's',
      spawnId: 'one',
      command: 'cat',
      cwd: process.cwd(),
      detection: { mode: 'claude-code', resuming: false }
    })
    child.say('one')
    child.say('two')
    expect(pty.handlers['pty.getReplay']({ sessionId: 's', spawnId: 'one', afterSeq: 0 })).toEqual({
      chunks: [{ seq: 1, data: 'two' }],
      prelude: '',
      currentSeq: 1
    })
    expect(pty.handlers['pty.clearBuffer']({ sessionId: 's', spawnId: 'one' })).toEqual({
      clearedSeq: 1
    })
    child.say('three')
    expect(pty.handlers['pty.getReplay']({ sessionId: 's', afterSeq: -1 })).toEqual({
      chunks: [{ seq: 2, data: 'three' }],
      prelude: '',
      currentSeq: 2
    })
    // Another attempt's id: nothing (never someone else's scrollback).
    expect(pty.handlers['pty.getReplay']({ sessionId: 's', spawnId: 'x', afterSeq: -1 })).toEqual({
      chunks: [],
      prelude: '',
      currentSeq: -1
    })
    pty.disposeAll()
  })

  it('warm adopt: the seed is replay-filtered and what it said comes back as a snapshot', async () => {
    const { child, pty } = setup(9107)
    await pty.handlers['pty.warmSpawn']({
      projectId: 'p1',
      warmId: 'w',
      command: 'cat',
      cwd: process.cwd()
    })
    child.say('\x1b]0;warm title\x07ready on http://localhost:5173')
    const adopted = pty.handlers['pty.warmAdopt']({
      warmId: 'w',
      sessionId: 'real',
      detection: { mode: 'codex', resuming: false }
    }) as { data: string; detected?: { title: string | null; devServerUrls: string[] } }
    expect(adopted.data).toBe('ready on http://localhost:5173')
    expect(adopted.detected).toEqual(
      expect.objectContaining({ title: 'warm title', devServerUrls: ['http://localhost:5173'] })
    )
    pty.disposeAll()
  })

  it('relay off: output is buffered and detected but not streamed until the hub watches', async () => {
    const { notifies, child, pty } = setup(9108)
    await pty.handlers['pty.spawn']({
      sessionId: 's',
      command: 'cat',
      cwd: process.cwd(),
      detection: { mode: 'claude-code', resuming: false },
      relay: false
    })
    child.say('quiet one')
    child.say('quiet two')
    expect(notifies.filter((n) => n.method === 'pty.data')).toEqual([])
    // The first chunk always signals, so the hub knows the process started.
    expect(signals(notifies)).toEqual([expect.objectContaining({ seq: 0, firstOutput: true })])
    expect(pty.handlers['pty.relay']({ sessionId: 's', on: true })).toEqual({ seq: 1 })
    child.say('loud')
    expect(notifies.filter((n) => n.method === 'pty.data').map((n) => n.params)).toEqual([
      expect.objectContaining({ seq: 2, data: 'loud' })
    ])
    expect(pty.handlers['pty.relay']({ sessionId: 's', on: false })).toEqual({ seq: 2 })
    child.say('quiet again')
    expect(notifies.filter((n) => n.method === 'pty.data')).toHaveLength(1)
    pty.disposeAll()
  })

  it('an older hub (no `detection`) gets no signals and no ack', async () => {
    const { notifies, child, pty } = setup(9102)
    const reply = await pty.handlers['pty.spawn']({
      sessionId: 's',
      command: 'cat',
      cwd: process.cwd()
    })
    expect(reply).not.toHaveProperty('detection')
    child.say('\x1b]0;Codex working\x07 http://localhost:3000')
    expect(signals(notifies)).toEqual([])
    pty.disposeAll()
  })

  it('a write that submits /status opens the conversation-id watch', async () => {
    const { notifies, child, pty } = setup(9103)
    await pty.handlers['pty.spawn']({
      sessionId: 's',
      command: 'cat',
      cwd: process.cwd(),
      detection: { mode: 'gemini', resuming: false }
    })
    pty.handlers['pty.write']({ sessionId: 's', data: '/status\r', watchConversationId: true })
    child.say('Session ID: 0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b')
    expect(signals(notifies).at(-1)?.conversationId).toBe('0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b')
    pty.disposeAll()
  })

  it('warm adopt with `detection` starts detection under the real session id', async () => {
    const { notifies, child, pty } = setup(9104)
    await pty.handlers['pty.warmSpawn']({
      projectId: 'p1',
      warmId: 'w',
      command: 'cat',
      cwd: process.cwd()
    })
    child.say('\x1b]0;before adopt\x07')
    const adopted = pty.handlers['pty.warmAdopt']({
      warmId: 'w',
      sessionId: 'real',
      detection: { mode: 'codex', resuming: false }
    })
    expect(adopted).toMatchObject({ detection: true })
    child.say('\x1b]0;after adopt\x07')
    expect(signals(notifies).map((s) => [s.sessionId, s.title])).toEqual([['real', 'after adopt']])
    pty.disposeAll()
  })
})

// ── A restarted hub takes over the sessions its previous run left ─────────────
//
// The computer keeps every pty across a hub restart. The restarted hub's first spawn
// of such a session used to REPLACE it (SIGHUP the live agent, start a resumed one):
// a silent kill on no evidence. Asked with `adoptLive`, the computer instead hands
// the running process over to the new attempt — same process, same scrollback.

describe('adopting a live session (hub restart)', () => {
  /** A fake pty whose kill ends it at once (a replacement waits for that exit). */
  function killablePty(pid: number) {
    let onData: ((data: string) => void) | undefined
    let onExit: ((e: { exitCode: number; signal: number }) => void) | undefined
    const proc = {
      pid,
      cols: 80,
      rows: 24,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => onExit?.({ exitCode: 0, signal: 1 })),
      onData: (l: typeof onData) => {
        onData = l
        return { dispose() {} }
      },
      onExit: (l: typeof onExit) => {
        onExit = l
        return { dispose() {} }
      }
    } as unknown as nodePty.IPty
    return { proc, say: (data: string) => onData?.(data) }
  }

  function setupMany() {
    const { ctx, notifies } = makeCtx()
    const children: Array<ReturnType<typeof killablePty>> = []
    const pty = createPtyHandlers(ctx, undefined, {
      spawnPty: (() => {
        const child = killablePty(9200 + children.length)
        children.push(child)
        return child.proc
      }) as typeof nodePty.spawn
    })
    return { notifies, children, pty }
  }

  const spawnAs = (spawnId: string, mode: string, extra: Record<string, unknown> = {}) => ({
    sessionId: 'task:tab',
    taskId: 'task',
    spawnId,
    command: 'cat',
    cwd: process.cwd(),
    detection: { mode, resuming: false },
    ...extra
  })

  const listed = (pty: ReturnType<typeof setupMany>['pty']) =>
    (pty.handlers['pty.list']({}) as { sessions: Array<Record<string, unknown>> }).sessions

  it('a first spawn with adoptLive takes the running process over as the new attempt', async () => {
    const { notifies, children, pty } = setupMany()
    await pty.handlers['pty.spawn'](spawnAs('run-1', 'claude-code'))
    children[0]!.say('\x1b]0;Working\x07hello')

    const reply = await pty.handlers['pty.spawn'](
      spawnAs('run-2', 'claude-code', { adoptLive: { mode: 'claude-code' } })
    )

    // No second process: the first one is the new attempt now.
    expect(children).toHaveLength(1)
    expect(children[0]!.proc.kill).not.toHaveBeenCalled()
    expect(reply).toMatchObject({
      pid: 9200,
      detection: true,
      adopted: { seq: 0, detected: expect.objectContaining({ title: 'Working' }) }
    })
    expect(listed(pty)).toEqual([
      expect.objectContaining({ sessionId: 'task:tab', spawnId: 'run-2', adopted: true })
    ])
    // Addressed as the new attempt from here on, in both directions.
    pty.handlers['pty.write']({ sessionId: 'task:tab', spawnId: 'run-2', data: 'x' })
    expect(children[0]!.proc.write).toHaveBeenCalledWith('x')
    children[0]!.say('more')
    const data = notifies.filter((n) => n.method === 'pty.data').at(-1)?.params
    expect(data).toMatchObject({ spawnId: 'run-2', data: 'more' })
    // A re-sent copy of the same attempt (its reply was lost) is answered the same way.
    expect(
      await pty.handlers['pty.spawn'](
        spawnAs('run-2', 'claude-code', { adoptLive: { mode: 'claude-code' } })
      )
    ).toMatchObject({ pid: 9200, adopted: { seq: expect.any(Number) } })
    pty.disposeAll()
  })

  it('taking a session over never resizes it, whatever size the spawn carried', async () => {
    const { children, pty } = setupMany()
    await pty.handlers['pty.spawn'](spawnAs('run-1', 'claude-code'))
    await pty.handlers['pty.spawn'](
      spawnAs('run-2', 'claude-code', { adoptLive: { mode: 'claude-code' }, cols: 200, rows: 50 })
    )
    pty.handlers['pty.adopt']({ sessionId: 'task:tab', spawnId: 'run-3', fromSpawnId: 'run-2' })
    expect(children).toHaveLength(1)
    expect(children[0]!.proc.resize).not.toHaveBeenCalled()
    pty.disposeAll()
  })

  it('a different mode is not taken over: replaced as before, and the reply says so', async () => {
    const { children, pty } = setupMany()
    await pty.handlers['pty.spawn'](spawnAs('run-1', 'codex'))

    const reply = await pty.handlers['pty.spawn'](
      spawnAs('run-2', 'claude-code', { adoptLive: { mode: 'claude-code' } })
    )

    expect(children).toHaveLength(2)
    expect(children[0]!.proc.kill).toHaveBeenCalled()
    expect(reply).toMatchObject({
      pid: 9201,
      replacedLive: { spawnId: 'run-1', reason: 'mode-mismatch' }
    })
    expect(reply).not.toHaveProperty('adopted')
    pty.disposeAll()
  })

  it('without adoptLive a new attempt still replaces the running one (explicit restart)', async () => {
    const { children, pty } = setupMany()
    await pty.handlers['pty.spawn'](spawnAs('run-1', 'claude-code'))
    const reply = await pty.handlers['pty.spawn'](spawnAs('run-2', 'claude-code'))
    expect(children).toHaveLength(2)
    expect(reply).not.toHaveProperty('adopted')
    expect(reply).not.toHaveProperty('replacedLive')
    pty.disposeAll()
  })

  it('pty.adopt takes over exactly the listed attempt, and refuses anything else', async () => {
    const { children, pty } = setupMany()
    await pty.handlers['pty.spawn'](spawnAs('run-1', 'claude-code'))
    children[0]!.say('hi')

    expect(() =>
      pty.handlers['pty.adopt']({ sessionId: 'task:tab', spawnId: 'run-2', fromSpawnId: 'other' })
    ).toThrow(/not running/)
    expect(() =>
      pty.handlers['pty.adopt']({
        sessionId: 'task:tab',
        spawnId: 'run-2',
        fromSpawnId: 'run-1',
        mode: 'codex'
      })
    ).toThrow(/mode/)

    const reply = pty.handlers['pty.adopt']({
      sessionId: 'task:tab',
      spawnId: 'run-2',
      fromSpawnId: 'run-1',
      mode: 'claude-code',
      relay: false
    })
    expect(reply).toMatchObject({ pid: 9200, seq: 0, detection: true })
    expect(listed(pty)).toEqual([expect.objectContaining({ spawnId: 'run-2', adopted: true })])
    expect(children).toHaveLength(1)
    pty.disposeAll()
  })

  it('pty.adopt refuses a session without detection (the hub would have to parse it)', async () => {
    const { pty } = setupMany()
    await pty.handlers['pty.spawn']({
      sessionId: 'task:tab',
      spawnId: 'run-1',
      command: 'cat',
      cwd: process.cwd()
    })
    expect(() =>
      pty.handlers['pty.adopt']({ sessionId: 'task:tab', spawnId: 'run-2', fromSpawnId: 'run-1' })
    ).toThrow(/detection/)
    pty.disposeAll()
  })
})
