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

  it('answers terminal queries itself and streams the filtered chunk (buffer = stream)', async () => {
    const { notifies, child, pty } = setup(9105)
    await pty.handlers['pty.spawn']({
      sessionId: 's',
      command: 'cat',
      cwd: process.cwd(),
      detection: { mode: 'claude-code', resuming: false }
    })
    child.say('a\x1b[cb\x1b]0;title\x07c')
    expect(child.proc.write).toHaveBeenCalledWith('\x1b[?62;4;22c')
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
    await pty.handlers['pty.warmSpawn']({ warmId: 'w', command: 'cat', cwd: process.cwd() })
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
    await pty.handlers['pty.warmSpawn']({ warmId: 'w', command: 'cat', cwd: process.cwd() })
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
