/**
 * The phone's terminal reads and types over the direct link when it has one
 * (docs/direct-link.md), and over the hub otherwise.
 */
import { DIRECT_CALL_DEADLINE_MS } from '@slayzone/transport/client'
import { TerminalController } from './terminal-controller'

function hubClient() {
  const calls: Array<[string, unknown]> = []
  const rec =
    (path: string, answer: unknown) =>
    async (input: unknown): Promise<unknown> => {
      calls.push([path, input])
      return answer
    }
  const client = {
    pty: {
      attach: {
        query: rec('hub.attach', {
          exists: true,
          state: 'idle',
          buffer: { chunks: [], currentSeq: 3 }
        })
      },
      getBufferSince: { query: rec('hub.getBufferSince', { chunks: [], currentSeq: 3 }) },
      write: { mutate: rec('hub.write', true) },
      touch: { mutate: rec('hub.touch', true) }
    }
  }
  return { client, calls }
}

function directClient(opts: { refuseWrites?: boolean } = {}) {
  const calls: Array<[string, unknown]> = []
  const rec =
    (path: string, answer: unknown) =>
    async (input: unknown): Promise<unknown> => {
      calls.push([path, input])
      return answer
    }
  const client = {
    pty: {
      attach: {
        query: rec('direct.attach', {
          exists: true,
          size: null,
          buffer: { chunks: [], currentSeq: 9, prelude: '' }
        })
      },
      getBufferSince: {
        query: rec('direct.getBufferSince', { chunks: [], currentSeq: 9, prelude: '' })
      },
      write: {
        mutate: opts.refuseWrites
          ? async () => {
              throw Object.assign(new Error('no capability'), { data: { code: 'FORBIDDEN' } })
            }
          : rec('direct.write', true)
      }
    }
  }
  return { client, calls }
}

describe('TerminalController: direct link', () => {
  it('reads and writes through the hub until a direct client is set, then direct', async () => {
    const hub = hubClient()
    const direct = directClient()
    const c = new TerminalController(
      's',
      hub.client as never,
      () => undefined,
      (run) => run()
    )
    await c.write('a')
    expect(hub.calls.map(([p]) => p)).toEqual(['hub.write'])
    c.setDirect(direct.client as never)
    await c.write('b')
    await c.feed.restart()
    expect(direct.calls.map(([p]) => p)).toEqual(['direct.write', 'direct.attach'])
    c.setDirect(null)
    await c.write('c')
    expect(hub.calls.map(([p]) => p)).toEqual(['hub.write', 'hub.write'])
    c.dispose()
  })

  it('a write the computer refused (grant gone) goes to the hub', async () => {
    const hub = hubClient()
    const c = new TerminalController(
      's',
      hub.client as never,
      () => undefined,
      (run) => run()
    )
    c.setDirect(directClient({ refuseWrites: true }).client as never)
    await c.write('x')
    expect(hub.calls).toEqual([
      ['hub.write', { sessionId: 's', data: 'x', writeId: expect.any(String) }]
    ])
    c.dispose()
  })

  it('a write the computer could not take directly (session not started) goes to the hub, same id', async () => {
    const hub = hubClient()
    const direct = directClient()
    direct.client.pty.write.mutate = (async (input: unknown) => {
      direct.calls.push(['direct.write', input])
      return false
    }) as never
    const c = new TerminalController(
      's',
      hub.client as never,
      () => undefined,
      (run) => run()
    )
    c.setDirect(direct.client as never)
    await c.write('x')
    const id = (direct.calls[0]?.[1] as { writeId: string }).writeId
    expect(hub.calls).toEqual([['hub.write', { sessionId: 's', data: 'x', writeId: id }]])
    c.dispose()
  })

  // A half-open socket never settles a write; a closed one rejects with no code. The
  // keystroke goes to the hub, and the link is reported lost (back to the relay).
  it('a write with no answer in time, or a transport failure, goes to the hub and drops the link', async () => {
    jest.useFakeTimers()
    try {
      const hub = hubClient()
      const c = new TerminalController(
        's',
        hub.client as never,
        () => undefined,
        (run) => run()
      )
      let lost = 0
      const hanging = {
        pty: { write: { mutate: () => new Promise(() => undefined) } }
      }
      c.setDirect(hanging as never, () => {
        lost++
      })
      const written = c.write('k')
      await jest.advanceTimersByTimeAsync(DIRECT_CALL_DEADLINE_MS + 1)
      await written
      expect(hub.calls).toEqual([
        ['hub.write', { sessionId: 's', data: 'k', writeId: expect.any(String) }]
      ])
      expect(lost).toBe(1)

      const closed = {
        pty: {
          write: {
            mutate: async () => {
              throw new Error('WebSocket closed')
            }
          }
        }
      }
      c.setDirect(closed as never, () => {
        lost++
      })
      await c.write('j')
      expect(hub.calls.at(-1)).toEqual([
        'hub.write',
        { sessionId: 's', data: 'j', writeId: expect.any(String) }
      ])
      expect(lost).toBe(2)
      c.dispose()
    } finally {
      jest.useRealTimers()
    }
  })

  // R1: a late direct write is also sent through the hub — with the same id, so the
  // computer applies it once.
  it('a late direct write and its hub retry carry one id', async () => {
    jest.useFakeTimers()
    try {
      const ids: Array<[string, string | undefined]> = []
      const hub = {
        pty: {
          write: {
            mutate: async (input: { writeId?: string }) => {
              ids.push(['hub', input.writeId])
              return true
            }
          }
        }
      }
      const c = new TerminalController(
        's',
        hub as never,
        () => undefined,
        (run) => run()
      )
      const late = {
        pty: {
          write: {
            mutate: (input: { writeId?: string }) => {
              ids.push(['direct', input.writeId])
              return new Promise(() => undefined)
            }
          }
        }
      }
      c.setDirect(late as never, () => undefined)
      const written = c.write('\r')
      await jest.advanceTimersByTimeAsync(DIRECT_CALL_DEADLINE_MS + 1)
      await written
      expect(ids.map(([path]) => path)).toEqual(['direct', 'hub'])
      expect(typeof ids[0]?.[1]).toBe('string')
      expect(ids[1]?.[1]).toBe(ids[0]?.[1])
      c.dispose()
    } finally {
      jest.useRealTimers()
    }
  })
})
