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
    await waitFor(() => got.map((c) => c.data).join('').includes('alpha'))
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
    expect(pty.direct.watch('nope', () => {}, () => {})).toBeNull()
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
    pty.direct.watch(sessionId, (c) => got.push(c.data), () => {})
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
