/**
 * The phone's terminal reads and types over the direct link when it has one
 * (docs/direct-link.md), and over the hub otherwise.
 */
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
    expect(hub.calls).toEqual([['hub.write', { sessionId: 's', data: 'x' }]])
    c.dispose()
  })
})
