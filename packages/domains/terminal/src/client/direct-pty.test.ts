/**
 * A terminal's direct link (docs/direct-link.md): stream output straight from the
 * computer into the same seq-ordered delivery the hub stream uses, catch up the
 * gap first, route reads and keystrokes direct while the lease lives, and go back
 * to the hub — then try again — when it ends.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetDirectPtyForTest,
  DIRECT_WRITE_DEADLINE_MS,
  directPtyFor,
  ptyBufferSince,
  ptyWrite,
  startDirectPtyLink
} from './direct-pty'

afterEach(() => {
  __resetDirectPtyForTest()
  vi.useRealTimers()
})

type Chunk = { sessionId: string; seq: number; data: string }

function fakeLease() {
  const writes: string[] = []
  let handlers:
    | {
        onStarted?: () => void
        onData: (c: Chunk) => void
        onError?: (e: unknown) => void
        onComplete?: () => void
      }
    | undefined
  const lost = new Set<(r: string) => void>()
  let released = false
  const lease = {
    computerId: 'c1',
    client: {
      pty: {
        onData: {
          subscribe: (_input: unknown, h: NonNullable<typeof handlers>) => {
            handlers = h
            return { unsubscribe: () => undefined }
          }
        },
        getBufferSince: {
          query: async ({ afterSeq }: { afterSeq: number }) => ({
            chunks: [
              { seq: afterSeq + 1, data: 'gap1' },
              { seq: afterSeq + 2, data: 'gap2' }
            ].filter((c) => c.seq <= 6),
            currentSeq: 6,
            prelude: ''
          })
        },
        write: {
          mutate: async ({ data }: { data: string; writeId?: string }) => {
            writes.push(data)
            return true
          }
        },
        attach: {
          query: async () => ({
            exists: true,
            size: null,
            buffer: { chunks: [], currentSeq: 6, prelude: '' }
          })
        }
      }
    },
    onLost: (cb: (r: string) => void) => {
      lost.add(cb)
      return () => lost.delete(cb)
    },
    release: () => {
      released = true
    }
  }
  return {
    lease,
    writes,
    start: () => handlers?.onStarted?.(),
    data: (seq: number, data: string) => handlers?.onData({ sessionId: 's1', seq, data }),
    error: () => handlers?.onError?.(new Error('FORBIDDEN')),
    lose: (r = 'closed') => {
      for (const cb of [...lost]) cb(r)
    },
    released: () => released
  }
}

function setup(leases: Array<ReturnType<typeof fakeLease> | null>) {
  let wakeCb: (() => void) | undefined
  const delivered: Array<[number, string]> = []
  let lastSeq = 4
  const acquired: number[] = []
  let connectedCb: ((id: string) => void) | undefined
  const manager = {
    acquire: async () => {
      acquired.push(Date.now())
      const next = leases.shift()
      return next ? (next.lease as never) : null
    },
    onComputerConnected: (cb: (id: string) => void) => {
      connectedCb = cb
      return () => undefined
    }
  }
  const stop = startDirectPtyLink({
    sessionId: 's1',
    manager,
    deliver: (data, seq) => {
      if (seq <= lastSeq) return
      lastSeq = seq
      delivered.push([seq, data])
    },
    lastSeq: () => lastSeq,
    wake: (cb) => {
      wakeCb = cb
      return () => undefined
    },
    retryMs: 60_000,
    lostRetryMs: 1_000
  })
  return {
    delivered,
    acquired,
    stop,
    computerConnected: () => connectedCb?.('c1'),
    wake: () => wakeCb?.()
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('startDirectPtyLink', () => {
  it('catches up the gap before live chunks, in seq order, then streams', async () => {
    const l = fakeLease()
    const { delivered } = setup([l])
    await flush()
    // A live chunk racing the catch-up waits for it.
    l.data(7, 'live7')
    l.start()
    await flush()
    l.data(8, 'live8')
    expect(delivered).toEqual([
      [5, 'gap1'],
      [6, 'gap2'],
      [7, 'live7'],
      [8, 'live8']
    ])
  })

  it('routes keystrokes and backfill direct while the lease lives, the hub otherwise', async () => {
    const l = fakeLease()
    setup([l])
    const hubWrites: string[] = []
    const hub = {
      pty: {
        write: {
          mutate: async ({ data }: { data: string }) => {
            hubWrites.push(data)
            return true
          }
        },
        getBufferSince: { query: async () => ({ chunks: [], currentSeq: 0, prelude: 'hub' }) }
      }
    }
    await ptyWrite(hub, 's1', 'before')
    await flush()
    expect(directPtyFor('s1')).not.toBeNull()
    await ptyWrite(hub, 's1', 'ls\r')
    expect(l.writes).toEqual(['ls\r'])
    expect(hubWrites).toEqual(['before'])
    expect((await ptyBufferSince(hub, 's1', 0))?.currentSeq).toBe(6)
    l.lose()
    expect(directPtyFor('s1')).toBeNull()
    await ptyWrite(hub, 's1', 'after')
    expect(hubWrites).toEqual(['before', 'after'])
  })

  it('a refused direct write (grant gone) goes to the hub instead of being lost', async () => {
    const l = fakeLease()
    l.lease.client.pty.write.mutate = async () => {
      throw Object.assign(new Error('no capability'), { data: { code: 'FORBIDDEN' } })
    }
    setup([l])
    await flush()
    const hubWrites: string[] = []
    const hub = {
      pty: {
        write: {
          mutate: async ({ data }: { data: string }) => {
            hubWrites.push(data)
            return true
          }
        },
        getBufferSince: { query: async () => null }
      }
    }
    await ptyWrite(hub, 's1', 'x')
    expect(hubWrites).toEqual(['x'])
  })

  // M2: a half-open socket never settles a write, and a socket that closed between
  // send and unlink rejects with no error code. Neither keystroke may be lost.
  const hubCapture = () => {
    const hubWrites: string[] = []
    const hub = {
      pty: {
        write: {
          mutate: async ({ data }: { data: string }) => {
            hubWrites.push(data)
            return true
          }
        },
        getBufferSince: { query: async () => null }
      }
    }
    return { hub, hubWrites }
  }

  it('a direct write past its deadline goes to the hub, and the lease is dropped', async () => {
    const l = fakeLease()
    l.lease.client.pty.write.mutate = () => new Promise<boolean>(() => undefined)
    const { acquired } = setup([l])
    await flush()
    vi.useFakeTimers()
    const { hub, hubWrites } = hubCapture()
    const written = ptyWrite(hub, 's1', 'k')
    await vi.advanceTimersByTimeAsync(DIRECT_WRITE_DEADLINE_MS + 1)
    expect(await written).toBe(true)
    expect(hubWrites).toEqual(['k'])
    // Off the half-open socket at once: later keystrokes go to the hub without waiting.
    expect(directPtyFor('s1')).toBeNull()
    expect(acquired.length).toBe(1)
  })

  // R1: the review's repro. The direct write lands but answers after the deadline;
  // the hub copy reaches the same computer. With one id on both, it is applied once.
  it('a late direct write and its hub retry carry one id: the computer applies it once', async () => {
    const applied: string[] = []
    const seen = new Set<string>()
    const computer = (data: string, writeId?: string) => {
      if (writeId !== undefined && seen.has(writeId)) return
      if (writeId !== undefined) seen.add(writeId)
      applied.push(data)
    }
    const l = fakeLease()
    l.lease.client.pty.write.mutate = (input: { data: string; writeId?: string }) =>
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          computer(input.data, input.writeId)
          resolve(true)
        }, DIRECT_WRITE_DEADLINE_MS + 1_000)
      )
    setup([l])
    await flush()
    vi.useFakeTimers()
    const hub = {
      pty: {
        write: {
          mutate: async ({ data, writeId }: { data: string; writeId?: string }) => {
            computer(data, writeId)
            return true
          }
        },
        getBufferSince: { query: async () => null }
      }
    }
    const written = ptyWrite(hub, 's1', '\r')
    await vi.advanceTimersByTimeAsync(DIRECT_WRITE_DEADLINE_MS + 2_000)
    expect(await written).toBe(true)
    expect(applied).toEqual(['\r'])
  })

  it('every write gets its own id', async () => {
    const ids: Array<string | undefined> = []
    const hub = {
      pty: {
        write: {
          mutate: async ({ writeId }: { data: string; writeId?: string }) => {
            ids.push(writeId)
            return true
          }
        },
        getBufferSince: { query: async () => null }
      }
    }
    await ptyWrite(hub, 'nolink', 'a')
    await ptyWrite(hub, 'nolink', 'b')
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(2)
  })

  it('a direct write that failed in transport (no error code) goes to the hub', async () => {
    const l = fakeLease()
    l.lease.client.pty.write.mutate = async () => {
      throw new Error('WebSocket closed')
    }
    setup([l])
    await flush()
    const { hub, hubWrites } = hubCapture()
    expect(await ptyWrite(hub, 's1', 'x')).toBe(true)
    expect(hubWrites).toEqual(['x'])
    expect(directPtyFor('s1')).toBeNull()
  })

  it('a backfill past its deadline is read from the hub', async () => {
    const l = fakeLease()
    l.lease.client.pty.getBufferSince.query = () => new Promise(() => undefined)
    setup([l])
    await flush()
    vi.useFakeTimers()
    const hub = {
      pty: {
        write: { mutate: async () => true },
        getBufferSince: { query: async () => ({ chunks: [], currentSeq: 9, prelude: 'hub' }) }
      }
    }
    const read = ptyBufferSince(hub, 's1', 0)
    await vi.advanceTimersByTimeAsync(DIRECT_WRITE_DEADLINE_MS + 1)
    expect((await read)?.currentSeq).toBe(9)
  })

  it('re-acquires after the lease is lost; at once when the computer reconnects', async () => {
    vi.useFakeTimers()
    const first = fakeLease()
    const second = fakeLease()
    const { acquired, computerConnected } = setup([first, null, second])
    await vi.advanceTimersByTimeAsync(0)
    first.lose()
    expect(first.released()).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(acquired.length).toBe(2) // relay answer: wait the long retry …
    computerConnected() // … unless the computer reconnects
    await vi.advanceTimersByTimeAsync(0)
    expect(acquired.length).toBe(3)
    expect(directPtyFor('s1')).not.toBeNull()
  })

  it('stops cleanly: releases the lease and never re-acquires', async () => {
    vi.useFakeTimers()
    const l = fakeLease()
    const { stop, acquired } = setup([l])
    await vi.advanceTimersByTimeAsync(0)
    stop()
    expect(l.released()).toBe(true)
    expect(directPtyFor('s1')).toBeNull()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(acquired.length).toBe(1)
  })
})

describe('a session that starts after its terminal mounted', () => {
  it('is retried as soon as the session wakes (it started), not after the long retry', async () => {
    vi.useFakeTimers()
    const later = fakeLease()
    const { acquired, wake } = setup([null, later])
    await vi.advanceTimersByTimeAsync(0)
    expect(acquired.length).toBe(1) // the pty did not exist yet: relay answer
    wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(acquired.length).toBe(2)
    expect(directPtyFor('s1')).not.toBeNull()
  })
})
